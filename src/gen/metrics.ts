// Harborline's metrics, as an OTel Collector would ship them to Obzly (OTLP
// names with dots turned into underscores, histograms as _bucket/_sum/_count
// with an `le` label): hostmetrics, kubeletstats and k8s_cluster for the
// cluster, docker_stats on the batch host, the services' HTTP server
// histograms, connection pools, the payments JVM, Postgres and Valkey
// receivers, the collector's own telemetry and Claude Code usage.
//
// Everything is a function of time: gauges follow the shop's load curve
// (../world traffic + a daily promotion) and the recurring payments incident;
// counters are closed-form running totals of the same curves (see
// ./metricShapes), so they are monotonic, reset when a pod restarts and cost
// the same to read over [5m] or [30d]. Registered with the metric registry on
// import.
import { hashString, hex, uuidFrom } from '../lib/rng';
import {
  BATCH_HOST,
  CLUSTER,
  NODES,
  PROJECT_ID,
  type Pod,
  STAGING_PROJECT_ID,
  WORKLOADS,
  type Workload,
  dataStart,
  deploysFor,
  podsFor,
  workloadByService,
} from '../world';
import {
  type LabelMatcher,
  type Labels,
  type MetricInfo,
  type MetricType,
  type RawSeries,
  registerSeriesProvider,
} from './metricRegistry';
import {
  type BasisSet,
  type Coef,
  DAY,
  HOUR,
  MINUTE,
  SCRAPE_MS,
  basesFor,
  combine,
  compileMatchers,
  counterValues,
  incAt,
  loadAt,
  lognormalCdf,
  lognormalMean,
  rateAt,
  unit,
  vnoise,
  wobble,
} from './metricShapes';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const RESTART_EPOCH = 4 * DAY;
/** Counters that never restart (Claude Code's are cumulative per user) start here. */
const COUNTER_EPOCH = Date.UTC(2026, 0, 1);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface Proj {
  id: string;
  prod: boolean;
  scale: number;
  /** 1 where the payments incident happens, 0 elsewhere. */
  inc: number;
  env: string;
  cluster: string;
  salt: number;
}

const PROJECTS: Record<string, Proj> = {
  [PROJECT_ID]: {
    id: PROJECT_ID,
    prod: true,
    scale: 1,
    inc: 1,
    env: 'production',
    cluster: CLUSTER,
    salt: 0,
  },
  [STAGING_PROJECT_ID]: {
    id: STAGING_PROJECT_ID,
    prod: false,
    scale: 0.06,
    inc: 0,
    env: 'staging',
    cluster: 'harborline-staging',
    salt: hashString('staging'),
  },
};

// ---------------------------------------------------------------------------
// Series definitions
// ---------------------------------------------------------------------------

interface Def {
  labels: Labels;
  start?: number;
  end?: number;
  values: (ts: number[]) => number[];
}

interface Lifetime {
  start: number;
  end: number;
}

class Sink {
  readonly defs = new Map<string, Def[]>();
  add(name: string, labels: Labels, values: (ts: number[]) => number[], life?: Lifetime) {
    let list = this.defs.get(name);
    if (!list) {
      list = [];
      this.defs.set(name, list);
    }
    list.push({
      labels: { __name__: name, ...labels },
      start: life && Number.isFinite(life.start) ? life.start : undefined,
      end: life && Number.isFinite(life.end) ? life.end : undefined,
      values,
    });
  }
}

const gauge =
  (fn: (t: number) => number) =>
  (ts: number[]): number[] =>
    ts.map(fn);

interface Family {
  prodOnly: boolean;
  metrics: MetricInfo[];
  build(ctx: Ctx, sink: Sink): void;
}

const m = (name: string, type: MetricType, help: string, unit?: string): MetricInfo => ({
  name,
  type,
  help,
  unit,
});

const histogram = (name: string, help: string, unit: string): MetricInfo[] => [
  m(`${name}_bucket`, 'histogram', help, unit),
  m(`${name}_sum`, 'histogram', help, unit),
  m(`${name}_count`, 'histogram', help, unit),
];

// ---------------------------------------------------------------------------
// Pods over time: each rollout replaces a deployment's pods.
// ---------------------------------------------------------------------------

interface PodSeg extends Lifetime {
  w: Workload;
  pod: Pod;
  index: number;
  seed: number;
}

function podSegments(w: Workload, lo: number, hi: number, salt: number): PodSeg[] {
  const seg = (pod: Pod, index: number, start: number, end: number): PodSeg => ({
    w,
    pod,
    index,
    start,
    end,
    seed: (hashString(pod.name) ^ salt) >>> 0,
  });
  if (w.kind !== 'deployment') {
    return podsFor(w, hi).map((pod, i) => seg(pod, i, -Infinity, Infinity));
  }
  const candidates = new Set<number>();
  for (const d of deploysFor(w.service, lo - RESTART_EPOCH, hi)) candidates.add(d.time);
  for (
    let b = Math.ceil((lo - RESTART_EPOCH) / RESTART_EPOCH) * RESTART_EPOCH;
    b <= hi;
    b += RESTART_EPOCH
  )
    candidates.add(b);
  const times = [...candidates].sort((a, b) => a - b);
  let start = lo - RESTART_EPOCH;
  for (const t of times) if (t <= lo) start = t;
  let current = podsFor(w, lo);
  const out: PodSeg[] = [];
  for (const t of times) {
    if (t <= lo || t > hi) continue;
    const next = podsFor(w, t + 10_001);
    if (next[0]?.name === current[0]?.name) continue;
    // A rolling update: the old pods linger 30 s after the new ones start.
    current.forEach((pod, i) => out.push(seg(pod, i, start, t + 30_000)));
    current = next;
    start = t;
  }
  current.forEach((pod, i) => out.push(seg(pod, i, start, Infinity)));
  return out;
}

/** Counter restarts for a whole service: its rollouts and a 4-day maintenance restart. */
const resetCache = new Map<string, number[]>();
function serviceResets(service: string, from: number, to: number): number[] {
  const key = `${service}|${Math.floor(from / MINUTE)}|${Math.floor(to / MINUTE)}`;
  const hit = resetCache.get(key);
  if (hit) return hit;
  const set = new Set<number>();
  for (const d of deploysFor(service, from - RESTART_EPOCH, to)) set.add(d.time);
  for (
    let b = Math.floor((from - RESTART_EPOCH) / RESTART_EPOCH) * RESTART_EPOCH;
    b <= to;
    b += RESTART_EPOCH
  )
    set.add(b);
  const out = [...set].sort((a, b) => a - b);
  if (resetCache.size > 2000) resetCache.clear();
  resetCache.set(key, out);
  return out;
}

const epochResets = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (
    let b = Math.floor((from - RESTART_EPOCH) / RESTART_EPOCH) * RESTART_EPOCH;
    b <= to;
    b += RESTART_EPOCH
  )
    out.push(b);
  return out;
};

const tsRange = (ts: number[]): [number, number] => [ts[0], ts[ts.length - 1]];

/** Restarts for a pod's counters: its start, or the 4-day epoch for long-lived pods. */
const podResets = (seg: PodSeg, ts: number[]): number[] =>
  Number.isFinite(seg.start) ? [seg.start] : epochResets(...tsRange(ts));

// ---------------------------------------------------------------------------
// Query context: the time window's pods, cached for repeated queries.
// ---------------------------------------------------------------------------

class Ctx {
  private segs = new Map<string, PodSeg[]>();
  readonly built = new Map<Family, Map<string, Def[]>>();
  constructor(
    readonly proj: Proj,
    readonly lo: number,
    readonly hi: number,
  ) {}

  pods(w: Workload): PodSeg[] {
    let list = this.segs.get(w.service);
    if (!list) {
      list = podSegments(w, this.lo, this.hi, this.proj.salt);
      this.segs.set(w.service, list);
    }
    return list;
  }

  allPods(): PodSeg[] {
    return WORKLOADS.flatMap((w) => this.pods(w));
  }

  /** Incident intensity (0..1) for this project. */
  inc(t: number): number {
    return this.proj.inc ? incAt(t) : 0;
  }
}

const ctxCache = new Map<string, Ctx>();
function ctxFor(proj: Proj, lo: number, hi: number): Ctx {
  const key = `${proj.id}|${Math.floor(lo / MINUTE)}|${Math.floor(hi / MINUTE)}`;
  let ctx = ctxCache.get(key);
  if (!ctx) {
    ctx = new Ctx(proj, lo, hi);
    if (ctxCache.size >= 24) ctxCache.delete(ctxCache.keys().next().value as string);
    ctxCache.set(key, ctx);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Resource model per workload (cores, MiB): idle + load·L + incident.
// ---------------------------------------------------------------------------

interface Res {
  idle: number;
  /** Cores across all replicas at load 1. */
  load: number;
  /** Extra cores per pod at the incident's peak. */
  inc: number;
  mem: number;
  memLoad: number;
  memInc: number;
  reqCpu: number;
  limCpu: number;
  reqMem: number;
  limMem: number;
  /** Bytes/s received across all replicas at load 1. */
  net: number;
}

const RES: Record<string, Res> = {
  'ingress-nginx': r(0.03, 0.32, 0, 170, 50, 0, 0.2, 1, 256, 512, 9e6),
  storefront: r(0.04, 0.6, 0.02, 210, 90, 10, 0.25, 1, 384, 768, 6e6),
  checkout: r(0.02, 0.2, 0.12, 70, 30, 40, 0.1, 0.5, 128, 256, 1.2e6),
  payments: r(0.06, 0.3, 0.45, 620, 140, 260, 0.5, 2, 1024, 1536, 0.8e6),
  catalog: r(0.03, 0.55, 0, 260, 80, 0, 0.25, 1, 512, 768, 4e6),
  inventory: r(0.01, 0.12, 0.02, 45, 20, 5, 0.05, 0.5, 64, 256, 0.6e6),
  search: r(0.03, 0.38, 0, 520, 60, 0, 0.25, 1, 768, 1024, 1.5e6),
  auth: r(0.01, 0.16, 0, 60, 25, 0, 0.1, 0.5, 96, 256, 1e6),
  postgres: r(0.12, 0.9, 1.1, 2300, 400, 900, 1, 3, 4096, 6144, 5e6),
  valkey: r(0.02, 0.12, 0, 340, 40, 0, 0.1, 0.5, 512, 1024, 3e6),
  'otel-collector': r(0.03, 0.36, 0, 150, 45, 0, 0.1, 0.5, 256, 512, 1.5e6),
};

function r(
  idle: number,
  load: number,
  inc: number,
  mem: number,
  memLoad: number,
  memInc: number,
  reqCpu: number,
  limCpu: number,
  reqMem: number,
  limMem: number,
  net: number,
): Res {
  return { idle, load, inc, mem, memLoad, memInc, reqCpu, limCpu, reqMem, limMem, net };
}

/** One pod's share: the Postgres replica (index 1) does a fraction of the primary's work. */
function podRes(w: Workload, index: number) {
  const res = RES[w.service];
  const replica = w.service === 'postgres' && index > 0;
  const share = w.service === 'postgres' ? (replica ? 0.3 : 1) : 1 / w.replicas;
  return {
    idle: res.idle,
    load: res.load * share,
    inc: res.inc * (replica ? 0.15 : 1),
    mem: res.mem * (replica ? 0.85 : 1),
    memLoad: res.memLoad * (replica ? 0.5 : 1),
    memInc: res.memInc * (replica ? 0.1 : 1),
    net: res.net * share,
  };
}

const podCpu = (seg: PodSeg, ctx: Ctx) => {
  const p = podRes(seg.w, seg.index);
  return (t: number) =>
    Math.max(
      0.001,
      (p.idle + p.load * loadAt(t) + p.inc * (ctx.proj.inc ? rateAt('inc', t) : 0)) *
        (1 + 1.4 * wobble(seg.seed, t)),
    );
};

const podMem = (seg: PodSeg, ctx: Ctx) => {
  const p = podRes(seg.w, seg.index);
  return (t: number) => {
    const age = Number.isFinite(seg.start) ? t - seg.start : Infinity;
    const warm = 1 - 0.22 * Math.exp(-age / (25 * MINUTE));
    const mib =
      (p.mem + p.memLoad * loadAt(t) + p.memInc * ctx.inc(t)) *
      warm *
      (1 + 0.4 * wobble(seg.seed ^ 3, t));
    return Math.round(mib * MiB);
  };
};

const podLabels = (ctx: Ctx, seg: PodSeg): Labels => ({
  k8s_cluster_name: ctx.proj.cluster,
  host_name: seg.pod.node,
  k8s_namespace_name: seg.w.namespace,
  k8s_pod_name: seg.pod.name,
  k8s_pod_uid: uuidFrom(seg.pod.name),
});

// Replica i of a workload always lands on the same node (see world.podsFor).
function nodeOf(w: Workload, i: number): string {
  if (w.kind === 'daemonset') return NODES[i % NODES.length];
  return NODES[(hashString(w.name) + i) % NODES.length];
}

/** A node's busy cores as idle + load·L + incident·traffic (static pod placement). */
const nodeModel = (() => {
  const out = new Map<
    string,
    {
      idle: number;
      load: number;
      inc: number;
      mem: number;
      memLoad: number;
      memInc: number;
      net: number;
    }
  >();
  for (const node of NODES)
    out.set(node, {
      idle: 0.18,
      load: 0.02,
      inc: 0,
      mem: 1150,
      memLoad: 40,
      memInc: 0,
      net: 0.3e6,
    });
  for (const w of WORKLOADS) {
    for (let i = 0; i < w.replicas; i++) {
      const node = out.get(nodeOf(w, i))!;
      const p = podRes(w, i);
      node.idle += p.idle;
      node.load += p.load;
      node.inc += p.inc;
      node.mem += p.mem;
      node.memLoad += p.memLoad;
      node.memInc += p.memInc;
      node.net += p.net;
    }
  }
  return out;
})();

const NODE_CORES = 8;
const NODE_MEMORY = 16 * GiB;

// ---------------------------------------------------------------------------
// Hosts: hostmetrics on the four nodes and the batch VM.
// ---------------------------------------------------------------------------

interface Host {
  name: string;
  cores: number;
  memory: number;
  k8s: boolean;
  seed: number;
  /** Busy cores = idle + load·L + inc·traffic·incident + batch·export. */
  busy: Coef;
  memUsed: (t: number) => number;
  net: number;
  disk: number;
}

/**
 * Keeps a host's busiest moment (peak load during an incident) under 90 % of
 * its cores, so the idle counter always moves forward.
 */
function capBusy(busy: Coef, cores: number): Coef {
  const peak = (busy.c ?? 0) + 1.8 * (busy.a ?? 0) + 1.5 * (busy.i ?? 0) + (busy.b ?? 0);
  return peak > 0.9 * cores ? scaleCoef(busy, (0.9 * cores) / peak) : busy;
}

const HOSTS: Host[] = [
  ...NODES.map((name): Host => {
    const model = nodeModel.get(name)!;
    const seed = hashString(name);
    return {
      name,
      cores: NODE_CORES,
      memory: NODE_MEMORY,
      k8s: true,
      seed,
      busy: capBusy({ c: model.idle, a: model.load, i: model.inc }, NODE_CORES),
      memUsed: (t) =>
        (model.mem + model.memLoad * loadAt(t) + model.memInc * incAt(t)) *
        MiB *
        (1 + 0.25 * wobble(seed ^ 9, t)),
      net: model.net,
      disk: name === nodeOf(workloadByService.get('postgres')!, 0) ? 6e6 : 1.4e6,
    };
  }),
  {
    name: BATCH_HOST,
    cores: 2,
    memory: 8 * GiB,
    k8s: false,
    seed: hashString(BATCH_HOST),
    busy: { c: 0.12, a: 0.03, b: 1.55 },
    memUsed: (t) => (1.6 + 2.9 * rateAt('batch', t)) * GiB,
    net: 0.2e6,
    disk: 0.8e6,
  },
];

const busyAt = (host: Host, ctx: Ctx, t: number): number =>
  ((host.busy.c ?? 0) +
    (host.busy.a ?? 0) * loadAt(t) +
    (host.busy.i ?? 0) * (ctx.proj.inc ? rateAt('inc', t) : 0) +
    (host.busy.b ?? 0) * rateAt('batch', t)) *
  (1 + wobble(host.seed, t));

const hostLabels = (ctx: Ctx, host: Host): Labels =>
  host.k8s
    ? {
        host_name: host.name,
        os_type: 'linux',
        k8s_cluster_name: ctx.proj.cluster,
        cloud_region: 'eu-west-1',
      }
    : { host_name: host.name, os_type: 'linux' };

const CPU_STATES: [string, number][] = [
  ['user', 0.66],
  ['system', 0.2],
  ['iowait', 0.05],
  ['softirq', 0.03],
  ['irq', 0.01],
  ['nice', 0.02],
  ['steal', 0.03],
];

const hostFamily: Family = {
  prodOnly: true,
  metrics: [
    m('system_cpu_time', 'counter', 'Seconds each logical CPU spent on each mode.', 's'),
    m('system_cpu_logical_count', 'gauge', 'Number of available logical CPUs.', '{cpu}'),
    m('system_cpu_physical_count', 'gauge', 'Number of available physical CPUs.', '{cpu}'),
    m('system_cpu_load_average_1m', 'gauge', 'Average CPU Load over 1 minute.', '{thread}'),
    m('system_cpu_load_average_5m', 'gauge', 'Average CPU Load over 5 minutes.', '{thread}'),
    m('system_cpu_load_average_15m', 'gauge', 'Average CPU Load over 15 minutes.', '{thread}'),
    m('system_memory_usage', 'gauge', 'Bytes of memory in use.', 'By'),
    m('system_memory_utilization', 'gauge', 'Percentage of memory bytes in use.', '1'),
    m('system_memory_limit', 'gauge', 'Total bytes of memory available.', 'By'),
    m('system_disk_io', 'counter', 'Disk bytes transferred.', 'By'),
    m('system_disk_operations', 'counter', 'Disk operations count.', '{operations}'),
    m('system_network_io', 'counter', 'The number of bytes transmitted and received.', 'By'),
    m('system_network_packets', 'counter', 'The number of packets transferred.', '{packets}'),
    m('system_network_errors', 'counter', 'The number of errors encountered.', '{errors}'),
    m('system_network_dropped', 'counter', 'The number of packets dropped.', '{packets}'),
    m('system_network_connections', 'gauge', 'The number of connections.', '{connections}'),
    m('system_filesystem_usage', 'gauge', 'Filesystem bytes used.', 'By'),
    m('system_filesystem_utilization', 'gauge', 'Fraction of filesystem bytes used.', '1'),
    m('system_processes_count', 'gauge', 'Total number of processes in each state.', '{processes}'),
  ],
  build(ctx, sink) {
    for (const host of HOSTS) {
      const base = hostLabels(ctx, host);
      const busy = (t: number) => busyAt(host, ctx, t);
      const resets = (ts: number[]) => epochResets(...tsRange(ts));
      const scale = 1 / host.cores;
      for (let cpu = 0; cpu < host.cores; cpu++) {
        const skew = 1 + (cpu === 0 ? 0.12 : -0.12 / (host.cores - 1));
        const seed = host.seed ^ (cpu + 1);
        for (const [state, share] of CPU_STATES) {
          const coef = scaleCoef(host.busy, share * skew * scale);
          sink.add('system_cpu_time', { ...base, cpu: `cpu${cpu}`, state }, (ts) =>
            counterValues(basesFor(seed, ts, resets(ts)), coef, false),
          );
        }
        const idle: Coef = scaleCoef(host.busy, -skew * scale);
        idle.c = (idle.c ?? 0) + 1;
        sink.add('system_cpu_time', { ...base, cpu: `cpu${cpu}`, state: 'idle' }, (ts) =>
          counterValues(basesFor(seed, ts, resets(ts)), idle, false),
        );
      }
      sink.add(
        'system_cpu_logical_count',
        base,
        gauge(() => host.cores),
      );
      sink.add(
        'system_cpu_physical_count',
        base,
        gauge(() => host.cores / 2),
      );
      const load = (lag: number, smooth: number) =>
        gauge((t) =>
          Math.max(0, busy(t - lag) * 1.15 + smooth * vnoise(host.seed ^ 0x4c, t / 40_000)),
        );
      sink.add('system_cpu_load_average_1m', base, load(30_000, 0.25));
      sink.add('system_cpu_load_average_5m', base, load(150_000, 0.1));
      sink.add('system_cpu_load_average_15m', base, load(450_000, 0.04));

      const memParts = (t: number) => {
        const used = host.memUsed(t);
        const cached = host.memory * (0.2 + 0.04 * vnoise(host.seed ^ 0x77, t / (5 * HOUR)));
        const buffered = host.memory * 0.018;
        const slabR = host.memory * 0.012;
        const slabU = host.memory * 0.008;
        const free = Math.max(0, host.memory - used - cached - buffered - slabR - slabU);
        return { used, cached, buffered, slab_reclaimable: slabR, slab_unreclaimable: slabU, free };
      };
      for (const state of [
        'used',
        'free',
        'cached',
        'buffered',
        'slab_reclaimable',
        'slab_unreclaimable',
      ] as const) {
        sink.add(
          'system_memory_usage',
          { ...base, state },
          gauge((t) => Math.round(memParts(t)[state])),
        );
        sink.add(
          'system_memory_utilization',
          { ...base, state },
          gauge((t) => memParts(t)[state] / host.memory),
        );
      }
      sink.add(
        'system_memory_limit',
        base,
        gauge(() => host.memory),
      );

      const devices = host.k8s ? ['nvme0n1', 'nvme1n1'] : ['nvme0n1'];
      devices.forEach((device, d) => {
        const share = d === 0 ? 0.35 : 0.65;
        for (const [direction, k] of [
          ['read', 0.3],
          ['write', 1],
        ] as const) {
          const bytes: Coef = {
            c: host.disk * 0.25 * share * k,
            a: host.disk * share * k,
            i: host.disk * 0.6 * share * k,
            b: 12e6 * k,
          };
          const seed = host.seed ^ hashString(device + direction);
          sink.add('system_disk_io', { ...base, device, direction }, (ts) =>
            counterValues(basesFor(seed, ts, resets(ts)), bytes, true),
          );
          sink.add('system_disk_operations', { ...base, device, direction }, (ts) =>
            counterValues(basesFor(seed, ts, resets(ts)), bytes, true, 1 / 24_000),
          );
        }
      });

      for (const device of ['eth0', 'lo']) {
        const k = device === 'lo' ? 0.08 : 1;
        for (const [direction, dk] of [
          ['receive', 1],
          ['transmit', 1.25],
        ] as const) {
          const bytes: Coef = { c: 40_000 * k, a: host.net * k * dk, b: 8e6 * k * dk };
          const seed = host.seed ^ hashString(device + direction);
          const labels = { ...base, device, direction };
          sink.add('system_network_io', labels, (ts) =>
            counterValues(basesFor(seed, ts, resets(ts)), bytes, true),
          );
          sink.add('system_network_packets', labels, (ts) =>
            counterValues(basesFor(seed, ts, resets(ts)), bytes, true, 1 / 900),
          );
          sink.add('system_network_errors', labels, (ts) =>
            counterValues(basesFor(seed, ts, resets(ts)), { c: 0.0004 * k }, true),
          );
          sink.add('system_network_dropped', labels, (ts) =>
            counterValues(basesFor(seed, ts, resets(ts)), { c: 0.002 * k, a: 0.004 * k }, true),
          );
        }
      }
      const conns: [string, (t: number) => number][] = [
        ['ESTABLISHED', (t) => 140 + 260 * loadAt(t) * (host.net / 4e6)],
        ['TIME_WAIT', (t) => 60 + 520 * loadAt(t) * (host.net / 4e6)],
        ['LISTEN', () => 24],
        ['CLOSE_WAIT', (t) => 2 + 3 * (0.5 + 0.5 * vnoise(host.seed ^ 0x31, t / 300_000))],
      ];
      for (const [state, fn] of conns) {
        sink.add(
          'system_network_connections',
          { ...base, protocol: 'tcp', state },
          gauge((t) => Math.round(fn(t) * (1 + wobble(host.seed ^ hashString(state), t)))),
        );
      }
      const fsTotal = host.k8s ? 100 * GiB : 60 * GiB;
      const fsUsed = (t: number) =>
        (host.k8s ? 31 : 18) * GiB +
        // Logs and images accumulate, then the kubelet's image GC (or logrotate) trims them.
        5 * GiB * (((t + host.seed * 1000) % (3 * DAY)) / (3 * DAY)) +
        0.2 * GiB * vnoise(host.seed ^ 0x51, t / HOUR);
      const fs = { device: 'nvme0n1p1', mountpoint: '/', type: 'xfs', mode: 'rw' };
      const parts = (t: number) => {
        const used = fsUsed(t);
        const reserved = fsTotal * 0.02;
        return { used, reserved, free: fsTotal - used - reserved };
      };
      for (const state of ['used', 'free', 'reserved'] as const) {
        sink.add(
          'system_filesystem_usage',
          { ...base, ...fs, state },
          gauge((t) => Math.round(parts(t)[state])),
        );
      }
      sink.add(
        'system_filesystem_utilization',
        { ...base, ...fs },
        gauge((t) => fsUsed(t) / fsTotal),
      );
      const boot = { device: 'nvme0n1p128', mountpoint: '/boot/efi', type: 'vfat', mode: 'rw' };
      sink.add(
        'system_filesystem_usage',
        { ...base, ...boot, state: 'used' },
        gauge(() => 1_342_177),
      );
      sink.add(
        'system_filesystem_usage',
        { ...base, ...boot, state: 'free' },
        gauge(() => 9_143_567),
      );
      for (const [status, fn] of [
        ['running', (t: number) => 2 + busy(t)],
        ['sleeping', (t: number) => (host.k8s ? 240 : 130) + 20 * loadAt(t)],
        ['blocked', (t: number) => 0.4 + 0.6 * (0.5 + 0.5 * vnoise(host.seed ^ 0x99, t / 90_000))],
      ] as const) {
        sink.add(
          'system_processes_count',
          { ...base, status },
          gauge((t) => Math.round(fn(t))),
        );
      }
    }
  },
};

function scaleCoef(c: Coef, k: number): Coef {
  return {
    a: (c.a ?? 0) * k,
    i: (c.i ?? 0) * k,
    p: (c.p ?? 0) * k,
    w: (c.w ?? 0) * k,
    b: (c.b ?? 0) * k,
    c: (c.c ?? 0) * k,
  };
}

// ---------------------------------------------------------------------------
// Kubernetes nodes (kubeletstats + k8s_cluster).
// ---------------------------------------------------------------------------

const nodeFamily: Family = {
  prodOnly: true,
  metrics: [
    m(
      'k8s_node_cpu_usage',
      'gauge',
      'Total CPU usage (sum of all cores per second) averaged over the sample window.',
      '{cpu}',
    ),
    m(
      'k8s_node_cpu_time',
      'counter',
      'Total cumulative CPU time (sum of all cores) spent by the node.',
      's',
    ),
    m('k8s_node_memory_working_set', 'gauge', 'Node memory working_set.', 'By'),
    m('k8s_node_memory_available', 'gauge', 'Node memory available.', 'By'),
    m('k8s_node_memory_usage', 'gauge', 'Node memory usage.', 'By'),
    m('k8s_node_memory_rss', 'gauge', 'Node memory rss.', 'By'),
    m('k8s_node_filesystem_usage', 'gauge', 'Node filesystem usage.', 'By'),
    m('k8s_node_filesystem_capacity', 'gauge', 'Node filesystem capacity.', 'By'),
    m('k8s_node_filesystem_available', 'gauge', 'Node filesystem available.', 'By'),
    m('k8s_node_network_io', 'counter', 'Node network IO.', 'By'),
    m('k8s_node_network_errors', 'counter', 'Node network errors.', '1'),
    m(
      'k8s_node_condition_ready',
      'gauge',
      'Whether this node is Ready (1), not Ready (0) or in an unknown state (-1).',
      '1',
    ),
    m('k8s_node_allocatable_cpu', 'gauge', 'Amount of cpu allocatable on the node.', '{cpu}'),
    m('k8s_node_allocatable_memory', 'gauge', 'Amount of memory allocatable on the node.', 'By'),
  ],
  build(ctx, sink) {
    for (const host of HOSTS) {
      if (!host.k8s) continue;
      const base: Labels = {
        k8s_cluster_name: ctx.proj.cluster,
        k8s_node_name: host.name,
        host_name: host.name,
      };
      const busy = (t: number) => busyAt(host, ctx, t) - 0.08;
      const ws = (t: number) => host.memUsed(t) * 1.04;
      const resets = (ts: number[]) => epochResets(...tsRange(ts));
      sink.add('k8s_node_cpu_usage', base, gauge(busy));
      const cpuCoef: Coef = { ...host.busy, c: (host.busy.c ?? 0) - 0.08 };
      sink.add('k8s_node_cpu_time', base, (ts) =>
        counterValues(basesFor(host.seed ^ 0xc0, ts, resets(ts)), cpuCoef, false),
      );
      sink.add(
        'k8s_node_memory_working_set',
        base,
        gauge((t) => Math.round(ws(t))),
      );
      sink.add(
        'k8s_node_memory_available',
        base,
        gauge((t) => Math.round(host.memory * 0.97 - ws(t))),
      );
      sink.add(
        'k8s_node_memory_usage',
        base,
        gauge((t) => Math.round(ws(t) + host.memory * 0.21)),
      );
      sink.add(
        'k8s_node_memory_rss',
        base,
        gauge((t) => Math.round(ws(t) * 0.82)),
      );
      const capacity = 100 * GiB;
      const used = (t: number) =>
        33 * GiB + 5 * GiB * (((t + host.seed * 1000) % (3 * DAY)) / (3 * DAY));
      sink.add(
        'k8s_node_filesystem_usage',
        base,
        gauge((t) => Math.round(used(t))),
      );
      sink.add(
        'k8s_node_filesystem_capacity',
        base,
        gauge(() => capacity),
      );
      sink.add(
        'k8s_node_filesystem_available',
        base,
        gauge((t) => Math.round(capacity - used(t))),
      );
      for (const [direction, k] of [
        ['receive', 1],
        ['transmit', 1.25],
      ] as const) {
        const labels = { ...base, interface: 'eth0', direction };
        const seed = host.seed ^ hashString(direction);
        sink.add('k8s_node_network_io', labels, (ts) =>
          counterValues(basesFor(seed, ts, resets(ts)), { c: 40_000, a: host.net * k }, true),
        );
        sink.add('k8s_node_network_errors', labels, (ts) =>
          counterValues(basesFor(seed, ts, resets(ts)), { c: 0.0003 }, true),
        );
      }
      sink.add(
        'k8s_node_condition_ready',
        base,
        gauge(() => 1),
      );
      sink.add(
        'k8s_node_allocatable_cpu',
        base,
        gauge(() => NODE_CORES - 0.09),
      );
      sink.add(
        'k8s_node_allocatable_memory',
        base,
        gauge(() => 15.1 * GiB),
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Pods and containers (kubeletstats) and their objects (k8s_cluster).
// ---------------------------------------------------------------------------

/** Restart times of a pod's container: payments pods crash-loop in each incident. */
function restartTimes(ctx: Ctx, seg: PodSeg): number[] {
  if (seg.w.service === 'payments' && ctx.proj.inc && Number.isFinite(seg.start)) {
    // The release ships 90 s before the incident; liveness probes fail once the pool is gone.
    const n = 1 + (seg.seed % 2);
    return Array.from({ length: n }, (_, k) => seg.start + 90_000 + 7 * MINUTE + k * 4.5 * MINUTE);
  }
  if (Number.isFinite(seg.start) && unit(seg.seed, 7) < 0.12) {
    return [seg.start + (1 + 4 * unit(seg.seed, 8)) * HOUR];
  }
  return [];
}

const IMAGE_TAG: Record<string, string> = Object.fromEntries(
  WORKLOADS.map((w) => [w.service, w.version]),
);

const podFamily: Family = {
  prodOnly: true,
  metrics: [
    m(
      'k8s_pod_cpu_usage',
      'gauge',
      'Total CPU usage (sum of all cores per second) averaged over the sample window.',
      '{cpu}',
    ),
    m(
      'k8s_pod_cpu_time',
      'counter',
      'Total cumulative CPU time (sum of all cores) spent by the container/pod/node since its creation.',
      's',
    ),
    m('k8s_pod_memory_working_set', 'gauge', 'Pod memory working_set.', 'By'),
    m('k8s_pod_memory_usage', 'gauge', 'Pod memory usage.', 'By'),
    m('k8s_pod_memory_rss', 'gauge', 'Pod memory rss.', 'By'),
    m('k8s_pod_filesystem_usage', 'gauge', 'Pod filesystem usage.', 'By'),
    m('k8s_pod_network_io', 'counter', 'Pod network IO.', 'By'),
    m('k8s_pod_network_errors', 'counter', 'Pod network errors.', '1'),
    m(
      'k8s_pod_phase',
      'gauge',
      'Current phase of the pod (1 - Pending, 2 - Running, 3 - Succeeded, 4 - Failed, 5 - Unknown).',
      '1',
    ),
    m(
      'container_cpu_usage',
      'gauge',
      'Total CPU usage (sum of all cores per second) averaged over the sample window.',
      '{cpu}',
    ),
    m(
      'container_cpu_time',
      'counter',
      'Total cumulative CPU time (sum of all cores) spent by the container since its creation.',
      's',
    ),
    m('container_memory_working_set', 'gauge', 'Container memory working_set.', 'By'),
    m('container_memory_rss', 'gauge', 'Container memory rss.', 'By'),
    m('container_memory_usage', 'gauge', 'Container memory usage.', 'By'),
    m(
      'k8s_container_restarts',
      'gauge',
      'How many times the container has restarted in the recent past.',
      '{restart}',
    ),
    m(
      'k8s_container_ready',
      'gauge',
      'Whether a container has passed its readiness probe (0 for no, 1 for yes).',
      '1',
    ),
    m('k8s_container_cpu_request', 'gauge', 'Resource requested for the container.', '{cpu}'),
    m('k8s_container_cpu_limit', 'gauge', 'Maximum resource limit set for the container.', '{cpu}'),
    m('k8s_container_memory_request', 'gauge', 'Resource requested for the container.', 'By'),
    m('k8s_container_memory_limit', 'gauge', 'Maximum resource limit set for the container.', 'By'),
    m('k8s_volume_available', 'gauge', 'The number of available bytes in the volume.', 'By'),
    m('k8s_volume_capacity', 'gauge', 'The total capacity in bytes of the volume.', 'By'),
    m('k8s_deployment_desired', 'gauge', 'Number of desired pods in this deployment.', '{pod}'),
    m(
      'k8s_deployment_available',
      'gauge',
      'Total number of available pods (ready for at least minReadySeconds) targeted by this deployment.',
      '{pod}',
    ),
    m(
      'k8s_statefulset_desired_pods',
      'gauge',
      'Number of desired pods in the stateful set.',
      '{pod}',
    ),
    m(
      'k8s_statefulset_ready_pods',
      'gauge',
      'Number of pods created by the stateful set that have the Ready condition.',
      '{pod}',
    ),
    m(
      'k8s_daemonset_desired_scheduled_nodes',
      'gauge',
      'Number of nodes that should be running the daemon pod.',
      '{node}',
    ),
    m(
      'k8s_daemonset_ready_nodes',
      'gauge',
      'Number of nodes that should be running the daemon pod and have one or more running and ready.',
      '{node}',
    ),
  ],
  build(ctx, sink) {
    for (const seg of ctx.allPods()) {
      const res = RES[seg.w.service];
      const labels = podLabels(ctx, seg);
      const cpu = podCpu(seg, ctx);
      const mem = podMem(seg, ctx);
      const p = podRes(seg.w, seg.index);
      const life: Lifetime = seg;
      const resets = (ts: number[]) => podResets(seg, ts);
      const cpuCoef: Coef = { c: p.idle, a: p.load, i: ctx.proj.inc ? p.inc : 0 };
      sink.add('k8s_pod_cpu_usage', labels, gauge(cpu), life);
      sink.add(
        'k8s_pod_cpu_time',
        labels,
        (ts) => counterValues(basesFor(seg.seed, ts, resets(ts)), cpuCoef, false),
        life,
      );
      sink.add('k8s_pod_memory_working_set', labels, gauge(mem), life);
      sink.add(
        'k8s_pod_memory_usage',
        labels,
        gauge((t) => Math.round(mem(t) * 1.18)),
        life,
      );
      sink.add(
        'k8s_pod_memory_rss',
        labels,
        gauge((t) => Math.round(mem(t) * 0.81)),
        life,
      );
      const fsBase = seg.w.kind === 'statefulset' ? 0.4 : 0.03;
      sink.add(
        'k8s_pod_filesystem_usage',
        labels,
        gauge((t) => {
          const age = Number.isFinite(seg.start) ? t - seg.start : t % (2 * DAY);
          return Math.round((fsBase + 0.12 * ((age / (9 * HOUR)) % 1)) * GiB);
        }),
        life,
      );
      for (const [direction, k] of [
        ['receive', 1],
        ['transmit', seg.w.service === 'ingress-nginx' ? 1.9 : 1.3],
      ] as const) {
        const nl = { ...labels, interface: 'eth0', direction };
        const seed = seg.seed ^ hashString(direction);
        sink.add(
          'k8s_pod_network_io',
          nl,
          (ts) => counterValues(basesFor(seed, ts, resets(ts)), { c: 1800, a: p.net * k }, true),
          life,
        );
        sink.add(
          'k8s_pod_network_errors',
          nl,
          (ts) => counterValues(basesFor(seed, ts, resets(ts)), { c: 0.00008 }, true),
          life,
        );
      }
      sink.add(
        'k8s_pod_phase',
        labels,
        gauge(() => 2),
        life,
      );

      const cl = { ...labels, k8s_container_name: seg.w.container };
      sink.add(
        'container_cpu_usage',
        cl,
        gauge((t) => cpu(t) * 0.97),
        life,
      );
      sink.add(
        'container_cpu_time',
        cl,
        (ts) => counterValues(basesFor(seg.seed, ts, resets(ts)), cpuCoef, false, 0.97),
        life,
      );
      sink.add(
        'container_memory_working_set',
        cl,
        gauge((t) => Math.round(mem(t) * 0.97)),
        life,
      );
      sink.add(
        'container_memory_rss',
        cl,
        gauge((t) => Math.round(mem(t) * 0.79)),
        life,
      );
      sink.add(
        'container_memory_usage',
        cl,
        gauge((t) => Math.round(mem(t) * 1.15)),
        life,
      );

      const kl = {
        k8s_cluster_name: ctx.proj.cluster,
        k8s_namespace_name: seg.w.namespace,
        k8s_node_name: seg.pod.node,
        k8s_pod_name: seg.pod.name,
        k8s_pod_uid: uuidFrom(seg.pod.name),
        k8s_container_name: seg.w.container,
        container_image_name: `registry.example.com/harborline/${seg.w.container}`,
        container_image_tag: IMAGE_TAG[seg.w.service],
      };
      const restarts = restartTimes(ctx, seg);
      const baseRestarts = Number.isFinite(seg.start) ? 0 : seg.seed % 3;
      sink.add(
        'k8s_container_restarts',
        kl,
        gauge((t) => baseRestarts + restarts.filter((x) => x <= t).length),
        life,
      );
      sink.add(
        'k8s_container_ready',
        kl,
        gauge((t) => (restarts.some((x) => t >= x && t < x + 75_000) ? 0 : 1)),
        life,
      );
      sink.add(
        'k8s_container_cpu_request',
        kl,
        gauge(() => res.reqCpu),
        life,
      );
      sink.add(
        'k8s_container_cpu_limit',
        kl,
        gauge(() => res.limCpu),
        life,
      );
      sink.add(
        'k8s_container_memory_request',
        kl,
        gauge(() => res.reqMem * MiB),
        life,
      );
      sink.add(
        'k8s_container_memory_limit',
        kl,
        gauge(() => res.limMem * MiB),
        life,
      );

      if (seg.w.kind === 'statefulset') {
        const capacity = (seg.w.service === 'postgres' ? 200 : 20) * GiB;
        const used =
          seg.w.service === 'postgres'
            ? (t: number) =>
                (61 + 0.35 * ((t - COUNTER_EPOCH) / DAY) + 0.8 * vnoise(seg.seed, t / (6 * HOUR))) *
                GiB
            : (t: number) => (2.4 + 0.3 * vnoise(seg.seed, t / (6 * HOUR))) * GiB;
        const vl = {
          ...labels,
          k8s_volume_name: 'data',
          k8s_volume_type: 'persistentVolumeClaim',
          k8s_persistentvolumeclaim_name: `data-${seg.pod.name}`,
        };
        sink.add(
          'k8s_volume_available',
          vl,
          gauge((t) => Math.round(capacity - used(t))),
          life,
        );
        sink.add(
          'k8s_volume_capacity',
          vl,
          gauge(() => capacity),
          life,
        );
      }
    }

    for (const w of WORKLOADS) {
      const base = { k8s_cluster_name: ctx.proj.cluster, k8s_namespace_name: w.namespace };
      if (w.kind === 'deployment') {
        const labels = {
          ...base,
          k8s_deployment_name: w.name,
          k8s_deployment_uid: uuidFrom(`deploy/${w.name}`),
        };
        sink.add(
          'k8s_deployment_desired',
          labels,
          gauge(() => w.replicas),
        );
        sink.add(
          'k8s_deployment_available',
          labels,
          gauge((t) => {
            // A pod is unavailable for a minute while a rollout replaces it.
            const deploys = deploysFor(w.service, t - 2 * MINUTE, t);
            return w.replicas - (deploys.length ? 1 : 0);
          }),
        );
      } else if (w.kind === 'statefulset') {
        const labels = {
          ...base,
          k8s_statefulset_name: w.name,
          k8s_statefulset_uid: uuidFrom(`sts/${w.name}`),
        };
        sink.add(
          'k8s_statefulset_desired_pods',
          labels,
          gauge(() => w.replicas),
        );
        sink.add(
          'k8s_statefulset_ready_pods',
          labels,
          gauge(() => w.replicas),
        );
      } else {
        const labels = {
          ...base,
          k8s_daemonset_name: w.name,
          k8s_daemonset_uid: uuidFrom(`ds/${w.name}`),
        };
        sink.add(
          'k8s_daemonset_desired_scheduled_nodes',
          labels,
          gauge(() => w.replicas),
        );
        sink.add(
          'k8s_daemonset_ready_nodes',
          labels,
          gauge(() => w.replicas),
        );
      }
    }
  },
};

// ---------------------------------------------------------------------------
// HTTP servers: request duration histograms per route and status code.
// ---------------------------------------------------------------------------

interface StatusSpec {
  code: string;
  base: number;
  inc?: number;
}

interface RouteSpec {
  method: string;
  route: string;
  share: number;
  p50: number;
  ok?: string;
  errors?: StatusSpec[];
  /** Share of successful requests that crawl at the incident's peak, and how slowly. */
  slow?: { weight: number; p50: number };
}

interface HttpSpec {
  service: string;
  rps: number;
  routes: RouteSpec[];
}

const HTTP: HttpSpec[] = [
  {
    service: 'storefront',
    rps: 85,
    routes: [
      {
        method: 'GET',
        route: '/',
        share: 0.26,
        p50: 0.042,
        errors: [{ code: '500', base: 0.0004 }],
      },
      {
        method: 'GET',
        route: '/products/{id}',
        share: 0.37,
        p50: 0.058,
        errors: [
          { code: '404', base: 0.012 },
          { code: '500', base: 0.0004 },
        ],
      },
      {
        method: 'GET',
        route: '/search',
        share: 0.12,
        p50: 0.11,
        errors: [{ code: '500', base: 0.0006 }],
      },
      { method: 'GET', route: '/cart', share: 0.1, p50: 0.034 },
      {
        method: 'POST',
        route: '/cart/items',
        share: 0.075,
        p50: 0.048,
        ok: '201',
        errors: [
          { code: '400', base: 0.005 },
          { code: '500', base: 0.0005 },
        ],
      },
      {
        method: 'POST',
        route: '/checkout',
        share: 0.035,
        p50: 0.42,
        slow: { weight: 0.45, p50: 4.8 },
        errors: [
          { code: '422', base: 0.01 },
          { code: '502', base: 0.001, inc: 0.24 },
        ],
      },
      {
        method: 'GET',
        route: '/account',
        share: 0.04,
        p50: 0.05,
        errors: [{ code: '401', base: 0.03 }],
      },
    ],
  },
  {
    service: 'catalog',
    rps: 140,
    routes: [
      { method: 'GET', route: '/v1/products', share: 0.36, p50: 0.014 },
      {
        method: 'GET',
        route: '/v1/products/{id}',
        share: 0.5,
        p50: 0.009,
        errors: [{ code: '404', base: 0.008 }],
      },
      { method: 'GET', route: '/v1/categories', share: 0.14, p50: 0.006 },
    ],
  },
  {
    service: 'search',
    rps: 30,
    routes: [
      {
        method: 'GET',
        route: '/v1/search',
        share: 0.88,
        p50: 0.032,
        errors: [{ code: '500', base: 0.0008 }],
      },
      { method: 'GET', route: '/v1/suggest', share: 0.12, p50: 0.011 },
    ],
  },
  {
    service: 'checkout',
    rps: 6,
    routes: [
      {
        method: 'POST',
        route: '/api/checkout',
        share: 0.55,
        p50: 0.21,
        ok: '201',
        slow: { weight: 0.5, p50: 4.4 },
        errors: [
          { code: '409', base: 0.006 },
          { code: '500', base: 0.0015, inc: 0.26 },
        ],
      },
      {
        method: 'GET',
        route: '/api/checkout/{id}',
        share: 0.3,
        p50: 0.018,
        errors: [{ code: '404', base: 0.01 }],
      },
      {
        method: 'POST',
        route: '/api/checkout/{id}/confirm',
        share: 0.15,
        p50: 0.16,
        slow: { weight: 0.4, p50: 3.9 },
        errors: [{ code: '500', base: 0.001, inc: 0.2 }],
      },
    ],
  },
  {
    service: 'payments',
    rps: 4.2,
    routes: [
      {
        method: 'POST',
        route: '/v1/charges',
        share: 0.7,
        p50: 0.19,
        ok: '201',
        slow: { weight: 0.5, p50: 4.1 },
        errors: [
          { code: '402', base: 0.025 },
          { code: '503', base: 0.0008, inc: 0.31 },
        ],
      },
      {
        method: 'POST',
        route: '/v1/refunds',
        share: 0.05,
        p50: 0.23,
        ok: '201',
        errors: [{ code: '503', base: 0.0005, inc: 0.2 }],
      },
      {
        method: 'GET',
        route: '/v1/charges/{id}',
        share: 0.25,
        p50: 0.012,
        slow: { weight: 0.35, p50: 2.6 },
        errors: [
          { code: '404', base: 0.004 },
          { code: '503', base: 0.0004, inc: 0.12 },
        ],
      },
    ],
  },
  {
    service: 'inventory',
    rps: 12,
    routes: [
      { method: 'GET', route: '/v1/stock/{sku}', share: 0.7, p50: 0.006 },
      {
        method: 'POST',
        route: '/v1/reservations',
        share: 0.3,
        p50: 0.018,
        ok: '201',
        errors: [{ code: '409', base: 0.015 }],
      },
    ],
  },
  {
    service: 'auth',
    rps: 40,
    routes: [
      {
        method: 'POST',
        route: '/oauth/token',
        share: 0.32,
        p50: 0.065,
        errors: [{ code: '401', base: 0.02 }],
      },
      { method: 'GET', route: '/userinfo', share: 0.58, p50: 0.008 },
      {
        method: 'POST',
        route: '/login',
        share: 0.1,
        p50: 0.09,
        errors: [
          { code: '401', base: 0.06 },
          { code: '429', base: 0.002 },
        ],
      },
    ],
  },
];

export const HTTP_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.075,
  0.1,
  0.25,
  0.5,
  0.75,
  1,
  2.5,
  5,
  7.5,
  10,
  Infinity,
];
const leLabel = (le: number) => (le === Infinity ? '+Inf' : String(le));

/** Busy-hour share of requests that queue (peak = traffic above 1.1). */
const BUSY_SHARE = 0.3;
const SIGMA = 0.55;

interface Mode {
  coef: Coef;
  p50: number;
  sigma: number;
}

/** The request modes (rate coefficients x latency) of one route + status. */
function statusModes(route: RouteSpec, status: StatusSpec | undefined, inc: number): Mode[] {
  const errors = route.errors ?? [];
  if (!status) {
    // Success: what's left after errors; some crawl in the incident, some queue at peak.
    const share = 1 - errors.reduce((s, e) => s + e.base, 0);
    const incErrors = inc * errors.reduce((s, e) => s + (e.inc ?? 0), 0);
    const slow = route.slow ? inc * route.slow.weight * share : 0;
    const modes: Mode[] = [
      {
        coef: { a: share, i: -(incErrors + slow), p: -BUSY_SHARE * share },
        p50: route.p50,
        sigma: SIGMA,
      },
      { coef: { p: BUSY_SHARE * share }, p50: route.p50 * 1.7, sigma: SIGMA },
    ];
    if (route.slow && slow > 0) {
      modes.push({ coef: { i: slow }, p50: route.slow.p50, sigma: 0.25 });
    }
    return modes;
  }
  const server = status.code.startsWith('5');
  const modes: Mode[] = [
    {
      coef: { a: status.base },
      p50: server ? route.p50 * 2.5 : route.p50 * 0.6,
      sigma: server ? 0.7 : 0.5,
    },
  ];
  if (status.inc && inc) {
    modes.push({
      coef: { i: status.inc * inc },
      // Requests that waited out the 5 s pool timeout.
      p50: route.slow ? 5.05 : route.p50 * 6,
      sigma: route.slow ? 0.03 : 0.35,
    });
  }
  return modes;
}

/** Per-sample increments since the last restart, one array per mode. */
function modeDiffs(set: BasisSet, modes: Mode[], rate: number): Float64Array[] {
  return modes.map((mode) => {
    const out = new Float64Array(set.at.length);
    for (let j = 0; j < out.length; j++) {
      out[j] = Math.max(
        0,
        rate * (combine(mode.coef, set.at[j]) - combine(mode.coef, set.reset[j])),
      );
    }
    return out;
  });
}

const httpFamily: Family = {
  prodOnly: false,
  metrics: [
    ...histogram('http_server_request_duration', 'Duration of HTTP server requests.', 's'),
    m(
      'http_server_active_requests',
      'gauge',
      'Number of active HTTP server requests.',
      '{request}',
    ),
  ],
  build(ctx, sink) {
    for (const spec of HTTP) {
      const w = workloadByService.get(spec.service)!;
      const seed = hashString(`http/${spec.service}`) ^ ctx.proj.salt;
      const base: Labels = {
        service_name: spec.service,
        service_version: w.version,
        k8s_cluster_name: ctx.proj.cluster,
        k8s_namespace_name: w.namespace,
        deployment_environment_name: ctx.proj.env,
      };
      const bases = (ts: number[]) =>
        basesFor(seed, ts, serviceResets(spec.service, ...tsRange(ts)));
      for (const route of spec.routes) {
        const rate = spec.rps * route.share * ctx.proj.scale;
        const statuses: (StatusSpec | undefined)[] = [undefined, ...(route.errors ?? [])];
        for (const status of statuses) {
          const code = status ? status.code : (route.ok ?? '200');
          const modes = statusModes(route, status, ctx.proj.inc);
          const cdfs = modes.map((mode) =>
            HTTP_BUCKETS.map((le) => lognormalCdf(le, mode.p50, mode.sigma)),
          );
          const means = modes.map((mode) => lognormalMean(mode.p50, mode.sigma));
          let memoTs: number[] | undefined;
          let memo: Float64Array[] = [];
          const diffs = (ts: number[]) => {
            if (memoTs !== ts) {
              memo = modeDiffs(bases(ts), modes, rate);
              memoTs = ts;
            }
            return memo;
          };
          const labels: Labels = {
            ...base,
            http_request_method: route.method,
            http_route: route.route,
            http_response_status_code: code,
          };
          HTTP_BUCKETS.forEach((le, b) => {
            sink.add(
              'http_server_request_duration_bucket',
              { ...labels, le: leLabel(le) },
              (ts) => {
                const d = diffs(ts);
                return ts.map((_, j) => {
                  let v = 0;
                  for (let k = 0; k < d.length; k++) v += cdfs[k][b] * d[k][j];
                  return Math.floor(v + 1e-9);
                });
              },
            );
          });
          sink.add('http_server_request_duration_count', labels, (ts) => {
            const d = diffs(ts);
            return ts.map((_, j) => {
              let v = 0;
              for (let k = 0; k < d.length; k++) v += d[k][j];
              return Math.floor(v + 1e-9);
            });
          });
          sink.add('http_server_request_duration_sum', labels, (ts) => {
            const d = diffs(ts);
            return ts.map((_, j) => {
              let v = 0;
              for (let k = 0; k < d.length; k++) v += means[k] * d[k][j];
              return v;
            });
          });
        }
      }
      // Little's law: in-flight requests = arrival rate x time in system.
      for (const method of [...new Set(spec.routes.map((route) => route.method))]) {
        const routes = spec.routes.filter((route) => route.method === method);
        sink.add(
          'http_server_active_requests',
          { ...base, http_request_method: method },
          gauge((t) => {
            const load = loadAt(t);
            const inc = ctx.inc(t);
            let active = 0;
            for (const route of routes) {
              const rps = spec.rps * route.share * ctx.proj.scale;
              const slow = route.slow ? inc * route.slow.weight * route.slow.p50 * 1.8 : 0;
              active += rps * load * (lognormalMean(route.p50, SIGMA) + slow);
            }
            return Math.max(0, Math.round(active * (1 + 2 * wobble(seed ^ hashString(method), t))));
          }),
        );
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Database connection pools (OTel db.client.connection.*), per pod.
// ---------------------------------------------------------------------------

interface PoolSpec {
  service: string;
  pool: string;
  max: number;
  base: number;
  load: number;
  /** Extra connections held at the incident's peak (capped at max). */
  inc: number;
  pending: number;
  timeouts: number;
  /** Acquisitions per second across the service at load 1. */
  acquires: number;
  waitInc: number;
}

const POOLS: PoolSpec[] = [
  {
    service: 'payments',
    pool: 'HikariPool-1',
    max: 20,
    base: 1.5,
    load: 2.4,
    inc: 30,
    pending: 34,
    timeouts: 2.4,
    acquires: 26,
    waitInc: 4.2,
  },
  {
    service: 'checkout',
    pool: 'pgxpool',
    max: 25,
    base: 1,
    load: 2,
    inc: 7,
    pending: 0,
    timeouts: 0,
    acquires: 14,
    waitInc: 0.02,
  },
  {
    service: 'catalog',
    pool: 'sqlalchemy',
    max: 15,
    base: 2,
    load: 3.5,
    inc: 0,
    pending: 0,
    timeouts: 0,
    acquires: 160,
    waitInc: 0,
  },
  {
    service: 'inventory',
    pool: 'pgxpool',
    max: 20,
    base: 0.5,
    load: 1.2,
    inc: 0.5,
    pending: 0,
    timeouts: 0,
    acquires: 18,
    waitInc: 0,
  },
  {
    service: 'auth',
    pool: 'pgxpool',
    max: 20,
    base: 0.8,
    load: 1.6,
    inc: 0,
    pending: 0,
    timeouts: 0,
    acquires: 30,
    waitInc: 0,
  },
];

const WAIT_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, Infinity];

const poolFamily: Family = {
  prodOnly: false,
  metrics: [
    m(
      'db_client_connection_count',
      'gauge',
      'The number of connections that are currently in state described by the state attribute.',
      '{connection}',
    ),
    m(
      'db_client_connection_max',
      'gauge',
      'The maximum number of open connections allowed.',
      '{connection}',
    ),
    m(
      'db_client_connection_idle_min',
      'gauge',
      'The minimum number of idle open connections allowed.',
      '{connection}',
    ),
    m(
      'db_client_connection_pending_requests',
      'gauge',
      'The number of current pending requests for an open connection.',
      '{request}',
    ),
    m(
      'db_client_connection_timeouts',
      'counter',
      'The number of connection timeouts that have occurred trying to obtain a connection from the pool.',
      '{timeout}',
    ),
    ...histogram(
      'db_client_connection_wait_time',
      'The time it took to obtain an open connection from the pool.',
      's',
    ),
  ],
  build(ctx, sink) {
    for (const spec of POOLS) {
      const w = workloadByService.get(spec.service)!;
      for (const seg of ctx.pods(w)) {
        const labels: Labels = {
          service_name: spec.service,
          k8s_cluster_name: ctx.proj.cluster,
          k8s_namespace_name: w.namespace,
          k8s_pod_name: seg.pod.name,
          deployment_environment_name: ctx.proj.env,
          db_system_name: 'postgresql',
          db_client_connection_pool_name: spec.pool,
        };
        const life: Lifetime = seg;
        const scale = ctx.proj.scale;
        const used = (t: number) =>
          Math.min(
            spec.max,
            Math.max(
              0,
              Math.round(
                (spec.base + spec.load * loadAt(t) * Math.max(scale, 0.2)) *
                  (1 + 2.5 * wobble(seg.seed ^ 0x61, t)) +
                  spec.inc * ctx.inc(t),
              ),
            ),
          );
        const idle = (t: number) => Math.max(0, Math.min(spec.max - used(t), 4));
        sink.add(
          'db_client_connection_count',
          { ...labels, db_client_connection_state: 'used' },
          gauge(used),
          life,
        );
        sink.add(
          'db_client_connection_count',
          { ...labels, db_client_connection_state: 'idle' },
          gauge(idle),
          life,
        );
        sink.add(
          'db_client_connection_max',
          labels,
          gauge(() => spec.max),
          life,
        );
        sink.add(
          'db_client_connection_idle_min',
          labels,
          gauge(() => 4),
          life,
        );
        sink.add(
          'db_client_connection_pending_requests',
          labels,
          gauge((t) => {
            const inc = ctx.inc(t);
            if (!inc || !spec.pending) return 0;
            return Math.max(
              0,
              Math.round(
                spec.pending *
                  inc *
                  (0.8 + 0.4 * (0.5 + 0.5 * vnoise(seg.seed ^ 0x62, t / 40_000))),
              ),
            );
          }),
          life,
        );
        const resets = (ts: number[]) => podResets(seg, ts);
        const seed = seg.seed ^ 0x63;
        const timeouts: Coef = { i: (spec.timeouts * ctx.proj.inc) / w.replicas };
        sink.add(
          'db_client_connection_timeouts',
          labels,
          (ts) => counterValues(basesFor(seed, ts, resets(ts)), timeouts, true),
          life,
        );

        const acquires = (spec.acquires * scale) / w.replicas;
        const modes: Mode[] = [{ coef: { a: 1 }, p50: 0.0004, sigma: 0.9 }];
        if (spec.waitInc && ctx.proj.inc)
          modes.push({ coef: { i: 0.6 }, p50: spec.waitInc, sigma: 0.4 });
        const cdfs = modes.map((mode) =>
          WAIT_BUCKETS.map((le) => lognormalCdf(le, mode.p50, mode.sigma)),
        );
        const means = modes.map((mode) => lognormalMean(mode.p50, mode.sigma));
        let memoTs: number[] | undefined;
        let memo: Float64Array[] = [];
        const diffs = (ts: number[]) => {
          if (memoTs !== ts) {
            memo = modeDiffs(basesFor(seed, ts, resets(ts)), modes, acquires);
            memoTs = ts;
          }
          return memo;
        };
        const fold = (weights: number[], integer: boolean) => (ts: number[]) => {
          const d = diffs(ts);
          return ts.map((_, j) => {
            let v = 0;
            for (let k = 0; k < d.length; k++) v += weights[k] * d[k][j];
            return integer ? Math.floor(v + 1e-9) : v;
          });
        };
        WAIT_BUCKETS.forEach((le, b) => {
          sink.add(
            'db_client_connection_wait_time_bucket',
            { ...labels, le: leLabel(le) },
            fold(
              cdfs.map((c) => c[b]),
              true,
            ),
            life,
          );
        });
        sink.add(
          'db_client_connection_wait_time_count',
          labels,
          fold(
            modes.map(() => 1),
            true,
          ),
          life,
        );
        sink.add('db_client_connection_wait_time_sum', labels, fold(means, false), life);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Postgres (postgresql receiver) and Valkey (redis receiver).
// ---------------------------------------------------------------------------

const DATABASES: {
  name: string;
  backends: number;
  backendsLoad: number;
  commits: number;
  size: number;
  growth: number;
}[] = [
  { name: 'shop', backends: 22, backendsLoad: 14, commits: 180, size: 38, growth: 0.21 },
  { name: 'payments', backends: 14, backendsLoad: 8, commits: 30, size: 12, growth: 0.06 },
  { name: 'identity', backends: 8, backendsLoad: 4, commits: 60, size: 3.1, growth: 0.012 },
  { name: 'inventory', backends: 9, backendsLoad: 5, commits: 45, size: 5.4, growth: 0.02 },
];
const PG_MAX = 200;

const postgresFamily: Family = {
  prodOnly: false,
  metrics: [
    m('postgresql_backends', 'gauge', 'The number of backends.', '1'),
    m(
      'postgresql_connection_max',
      'gauge',
      'Configured maximum number of client connections allowed',
      '{connections}',
    ),
    m('postgresql_commits', 'counter', 'The number of commits.', '1'),
    m('postgresql_rollbacks', 'counter', 'The number of rollbacks.', '1'),
    m('postgresql_db_size', 'gauge', 'The database disk usage.', 'By'),
    m('postgresql_operations', 'counter', 'The number of db row operations.', '1'),
    m('postgresql_blocks_read', 'counter', 'The number of blocks read.', '1'),
    m('postgresql_deadlocks', 'counter', 'The number of deadlocks.', '{deadlock}'),
    m('postgresql_database_count', 'gauge', 'Number of user databases.', '{databases}'),
    m(
      'postgresql_wal_lag',
      'gauge',
      'Time between flushing recent WAL locally and receiving notification that the standby server has completed an operation with it.',
      's',
    ),
  ],
  build(ctx, sink) {
    const base: Labels = {
      k8s_cluster_name: ctx.proj.cluster,
      k8s_namespace_name: 'data',
      service_name: 'postgres',
      server_address: 'postgres-0.postgres.data.svc.cluster.local',
    };
    const scale = Math.max(ctx.proj.scale, 0.15);
    const resets = (ts: number[]) => epochResets(...tsRange(ts));
    const others = (t: number, except: string) =>
      DATABASES.filter((db) => db.name !== except).reduce(
        (s, db) => s + db.backends + db.backendsLoad * loadAt(t) * scale,
        0,
      );
    for (const db of DATABASES) {
      const labels = { ...base, postgresql_database_name: db.name };
      const seed = hashString(`pg/${db.name}`) ^ ctx.proj.salt;
      sink.add(
        'postgresql_backends',
        labels,
        gauge((t) => {
          let n = (db.backends + db.backendsLoad * loadAt(t) * scale) * (1 + 1.5 * wobble(seed, t));
          if (db.name === 'payments') {
            // The release's pool leak: payments opens connections until the server says no.
            n += 165 * ctx.inc(t);
            n = Math.min(n, PG_MAX - 3 - others(t, db.name));
          }
          return Math.max(1, Math.round(n));
        }),
      );
      const commits: Coef = { a: db.commits * scale, c: 0.4 };
      sink.add('postgresql_commits', labels, (ts) =>
        counterValues(basesFor(seed, ts, resets(ts)), commits, true),
      );
      const rollbacks: Coef = {
        a: db.commits * scale * 0.002,
        i: db.name === 'payments' ? 9 * ctx.proj.inc : 0,
      };
      sink.add('postgresql_rollbacks', labels, (ts) =>
        counterValues(basesFor(seed ^ 1, ts, resets(ts)), rollbacks, true),
      );
      sink.add(
        'postgresql_db_size',
        labels,
        gauge((t) => Math.round((db.size + db.growth * ((t - COUNTER_EPOCH) / DAY)) * GiB)),
      );
      for (const [operation, k] of [
        ['ins', 0.8],
        ['upd', 1.3],
        ['del', 0.15],
        ['hot_upd', 0.9],
      ] as const) {
        sink.add('postgresql_operations', { ...labels, operation }, (ts) =>
          counterValues(
            basesFor(seed ^ hashString(operation), ts, resets(ts)),
            { a: db.commits * scale * k },
            true,
          ),
        );
      }
      for (const [source, k] of [
        ['heap_read', 4],
        ['heap_hit', 160],
        ['idx_read', 2.5],
        ['idx_hit', 240],
        ['toast_hit', 6],
      ] as const) {
        sink.add('postgresql_blocks_read', { ...labels, source }, (ts) =>
          counterValues(
            basesFor(seed ^ hashString(source), ts, resets(ts)),
            { a: db.commits * scale * k },
            true,
          ),
        );
      }
      const deadlocks: Coef = { a: 0.00002, i: db.name === 'payments' ? 0.012 * ctx.proj.inc : 0 };
      sink.add('postgresql_deadlocks', labels, (ts) =>
        counterValues(basesFor(seed ^ 2, ts, resets(ts)), deadlocks, true),
      );
    }
    sink.add(
      'postgresql_connection_max',
      base,
      gauge(() => PG_MAX),
    );
    sink.add(
      'postgresql_database_count',
      base,
      gauge(() => DATABASES.length),
    );
    for (const operation of ['write', 'flush', 'replay']) {
      const k = operation === 'write' ? 1 : operation === 'flush' ? 1.6 : 2.4;
      sink.add(
        'postgresql_wal_lag',
        { ...base, operation, replication_client: '198.51.100.24' },
        gauge((t) =>
          Math.max(
            0,
            (0.004 + 0.006 * loadAt(t) + 1.8 * ctx.inc(t)) *
              k *
              (1 + 3 * wobble(hashString(operation), t)),
          ),
        ),
      );
    }
  },
};

const valkeyFamily: Family = {
  prodOnly: false,
  metrics: [
    m(
      'redis_clients_connected',
      'gauge',
      'Number of client connections (excluding connections from replicas)',
      '{client}',
    ),
    m('redis_clients_blocked', 'gauge', 'Number of clients pending on a blocking call', '{client}'),
    m(
      'redis_memory_used',
      'gauge',
      'Total number of bytes allocated by Redis using its allocator',
      'By',
    ),
    m(
      'redis_memory_rss',
      'gauge',
      'Number of bytes that Redis allocated as seen by the operating system',
      'By',
    ),
    m('redis_memory_peak', 'gauge', 'Peak memory consumed by Redis (in bytes)', 'By'),
    m(
      'redis_commands_processed',
      'counter',
      'Total number of commands processed by the server',
      '{command}',
    ),
    m(
      'redis_keyspace_hits',
      'counter',
      'Number of successful lookup of keys in the main dictionary',
      '{hit}',
    ),
    m(
      'redis_keyspace_misses',
      'counter',
      'Number of failed lookup of keys in the main dictionary',
      '{miss}',
    ),
    m('redis_keys_evicted', 'counter', 'Number of evicted keys due to maxmemory limit', '{key}'),
    m('redis_keys_expired', 'counter', 'Total number of key expiration events', '{event}'),
    m(
      'redis_connections_received',
      'counter',
      'Total number of connections accepted by the server',
      '{connection}',
    ),
    m('redis_net_input', 'counter', 'The total number of bytes read from the network', 'By'),
    m('redis_net_output', 'counter', 'The total number of bytes written to the network', 'By'),
    m(
      'redis_cpu_time',
      'counter',
      'System CPU consumed by the Redis server in seconds since server start',
      's',
    ),
    m('redis_db_keys', 'gauge', 'Number of keyspace keys', '{key}'),
    m('redis_db_expires', 'gauge', 'Number of keyspace keys with an expiration', '{key}'),
    m('redis_uptime', 'counter', 'Number of seconds since Redis server start', 's'),
  ],
  build(ctx, sink) {
    const base: Labels = {
      k8s_cluster_name: ctx.proj.cluster,
      k8s_namespace_name: 'data',
      service_name: 'valkey',
      server_address: 'valkey-0.valkey.data.svc.cluster.local',
      server_port: '6379',
      redis_version: '8.0.1',
    };
    const scale = Math.max(ctx.proj.scale, 0.1);
    const seed = hashString('valkey') ^ ctx.proj.salt;
    const resets = (ts: number[]) => epochResets(...tsRange(ts));
    const counter = (name: string, coef: Coef, labels: Labels = base, integer = true) =>
      sink.add(name, labels, (ts) =>
        counterValues(basesFor(seed ^ hashString(name), ts, resets(ts)), coef, integer),
      );
    sink.add(
      'redis_clients_connected',
      base,
      gauge((t) => Math.round((38 + 14 * loadAt(t)) * (1 + wobble(seed, t)))),
    );
    sink.add(
      'redis_clients_blocked',
      base,
      gauge((t) => (vnoise(seed ^ 5, t / 120_000) > 0.7 ? 1 : 0)),
    );
    const memory = (t: number) =>
      (0.82 + 0.18 * loadAt(t) + 0.06 * vnoise(seed ^ 6, t / (2 * HOUR))) *
      GiB *
      (ctx.proj.prod ? 1 : 0.2);
    sink.add(
      'redis_memory_used',
      base,
      gauge((t) => Math.round(memory(t))),
    );
    sink.add(
      'redis_memory_rss',
      base,
      gauge((t) => Math.round(memory(t) * 1.12)),
    );
    sink.add(
      'redis_memory_peak',
      base,
      gauge(() => Math.round(1.24 * GiB * (ctx.proj.prod ? 1 : 0.2))),
    );
    counter('redis_commands_processed', { a: 3100 * scale, c: 2 });
    counter('redis_keyspace_hits', { a: 2350 * scale });
    counter('redis_keyspace_misses', { a: 190 * scale });
    counter('redis_keys_evicted', { a: 1.8 * scale, p: 9 * scale });
    counter('redis_keys_expired', { a: 42 * scale, c: 3 });
    counter('redis_connections_received', { a: 0.6 * scale, c: 0.05 });
    counter('redis_net_input', { a: 410_000 * scale, c: 900 });
    counter('redis_net_output', { a: 2_600_000 * scale, c: 1200 });
    counter('redis_cpu_time', { a: 0.07, c: 0.012 }, { ...base, state: 'sys' }, false);
    counter('redis_cpu_time', { a: 0.11, c: 0.02 }, { ...base, state: 'user' }, false);
    const keys = (t: number) =>
      (1_180_000 + 90_000 * vnoise(seed ^ 7, t / (8 * HOUR)) + 40_000 * loadAt(t)) *
      (ctx.proj.prod ? 1 : 0.15);
    sink.add(
      'redis_db_keys',
      { ...base, db: '0' },
      gauge((t) => Math.round(keys(t))),
    );
    sink.add(
      'redis_db_expires',
      { ...base, db: '0' },
      gauge((t) => Math.round(keys(t) * 0.71)),
    );
    sink.add('redis_uptime', base, (ts) =>
      counterValues(basesFor(0, ts, resets(ts)), { c: 1 }, true),
    );
  },
};

// ---------------------------------------------------------------------------
// The payments JVM (OTel Java agent runtime metrics), per pod.
// ---------------------------------------------------------------------------

const EDEN = 320 * MiB;
const GC_BUCKETS = [0.01, 0.1, 1, 10, Infinity];

const jvmFamily: Family = {
  prodOnly: false,
  metrics: [
    m('jvm_memory_used', 'gauge', 'Measure of memory used.', 'By'),
    m('jvm_memory_committed', 'gauge', 'Measure of memory committed.', 'By'),
    m('jvm_memory_limit', 'gauge', 'Measure of max obtainable memory.', 'By'),
    m(
      'jvm_memory_used_after_last_gc',
      'gauge',
      'Measure of memory used, as measured after the most recent garbage collection event on this pool.',
      'By',
    ),
    ...histogram('jvm_gc_duration', 'Duration of JVM garbage collection actions.', 's'),
    m('jvm_thread_count', 'gauge', 'Number of executing platform threads.', '{thread}'),
    m('jvm_class_loaded', 'counter', 'Number of classes loaded since JVM start.', '{class}'),
    m('jvm_class_count', 'gauge', 'Number of classes currently loaded.', '{class}'),
    m('jvm_cpu_time', 'counter', 'CPU time used by the process as reported by the JVM.', 's'),
    m(
      'jvm_cpu_count',
      'gauge',
      'Number of processors available to the Java virtual machine.',
      '{cpu}',
    ),
    m(
      'jvm_cpu_recent_utilization',
      'gauge',
      'Recent CPU utilization for the process as reported by the JVM.',
      '1',
    ),
  ],
  build(ctx, sink) {
    const w = workloadByService.get('payments')!;
    for (const seg of ctx.pods(w)) {
      const labels: Labels = {
        service_name: 'payments',
        service_instance_id: uuidFrom(`instance/${seg.pod.name}`),
        k8s_cluster_name: ctx.proj.cluster,
        k8s_namespace_name: w.namespace,
        k8s_pod_name: seg.pod.name,
        deployment_environment_name: ctx.proj.env,
      };
      const life: Lifetime = seg;
      const resets = (ts: number[]) => podResets(seg, ts);
      const seed = seg.seed ^ 0x7a;
      const scale = Math.max(ctx.proj.scale, 0.15);
      // Allocation (bytes/s): requests, plus retained retries in the incident.
      const alloc: Coef = {
        a: (95 * MiB * scale) / w.replicas,
        i: (60 * MiB * ctx.proj.inc) / w.replicas,
        c: 2 * MiB,
      };
      let memoTs: number[] | undefined;
      let allocated: number[] = [];
      const allocatedFor = (ts: number[]) => {
        if (memoTs !== ts) {
          allocated = counterValues(basesFor(seed, ts, resets(ts)), alloc, false);
          memoTs = ts;
        }
        return allocated;
      };
      const youngGcs = (ts: number[]) => allocatedFor(ts).map((bytes) => Math.floor(bytes / EDEN));
      const oldGen = (bytes: number, t: number) =>
        (150 + ((Math.floor(bytes / EDEN) * 0.9) % 380) + 210 * ctx.inc(t)) * MiB;
      const pools: [string, string, (ts: number[]) => number[], number][] = [
        [
          'heap',
          'G1 Eden Space',
          (ts) => allocatedFor(ts).map((bytes) => Math.round(bytes % EDEN)),
          EDEN,
        ],
        [
          'heap',
          'G1 Old Gen',
          (ts) => allocatedFor(ts).map((bytes, j) => Math.round(oldGen(bytes, ts[j]))),
          1024 * MiB,
        ],
        [
          'heap',
          'G1 Survivor Space',
          (ts) =>
            allocatedFor(ts).map((bytes) => Math.round((10 + ((bytes / EDEN) % 1) * 6) * MiB)),
          64 * MiB,
        ],
        [
          'non_heap',
          'Metaspace',
          gauge((t) => Math.round((92 + 4 * Math.min(1, (t - seg.start) / (20 * MINUTE))) * MiB)),
          256 * MiB,
        ],
        [
          'non_heap',
          "CodeHeap 'non-profiled nmethods'",
          gauge((t) => Math.round((18 + 9 * Math.min(1, (t - seg.start) / HOUR)) * MiB)),
          120 * MiB,
        ],
        ['non_heap', 'Compressed Class Space', gauge(() => Math.round(11.4 * MiB)), 1024 * MiB],
      ];
      for (const [type, pool, used, limit] of pools) {
        const pl = { ...labels, jvm_memory_type: type, jvm_memory_pool_name: pool };
        sink.add('jvm_memory_used', pl, used, life);
        sink.add(
          'jvm_memory_committed',
          pl,
          (ts) => used(ts).map((v) => Math.max(v, Math.round(limit * 0.6))),
          life,
        );
        sink.add(
          'jvm_memory_limit',
          pl,
          gauge(() => limit),
          life,
        );
        if (type === 'heap') {
          sink.add(
            'jvm_memory_used_after_last_gc',
            pl,
            pool === 'G1 Eden Space'
              ? gauge(() => 0)
              : pool === 'G1 Old Gen'
                ? used
                : gauge(() => 12 * MiB),
            life,
          );
        }
      }
      // Young collections: one per Eden-full; slower while the heap is churning in the incident.
      const young = {
        ...labels,
        jvm_gc_name: 'G1 Young Generation',
        jvm_gc_action: 'end of minor GC',
      };
      const youngCdf = GC_BUCKETS.map((le) => lognormalCdf(le, 0.006, 0.5));
      const slowCdf = GC_BUCKETS.map((le) => lognormalCdf(le, 0.028, 0.5));
      // Collections caused by the incident's extra allocation are the slow ones.
      const normalCoef: Coef = { a: (alloc.a ?? 0) / EDEN, c: (alloc.c ?? 0) / EDEN };
      const slowCoef: Coef = { i: (alloc.i ?? 0) / EDEN };
      let gcTs: number[] | undefined;
      let gcs: { normal: number[]; slow: number[] } = { normal: [], slow: [] };
      const gcSplit = (ts: number[]) => {
        if (gcTs !== ts) {
          const set = basesFor(seed, ts, resets(ts));
          gcs = {
            normal: counterValues(set, normalCoef, false),
            slow: counterValues(set, slowCoef, false),
          };
          gcTs = ts;
        }
        return gcs;
      };
      GC_BUCKETS.forEach((le, b) => {
        sink.add(
          'jvm_gc_duration_bucket',
          { ...young, le: leLabel(le) },
          (ts) => {
            const { normal, slow } = gcSplit(ts);
            const total = youngGcs(ts);
            return total.map((n, j) =>
              Math.min(n, Math.floor(normal[j] * youngCdf[b] + slow[j] * slowCdf[b] + 1e-9)),
            );
          },
          life,
        );
      });
      sink.add('jvm_gc_duration_count', young, youngGcs, life);
      sink.add(
        'jvm_gc_duration_sum',
        young,
        (ts) => {
          const { normal, slow } = gcSplit(ts);
          return normal.map(
            (n, j) => n * lognormalMean(0.006, 0.5) + slow[j] * lognormalMean(0.028, 0.5),
          );
        },
        life,
      );
      const concurrent = {
        ...labels,
        jvm_gc_name: 'G1 Concurrent GC',
        jvm_gc_action: 'end of concurrent GC cycle',
      };
      const cycles = (ts: number[]) =>
        allocatedFor(ts).map((bytes) => Math.floor((Math.floor(bytes / EDEN) * 0.9) / 380));
      const concCdf = GC_BUCKETS.map((le) => lognormalCdf(le, 0.015, 0.4));
      GC_BUCKETS.forEach((le, b) => {
        sink.add(
          'jvm_gc_duration_bucket',
          { ...concurrent, le: leLabel(le) },
          (ts) => cycles(ts).map((n) => Math.floor(n * concCdf[b] + 1e-9)),
          life,
        );
      });
      sink.add('jvm_gc_duration_count', concurrent, cycles, life);
      sink.add('jvm_gc_duration_sum', concurrent, (ts) => cycles(ts).map((n) => n * 0.016), life);

      for (const [state, daemon, fn] of [
        ['runnable', 'false', (t: number) => 9 + 9 * loadAt(t) * scale],
        ['waiting', 'false', (t: number) => 38 + 70 * ctx.inc(t)],
        ['timed_waiting', 'true', () => 24],
        ['blocked', 'false', (t: number) => 14 * ctx.inc(t)],
        ['runnable', 'true', () => 6],
      ] as const) {
        sink.add(
          'jvm_thread_count',
          { ...labels, jvm_thread_daemon: daemon, jvm_thread_state: state },
          gauge((t) =>
            Math.max(0, Math.round(fn(t) * (1 + wobble(seed ^ hashString(state + daemon), t)))),
          ),
          life,
        );
      }
      const classes = (t: number) => {
        const age = Number.isFinite(seg.start) ? Math.max(0, t - seg.start) : DAY;
        return 14_250 * (1 - Math.exp(-age / 90_000)) + 0.4 * (age / MINUTE);
      };
      sink.add(
        'jvm_class_loaded',
        labels,
        gauge((t) => Math.floor(classes(t))),
        life,
      );
      sink.add(
        'jvm_class_count',
        labels,
        gauge((t) => Math.floor(classes(t) * 0.995)),
        life,
      );
      const p = podRes(w, seg.index);
      const cpuCoef: Coef = { c: p.idle, a: p.load * scale, i: p.inc * ctx.proj.inc };
      sink.add(
        'jvm_cpu_time',
        labels,
        (ts) => counterValues(basesFor(seg.seed, ts, resets(ts)), cpuCoef, false, 0.95),
        life,
      );
      sink.add(
        'jvm_cpu_count',
        labels,
        gauge(() => 2),
        life,
      );
      const cpu = podCpu(seg, ctx);
      sink.add(
        'jvm_cpu_recent_utilization',
        labels,
        gauge((t) => Math.min(1, (cpu(t) * 0.95) / 2)),
        life,
      );
    }
  },
};

// ---------------------------------------------------------------------------
// The OTel Collector's own telemetry (one per node).
// ---------------------------------------------------------------------------

const collectorFamily: Family = {
  prodOnly: true,
  metrics: [
    m(
      'otelcol_receiver_accepted_spans',
      'counter',
      'Number of spans successfully pushed into the pipeline.',
      '{spans}',
    ),
    m(
      'otelcol_receiver_refused_spans',
      'counter',
      'Number of spans that could not be pushed into the pipeline.',
      '{spans}',
    ),
    m(
      'otelcol_receiver_accepted_metric_points',
      'counter',
      'Number of metric points successfully pushed into the pipeline.',
      '{datapoints}',
    ),
    m(
      'otelcol_receiver_refused_metric_points',
      'counter',
      'Number of metric points that could not be pushed into the pipeline.',
      '{datapoints}',
    ),
    m(
      'otelcol_receiver_accepted_log_records',
      'counter',
      'Number of log records successfully pushed into the pipeline.',
      '{records}',
    ),
    m(
      'otelcol_exporter_sent_spans',
      'counter',
      'Number of spans successfully sent to destination.',
      '{spans}',
    ),
    m(
      'otelcol_exporter_sent_metric_points',
      'counter',
      'Number of metric points successfully sent to destination.',
      '{datapoints}',
    ),
    m(
      'otelcol_exporter_sent_log_records',
      'counter',
      'Number of log record successfully sent to destination.',
      '{records}',
    ),
    m(
      'otelcol_exporter_send_failed_spans',
      'counter',
      'Number of spans in failed attempts to send to destination.',
      '{spans}',
    ),
    m(
      'otelcol_exporter_send_failed_log_records',
      'counter',
      'Number of log records in failed attempts to send to destination.',
      '{records}',
    ),
    m(
      'otelcol_exporter_queue_size',
      'gauge',
      'Current size of the retry queue (in batches).',
      '{batches}',
    ),
    m(
      'otelcol_exporter_queue_capacity',
      'gauge',
      'Fixed capacity of the retry queue (in batches).',
      '{batches}',
    ),
    m('otelcol_process_memory_rss', 'gauge', 'Total physical memory (resident set size).', 'By'),
    m('otelcol_process_cpu_seconds', 'counter', 'Total CPU user and system time in seconds.', 's'),
    m('otelcol_process_uptime', 'counter', 'Uptime of the process.', 's'),
  ],
  build(ctx, sink) {
    const w = workloadByService.get('otel-collector')!;
    for (const seg of ctx.pods(w)) {
      const labels: Labels = {
        service_name: 'otelcol-contrib',
        service_version: w.version,
        service_instance_id: uuidFrom(`otelcol/${seg.pod.name}`),
        k8s_cluster_name: ctx.proj.cluster,
        k8s_namespace_name: w.namespace,
        k8s_pod_name: seg.pod.name,
        k8s_node_name: seg.pod.node,
        host_name: seg.pod.node,
      };
      const resets = (ts: number[]) => podResets(seg, ts);
      const counter = (name: string, extra: Labels, coef: Coef, integer = true) =>
        sink.add(name, { ...labels, ...extra }, (ts) =>
          counterValues(basesFor(seg.seed ^ hashString(name), ts, resets(ts)), coef, integer),
        );
      const otlp = { receiver: 'otlp', transport: 'grpc' };
      const exporter = { exporter: 'otlphttp/obzly' };
      counter('otelcol_receiver_accepted_spans', otlp, { a: 265, c: 4 });
      counter('otelcol_receiver_refused_spans', otlp, { c: 0.0005 });
      counter('otelcol_receiver_accepted_metric_points', otlp, { a: 210, c: 880 });
      counter(
        'otelcol_receiver_accepted_metric_points',
        { receiver: 'kubeletstats', transport: '' },
        { c: 118 },
      );
      counter(
        'otelcol_receiver_accepted_metric_points',
        { receiver: 'hostmetrics', transport: '' },
        { c: 61 },
      );
      counter('otelcol_receiver_refused_metric_points', otlp, { c: 0.0002 });
      counter(
        'otelcol_receiver_accepted_log_records',
        { receiver: 'filelog', transport: '' },
        { a: 68, c: 3 },
      );
      counter('otelcol_receiver_accepted_log_records', otlp, { a: 9 });
      counter('otelcol_exporter_sent_spans', exporter, { a: 264.8, c: 4 });
      counter('otelcol_exporter_sent_metric_points', exporter, { a: 210, c: 1058 });
      counter('otelcol_exporter_sent_log_records', exporter, { a: 76.9, c: 3 });
      counter('otelcol_exporter_send_failed_spans', exporter, { a: 0.02, p: 1.2 });
      counter('otelcol_exporter_send_failed_log_records', exporter, { a: 0.01, p: 0.4 });
      sink.add(
        'otelcol_exporter_queue_size',
        { ...labels, ...exporter },
        gauge((t) =>
          Math.max(0, Math.round(1 + 2 * loadAt(t) + 3 * vnoise(seg.seed ^ 0x11, t / 45_000))),
        ),
      );
      sink.add(
        'otelcol_exporter_queue_capacity',
        { ...labels, ...exporter },
        gauge(() => 1000),
      );
      const mem = podMem(seg, ctx);
      sink.add(
        'otelcol_process_memory_rss',
        labels,
        gauge((t) => Math.round(mem(t) * 0.92)),
      );
      const p = podRes(w, seg.index);
      counter('otelcol_process_cpu_seconds', {}, { c: p.idle, a: p.load }, false);
      counter('otelcol_process_uptime', {}, { c: 1 }, false);
    }
  },
};

// ---------------------------------------------------------------------------
// docker_stats on the batch host.
// ---------------------------------------------------------------------------

const CONTAINERS = [
  {
    name: 'export-worker',
    image: 'registry.example.com/harborline/export-worker:1.8.2',
    idle: 0.02,
    batch: 1.45,
    mem: 220,
    batchMem: 2300,
    net: 0.1e6,
    batchNet: 9e6,
  },
  {
    name: 'report-api',
    image: 'registry.example.com/harborline/report-api:0.9.0',
    idle: 0.04,
    batch: 0.05,
    mem: 310,
    batchMem: 40,
    net: 0.15e6,
    batchNet: 0,
  },
  {
    name: 'otel-agent',
    image: 'registry.example.com/mirror/otelcol-contrib:0.114.0',
    idle: 0.02,
    batch: 0.06,
    mem: 120,
    batchMem: 30,
    net: 0.05e6,
    batchNet: 0.4e6,
  },
];

const dockerFamily: Family = {
  prodOnly: true,
  metrics: [
    m('container_cpu_usage_total', 'counter', 'Total CPU time consumed.', 'ns'),
    m('container_cpu_utilization', 'gauge', 'Percent of CPU used by the container.', '1'),
    m(
      'container_memory_usage_total',
      'gauge',
      'Memory usage of the container. This excludes the cache.',
      'By',
    ),
    m('container_memory_usage_limit', 'gauge', 'Memory limit of the container.', 'By'),
    m('container_memory_percent', 'gauge', 'Percentage of memory used.', '1'),
    m('container_network_io_usage_rx_bytes', 'counter', 'Bytes received by the container.', 'By'),
    m('container_network_io_usage_tx_bytes', 'counter', 'Bytes sent.', 'By'),
    m('container_network_io_usage_rx_dropped', 'counter', 'Incoming packets dropped.', '{packets}'),
    m('container_network_io_usage_tx_dropped', 'counter', 'Outgoing packets dropped.', '{packets}'),
  ],
  build(_ctx, sink) {
    for (const c of CONTAINERS) {
      const seed = hashString(`docker/${c.name}`);
      const labels: Labels = {
        container_name: c.name,
        container_id: hex(seed, 64),
        container_image_name: c.image,
        container_runtime: 'docker',
        host_name: BATCH_HOST,
      };
      const resets = (ts: number[]) => epochResets(...tsRange(ts));
      const cpu = (t: number) => (c.idle + c.batch * rateAt('batch', t)) * (1 + wobble(seed, t));
      const memBytes = (t: number) =>
        (c.mem + c.batchMem * rateAt('batch', t)) * MiB * (1 + 0.2 * wobble(seed ^ 1, t));
      const limit = 4 * GiB;
      sink.add('container_cpu_usage_total', labels, (ts) =>
        counterValues(basesFor(seed, ts, resets(ts)), { c: c.idle * 1e9, b: c.batch * 1e9 }, true),
      );
      sink.add(
        'container_cpu_utilization',
        labels,
        gauge((t) => cpu(t) * 100),
      );
      sink.add(
        'container_memory_usage_total',
        labels,
        gauge((t) => Math.round(memBytes(t))),
      );
      sink.add(
        'container_memory_usage_limit',
        labels,
        gauge(() => limit),
      );
      sink.add(
        'container_memory_percent',
        labels,
        gauge((t) => (memBytes(t) / limit) * 100),
      );
      const nl = { ...labels, interface: 'eth0' };
      const counter = (name: string, coef: Coef) =>
        sink.add(name, nl, (ts) =>
          counterValues(basesFor(seed ^ hashString(name), ts, resets(ts)), coef, true),
        );
      counter('container_network_io_usage_rx_bytes', { c: c.net, b: c.batchNet * 0.3 });
      counter('container_network_io_usage_tx_bytes', { c: c.net * 0.6, b: c.batchNet });
      counter('container_network_io_usage_rx_dropped', { c: 0.0003 });
      counter('container_network_io_usage_tx_dropped', { c: 0.0001, b: 0.02 });
    }
  },
};

// ---------------------------------------------------------------------------
// Claude Code usage (its OTel metrics exporter), the team's coding assistant.
// ---------------------------------------------------------------------------

const ENGINEERS = [
  {
    email: 'alex.rivera@harborline.example.com',
    terminal: 'vscode',
    version: '2.0.25',
    activity: 1.1,
    models: [0.7, 0.2, 0.1],
    langs: ['TypeScript', 'Go'],
  },
  {
    email: 'priya.natarajan@harborline.example.com',
    terminal: 'iTerm.app',
    version: '2.0.25',
    activity: 1.35,
    models: [0.55, 0.4, 0.05],
    langs: ['Go', 'SQL'],
  },
  {
    email: 'marco.bianchi@harborline.example.com',
    terminal: 'cursor',
    version: '2.0.22',
    activity: 0.8,
    models: [0.85, 0, 0.15],
    langs: ['Java', 'YAML'],
  },
  {
    email: 'sam.okafor@harborline.example.com',
    terminal: 'ghostty',
    version: '2.0.25',
    activity: 0.95,
    models: [0.75, 0.15, 0.1],
    langs: ['Python', 'TypeScript'],
  },
  {
    email: 'jules.moreau@harborline.example.com',
    terminal: 'vscode',
    version: '2.0.14',
    activity: 0.6,
    models: [0.9, 0, 0.1],
    langs: ['TypeScript', 'CSS'],
  },
  {
    email: 'dana.kowalski@harborline.example.com',
    terminal: 'Apple_Terminal',
    version: '2.0.22',
    activity: 0.7,
    models: [0.6, 0.3, 0.1],
    langs: ['Go', 'Python'],
  },
];
const MODELS = [
  { model: 'claude-sonnet-4-5', cost: 0.0016, tokens: 1 },
  { model: 'claude-opus-4-1', cost: 0.0068, tokens: 0.8 },
  { model: 'claude-haiku-4-5', cost: 0.00022, tokens: 1.3 },
];

const claudeFamily: Family = {
  prodOnly: true,
  metrics: [
    m('claude_code_cost_usage', 'counter', 'Cost of the Claude Code session', 'USD'),
    m('claude_code_token_usage', 'counter', 'Number of tokens used', 'tokens'),
    m('claude_code_session_count', 'counter', 'Count of CLI sessions started', 'count'),
    m('claude_code_commit_count', 'counter', 'Number of git commits created', 'count'),
    m('claude_code_pull_request_count', 'counter', 'Number of pull requests created', 'count'),
    m('claude_code_active_time_total', 'counter', 'Total active time in seconds', 's'),
    m('claude_code_lines_of_code_count', 'counter', 'Count of lines of code modified', 'count'),
    m(
      'claude_code_code_edit_tool_decision',
      'counter',
      'Count of code editing tool permission decisions',
      'count',
    ),
  ],
  build(_ctx, sink) {
    const resets = [COUNTER_EPOCH];
    for (const eng of ENGINEERS) {
      const base: Labels = {
        service_name: 'claude-code',
        user_email: eng.email,
        user_account_uuid: uuidFrom(eng.email),
        organization_id: uuidFrom('harborline-org'),
        terminal_type: eng.terminal,
        app_version: eng.version,
      };
      const seed = hashString(eng.email);
      const add = (
        name: string,
        labels: Labels,
        perSecond: number,
        integer: boolean,
        salt = name,
      ) =>
        sink.add(name, { ...base, ...labels }, (ts) =>
          counterValues(
            basesFor(seed ^ hashString(salt), ts, resets),
            { w: perSecond * eng.activity },
            integer,
          ),
        );
      MODELS.forEach((model, k) => {
        const share = eng.models[k];
        if (!share) return;
        const ml = { model: model.model };
        add('claude_code_cost_usage', ml, model.cost * share, false);
        for (const [type, rate] of [
          ['input', 38],
          ['output', 21],
          ['cacheRead', 880],
          ['cacheCreation', 64],
        ] as const) {
          add(
            'claude_code_token_usage',
            { ...ml, type },
            rate * model.tokens * share,
            true,
            `tok/${model.model}/${type}`,
          );
        }
        add(
          'claude_code_lines_of_code_count',
          { ...ml, type: 'added' },
          0.055 * share,
          true,
          `loc+/${model.model}`,
        );
        add(
          'claude_code_lines_of_code_count',
          { ...ml, type: 'removed' },
          0.019 * share,
          true,
          `loc-/${model.model}`,
        );
      });
      add('claude_code_session_count', {}, 0.0006, true);
      add('claude_code_commit_count', {}, 0.00026, true);
      add('claude_code_pull_request_count', {}, 0.00006, true);
      add('claude_code_active_time_total', { type: 'user' }, 0.42, false, 'active/user');
      add('claude_code_active_time_total', { type: 'cli' }, 0.29, false, 'active/cli');
      for (const [tool, accept, reject] of [
        ['Edit', 0.0075, 0.0007],
        ['MultiEdit', 0.0028, 0.0003],
        ['Write', 0.0019, 0.0004],
      ] as const) {
        eng.langs.forEach((language, li) => {
          const share = li === 0 ? 0.75 : 0.25;
          const labels = { tool_name: tool, language, source: 'config' };
          add(
            'claude_code_code_edit_tool_decision',
            { ...labels, decision: 'accept' },
            accept * share,
            true,
            `${tool}/${language}/a`,
          );
          add(
            'claude_code_code_edit_tool_decision',
            { ...labels, decision: 'reject' },
            reject * share,
            true,
            `${tool}/${language}/r`,
          );
        });
      }
    }
  },
};

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

const FAMILIES: Family[] = [
  hostFamily,
  nodeFamily,
  podFamily,
  httpFamily,
  poolFamily,
  postgresFamily,
  valkeyFamily,
  jvmFamily,
  collectorFamily,
  dockerFamily,
  claudeFamily,
];

const familyOf = new Map<string, Family>();
for (const family of FAMILIES) for (const info of family.metrics) familyOf.set(info.name, family);

const PROD_METRICS = FAMILIES.flatMap((family) => family.metrics);
const STAGING_METRICS = FAMILIES.filter((family) => !family.prodOnly).flatMap(
  (family) => family.metrics,
);

/** Whether `name` is one of these generated metrics (any project). */
export const isGeneratedMetric = (name: string): boolean => familyOf.has(name);

function generatedMetrics(projectId: string): MetricInfo[] {
  const proj = PROJECTS[projectId];
  if (!proj) return [];
  return proj.prod ? PROD_METRICS : STAGING_METRICS;
}

function defsFor(ctx: Ctx, name: string): Def[] {
  const family = familyOf.get(name);
  if (!family || (family.prodOnly && !ctx.proj.prod)) return [];
  let built = ctx.built.get(family);
  if (!built) {
    const sink = new Sink();
    family.build(ctx, sink);
    built = sink.defs;
    ctx.built.set(family, built);
  }
  return built.get(name) ?? [];
}

function lowerBound(ts: number[], value: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function generatedSeries(
  projectId: string,
  name: string,
  matchers: LabelMatcher[],
  from: number,
  to: number,
  scrapeMs: number,
  now = Date.now(),
): RawSeries[] {
  const proj = PROJECTS[projectId];
  if (!proj) return [];
  const step = Math.max(SCRAPE_MS, Math.round(scrapeMs / SCRAPE_MS) * SCRAPE_MS);
  const lo = Math.max(from, dataStart(now));
  const hi = Math.min(to, now);
  if (lo > hi) return [];
  const first = Math.ceil(lo / step) * step;
  if (first > hi) return [];
  const shared: number[] = [];
  for (let t = first; t <= hi; t += step) shared.push(t);
  const ctx = ctxFor(proj, lo, hi);
  const match = compileMatchers(matchers);
  const out: RawSeries[] = [];
  for (const def of defsFor(ctx, name)) {
    if (!match(def.labels)) continue;
    let ts = shared;
    if (def.start !== undefined || def.end !== undefined) {
      const a = def.start === undefined ? 0 : lowerBound(shared, def.start);
      const b = def.end === undefined ? shared.length : lowerBound(shared, def.end);
      if (a >= b) continue;
      if (a > 0 || b < shared.length) ts = shared.slice(a, b);
    }
    out.push({ labels: def.labels, timestamps: ts, values: def.values(ts) });
  }
  return out;
}

/** Every value of `label` across the generated series alive in [from, to]. */
export function generatedLabelValues(
  projectId: string,
  label: string,
  from: number,
  to: number,
): Set<string> {
  const values = new Set<string>();
  const proj = PROJECTS[projectId];
  if (!proj) return values;
  const ctx = ctxFor(proj, Math.max(from, dataStart()), Math.min(to, Date.now()));
  for (const info of generatedMetrics(projectId)) {
    for (const def of defsFor(ctx, info.name)) {
      const value = def.labels[label];
      if (value !== undefined && value !== '') values.add(value);
    }
  }
  return values;
}

/** How many generated series are alive at `at` (for the stats endpoint). */
export function generatedSeriesCount(projectId: string, at = Date.now()): number {
  const proj = PROJECTS[projectId];
  if (!proj) return 0;
  const ctx = ctxFor(proj, at - HOUR, at);
  let count = 0;
  for (const info of generatedMetrics(projectId)) {
    for (const def of defsFor(ctx, info.name)) {
      if ((def.start === undefined || def.start <= at) && (def.end === undefined || def.end > at))
        count++;
    }
  }
  return count;
}

registerSeriesProvider({
  metrics: generatedMetrics,
  series: (projectId, name, matchers, from, to, scrapeMs) =>
    generatedSeries(projectId, name, matchers, from, to, scrapeMs),
});
