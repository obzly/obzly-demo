// The infrastructure inventory, derived the way a Site derives it
// (backend features/inventory): the harborline-prod cluster with its
// nodes, namespaces, workloads, pods and containers (the same pods logs and
// traces name, from world.ts), the batch VM, the traced services, and what
// the cloud connections' scans found. Health and reasons follow the
// backend's thresholds; the change feed follows deploys, the recurring
// checkout incident, a node replacement and a few cloud events.
import type {
  Asset,
  AssetChange,
  AssetHealth,
  AssetKind,
  AssetMetrics,
  AssetReason,
  AssetRef,
  AssetState,
  InventorySummary,
} from '../../entity/inventory';
import { projects } from '../handlers/bootstrap';
import { hashString, mix, rng, uuidFrom } from '../lib/rng';
import {
  AWS_ACCOUNT,
  AWS_CONNECTION_ID,
  type CloudResource,
  NEW_BUCKET_HOURS_AGO,
  REPLACED_NODE,
  REPLACEMENT_HOURS_AGO,
  cloudConnections,
  cloudResources,
  instanceId,
  resourceLabels,
} from '../seed/inventory';
import { destinations } from '../seed/synthetics';
import {
  BATCH_HOST,
  CALLS,
  CLUSTER,
  NODES,
  PROJECT_ID,
  REGION,
  WORKLOADS,
  type Workload,
  dataStart,
  deploysFor,
  incidentLevel,
  incidentsBetween,
  podsFor,
  traffic,
} from '../world';
import {
  type LabelMatcher,
  type MetricInfo,
  type RawSeries,
  matchAll,
  registerSeriesProvider,
} from './metricRegistry';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Workloads the cluster runs besides Harborline's own (no logs of their own in the demo). */
const SYSTEM_WORKLOADS: Workload[] = [
  {
    service: 'coredns',
    namespace: 'kube-system',
    kind: 'deployment',
    name: 'coredns',
    container: 'coredns',
    replicas: 2,
    logWeight: 0,
    version: '1.11.3',
  },
  {
    service: 'kube-proxy',
    namespace: 'kube-system',
    kind: 'daemonset',
    name: 'kube-proxy',
    container: 'kube-proxy',
    replicas: 4,
    logWeight: 0,
    version: '1.31.2',
  },
];

const ALL_WORKLOADS = [...WORKLOADS, ...SYSTEM_WORKLOADS];

const SUBTYPE: Record<Workload['kind'], string> = {
  deployment: 'Deployment',
  statefulset: 'StatefulSet',
  daemonset: 'DaemonSet',
};

/** Per-service CPU and memory as a share of the container limit, at traffic 1. */
const USAGE: Record<string, [number, number]> = {
  'ingress-nginx': [28, 41],
  storefront: [34, 58],
  checkout: [24, 52],
  payments: [31, 66],
  catalog: [19, 47],
  inventory: [14, 39],
  search: [42, 78],
  auth: [17, 44],
  postgres: [36, 71],
  valkey: [9, 63],
  'otel-collector': [21, 49],
  coredns: [4, 22],
  'kube-proxy': [2, 18],
};

const IMAGE: Record<string, string> = {
  'ingress-nginx': 'registry.k8s.example.com/ingress-nginx/controller',
  postgres: 'docker.example.com/library/postgres',
  valkey: 'docker.example.com/valkey/valkey',
  'otel-collector': 'docker.example.com/otel/opentelemetry-collector-contrib',
  coredns: 'registry.k8s.example.com/coredns/coredns',
  'kube-proxy': 'registry.k8s.example.com/kube-proxy',
};

const imageOf = (w: Workload) =>
  IMAGE[w.service] ?? `registry.harborline.example.com/shop/${w.name}`;

const clusterKey = (cluster: string) => `cluster:${cluster}`;
const namespaceKey = (cluster: string, ns: string) => `ns:${cluster}/${ns}`;
const nodeKey = (cluster: string, node: string) => `node:${cluster}/${node}`;
const hostKey = (host: string) => `host:${host}`;
const podKey = (cluster: string, ns: string, uid: string) => `pod:${cluster}/${ns}/${uid}`;
const workloadKey = (cluster: string, ns: string, kind: string, name: string) =>
  `wl:${cluster}/${ns}/${kind}/${name}`;
const containerKey = (pod: string, name: string) => `ctr:${pod.replace(/^pod:/, '')}/${name}`;
const serviceKey = (name: string) => `svc:${name}`;

const podUid = (name: string) => uuidFrom(`pod-uid:${name}`);
const round1 = (value: number) => Math.round(value * 10) / 10;
const iso = (ms: number) => new Date(ms).toISOString();

/** Hours ago, on the hour: recent events move once an hour, not on every request. */
const hoursAgo = (hours: number, now: number) => Math.floor((now - hours * HOUR) / HOUR) * HOUR;

// --- assets ---------------------------------------------------------------------------

interface Draft extends Omit<Asset, 'id' | 'projectName' | 'state' | 'health' | 'reasons'> {
  state?: AssetState;
  reasons: AssetReason[];
  health?: AssetHealth;
}

const HEALTH_RANK: Record<AssetHealth, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  healthy: 3,
  inactive: 4,
};

function draft(
  projectId: string,
  kind: AssetKind,
  key: string,
  name: string,
  now: number,
  extra: Partial<Draft> = {},
): Draft {
  return {
    projectId,
    kind,
    key,
    name,
    subtype: '',
    parentKey: '',
    nodeKey: '',
    cluster: '',
    namespace: '',
    node: '',
    attributes: {},
    sources: ['metrics'],
    firstSeen: iso(dataStart(now)),
    lastSeen: iso(now - 5_000 - (hashString(key) % 25_000)),
    reasons: [],
    metrics: {},
    updatedAt: iso(now - (now % 60_000)),
    ...extra,
  };
}

function lifecycle(a: Draft, now: number): AssetState {
  const gone = now - Date.parse(a.lastSeen);
  const transient = a.kind === 'pod' || a.kind === 'container';
  const cloudOnly = a.sources.length === 1 && a.sources[0] === 'cloud';
  if ((transient && gone >= 30 * MINUTE) || (!transient && gone >= DAY)) return 'terminated';
  if ((gone >= 10 * MINUTE && !cloudOnly) || gone >= 50 * MINUTE) return 'not_reporting';
  if (now - Date.parse(a.firstSeen) < DAY) return 'new';
  return 'active';
}

const reason = (health: AssetHealth, text: string): AssetReason => ({ health, text });

function threshold(
  out: AssetReason[],
  value: number | undefined,
  what: string,
  warnAt: number,
  criticalAt = 0,
) {
  if (value === undefined) return;
  if (criticalAt > 0 && value >= criticalAt) {
    out.push(reason('critical', `${what} at ${value.toFixed(0)}%`));
  } else if (value >= warnAt) out.push(reason('warning', `${what} at ${value.toFixed(0)}%`));
}

const KIND_TEXT: Partial<Record<AssetKind, string>> = {
  pod: 'Pod',
  container: 'Container',
  node: 'Node',
  namespace: 'Namespace',
  cluster: 'Cluster',
};
const kindText = (a: Draft) => (a.kind === 'workload' ? a.subtype : (KIND_TEXT[a.kind] ?? a.kind));

function rollUp(a: Draft, kids: Draft[]) {
  const failing = kids.filter((k) => k.health === 'warning' || k.health === 'critical');
  if (!failing.length) return;
  const worst = [...failing].sort((x, y) => HEALTH_RANK[x.health!] - HEALTH_RANK[y.health!])[0];
  let text = `${kindText(worst)} ${worst.name}: ${worst.reasons[0]?.text ?? ''}`;
  if (failing.length > 1) text += ` (and ${failing.length - 1} more)`;
  a.reasons.push(reason('warning', text));
}

function assessCloud(a: Draft): boolean {
  const state = a.attributes.cloud_resource_state;
  if (state === undefined) return false;
  const provider = a.attributes.cloud_provider === 'azure' ? 'Azure' : 'AWS';
  if (['stopped', 'stopping', 'terminated', 'deallocated', 'paused'].includes(state)) {
    a.reasons.push(reason('inactive', `${state[0].toUpperCase()}${state.slice(1)} in ${provider}`));
    return true;
  }
  const fine = ['', 'running', 'available', 'active', 'online', 'ready', 'succeeded'];
  if (!fine.includes(state)) a.reasons.push(reason('warning', `${provider} reports "${state}"`));
  if (a.attributes.cloud_health === 'unhealthy') {
    a.reasons.push(
      reason('critical', `${provider} reports it unhealthy (failed status checks or unavailable)`),
    );
  } else if (a.attributes.cloud_health === 'degraded') {
    a.reasons.push(reason('warning', `${provider} reports it degraded`));
  }
  const total = Number(a.attributes.targets_total);
  if (total > 0) {
    const healthy = Number(a.attributes.targets_healthy);
    if (healthy === 0)
      a.reasons.push(reason('critical', `No healthy targets (${total} registered)`));
    else if (healthy < total) {
      a.reasons.push(reason('warning', `${total - healthy} of ${total} targets unhealthy`));
    }
  }
  if (a.kind === 'scaling_group') {
    const desired = Number(a.attributes.desired);
    const healthy = Number(a.attributes.healthy);
    if (healthy < desired) {
      a.reasons.push(reason('warning', `${healthy} of ${desired} desired instances healthy`));
    }
  }
  return false;
}

function assess(a: Draft, kids: Draft[], byKey: Map<string, Draft>, now: number) {
  const m = a.metrics;
  if (a.state === 'terminated') {
    a.reasons.push(
      reason('inactive', `No data since ${a.lastSeen.slice(0, 16).replace('T', ' ')} UTC`),
    );
    return;
  }
  if (a.state === 'not_reporting') {
    const minutes = Math.round((now - Date.parse(a.lastSeen)) / MINUTE);
    a.reasons.push(
      reason(
        ['node', 'host', 'cluster'].includes(a.kind) ? 'critical' : 'unknown',
        `No data for ${minutes} min`,
      ),
    );
    return;
  }
  if (assessCloud(a)) return;
  switch (a.kind) {
    case 'node':
    case 'host':
      if (m.ready === false) a.reasons.push(reason('critical', 'Node is NotReady'));
      threshold(a.reasons, m.cpuPercent, 'CPU', 90);
      threshold(a.reasons, m.memoryPercent, 'Memory', 90, 97);
      threshold(a.reasons, m.diskPercent, 'Filesystem', 85, 95);
      break;
    case 'pod':
    case 'container':
      if ((m.restarts1h ?? 0) >= 10) {
        a.reasons.push(
          reason('critical', `${m.restarts1h} container restarts in the last hour (crash looping)`),
        );
      } else if ((m.restarts1h ?? 0) >= 3) {
        a.reasons.push(reason('warning', `${m.restarts1h} container restarts in the last hour`));
      }
      if (m.memoryBasis === 'limit')
        threshold(a.reasons, m.memoryPercent, 'Memory (of its limit)', 90);
      if ((m.errorShare ?? 0) > 5) {
        a.reasons.push(
          reason(
            'warning',
            `Error logs are ${m.errorShare!.toFixed(1)}% of its lines in the last 15 min`,
          ),
        );
      }
      break;
    case 'workload':
      if ((m.desired ?? 0) > 0 && m.available !== undefined) {
        if (m.available === 0) {
          a.reasons.push(reason('critical', `No replicas available (0 of ${m.desired})`));
        } else if (m.available < m.desired!) {
          a.reasons.push(reason('warning', `${m.available} of ${m.desired} replicas available`));
        }
      }
      rollUp(
        a,
        kids.filter((k) => k.kind === 'pod'),
      );
      break;
    case 'namespace':
      rollUp(a, kids);
      break;
    case 'cluster': {
      const nodes = kids.filter((k) => k.kind === 'node' && k.state !== 'terminated');
      const down = nodes.filter((k) => k.health === 'critical').length;
      if (nodes.length && down === nodes.length)
        a.reasons.push(reason('critical', 'No node is healthy'));
      else if (down) a.reasons.push(reason('warning', `${down} of ${nodes.length} nodes critical`));
      rollUp(
        a,
        kids.filter((k) => k.kind !== 'node'),
      );
      break;
    }
    case 'service': {
      const parent = byKey.get(a.parentKey);
      if (parent?.health && parent.health !== 'healthy' && parent.health !== 'inactive') {
        a.reasons.push(
          reason(
            parent.health === 'critical' ? 'warning' : parent.health,
            `Workload ${parent.name}: ${parent.reasons[0]?.text ?? ''}`,
          ),
        );
      }
      break;
    }
  }
}

function worst(a: Draft): AssetHealth {
  if (!a.reasons.length) return a.kind === 'service' && !a.parentKey ? 'unknown' : 'healthy';
  a.reasons.sort((x, y) => HEALTH_RANK[x.health] - HEALTH_RANK[y.health]);
  return a.reasons[0].health;
}

/** Error share of a service's log lines in the 15 minutes before now. */
function errorShare(service: string, now: number, r: () => number): number {
  if (service !== 'checkout' && service !== 'payments') return round1(0.2 + r() * 1.1);
  let peak = 0;
  for (let t = now - 15 * MINUTE; t <= now; t += MINUTE) peak = Math.max(peak, incidentLevel(t));
  return round1(peak > 0 ? 9 + peak * (service === 'payments' ? 22 : 14) + r() * 3 : 0.4 + r());
}

function podMetrics(w: Workload, index: number, now: number): AssetMetrics {
  const r = rng(mix(hashString(w.name), index, Math.floor(now / (5 * MINUTE))));
  const [cpu, memory] = USAGE[w.service] ?? [15, 40];
  const load = 0.6 + 0.4 * traffic(now);
  const incident = incidentLevel(now);
  const surge = w.service === 'payments' || w.service === 'checkout' ? 1 + incident * 0.8 : 1;
  // One search replica runs close to its memory limit (a slow leak, restarted nightly).
  const leak = w.service === 'search' && index === 1 ? 14 + ((now % DAY) / DAY) * 6 : 0;
  const restarts24 =
    w.service === 'payments' ? incidentsBetween(now - DAY, now).length - (index % 2) : 0;
  const recentIncident = incidentsBetween(now - HOUR, now).length > 0;
  return {
    cpuPercent: round1(cpu * load * surge * (0.85 + 0.3 * r())),
    memoryPercent: round1(Math.min(99, memory * (0.95 + 0.1 * r()) + leak)),
    cpuBasis: 'limit',
    memoryBasis: 'limit',
    restarts1h: w.service === 'payments' && recentIncident && index === 0 ? 1 : 0,
    restarts24h: Math.max(0, restarts24),
    errorShare: errorShare(w.service, now, r),
    phase: 'Running',
    ready: true,
  };
}

function nodeMetrics(node: string, now: number): AssetMetrics {
  const r = rng(mix(hashString(node), Math.floor(now / (5 * MINUTE))));
  const load = 0.55 + 0.45 * traffic(now);
  return {
    cpuPercent: round1((32 + (hashString(node) % 18)) * load + r() * 6),
    memoryPercent: round1(58 + (hashString(node) % 14) + r() * 4),
    diskPercent: round1(41 + (hashString(`${node}:disk`) % 26) + r()),
    ready: true,
  };
}

function batchMetrics(now: number): AssetMetrics {
  const hour = (now % DAY) / HOUR;
  const exporting = hour >= 1 && hour < 2.2;
  const r = rng(Math.floor(now / (5 * MINUTE)));
  // The nightly export grows the disk ~0.4% a day; it crossed 85% this morning.
  const disk = 85.2 + ((now - hoursAgo(5, now)) / DAY) * 0.4;
  return {
    cpuPercent: round1(exporting ? 78 + r() * 12 : 6 + r() * 5),
    memoryPercent: round1(exporting ? 72 + r() * 8 : 38 + r() * 4),
    diskPercent: round1(disk),
  };
}

function cloudAttributes(resource: CloudResource, refresh: number): Record<string, string> {
  const labels = resourceLabels(resource, refresh);
  delete labels.cloud_connection_id;
  if (resource.targets) {
    const total = Object.values(resource.targets).reduce((s, n) => s + n, 0);
    labels.targets_healthy = String(resource.targets.healthy ?? 0);
    labels.targets_total = String(total);
  }
  return labels;
}

/** Where each connection's results go. */
function connectionProject(connectionId: string): string | undefined {
  const connection = cloudConnections.get(connectionId);
  if (!connection?.enabled) return undefined;
  return destinations.get(connection.destinationId)?.projectId;
}

/** When the connection's latest health scan (every 15 min, 47 s past) read a resource. */
export function lastHealthScan(now: number, intervalSeconds = 900): number {
  const step = intervalSeconds * 1000;
  const t = Math.floor(now / step) * step + 47_000;
  return t > now ? t - step : t;
}

const lastHealthScanBefore = (t: number) => lastHealthScan(t);

function build(now: number): Draft[] {
  const out: Draft[] = [];
  const add = (a: Draft) => {
    out.push(a);
    return a;
  };
  const pid = PROJECT_ID;
  const scanned = new Map(
    cloudResources()
      .filter((r) => connectionProject(r.connectionId))
      .map((r) => [r.id, r]),
  );
  const awsOn = connectionProject(AWS_CONNECTION_ID) === pid;
  const refresh = 900;
  const withCloud = (a: Draft, resource: CloudResource | undefined) => {
    if (!resource || !awsOn) return a;
    a.sources = [...a.sources, 'cloud'];
    for (const [key, value] of Object.entries(cloudAttributes(resource, refresh))) {
      if (!(key in a.attributes) || key.startsWith('cloud_')) a.attributes[key] = value;
    }
    return a;
  };

  // The cluster and its nodes.
  const cluster = add(
    draft(pid, 'cluster', clusterKey(CLUSTER), CLUSTER, now, {
      cluster: CLUSTER,
      firstSeen: iso(dataStart(now) - 380 * DAY),
      attributes: {
        k8s_cluster_name: CLUSTER,
        cloud_provider: 'aws',
        cloud_platform: 'aws_eks',
        cloud_region: REGION,
        cloud_account_id: AWS_ACCOUNT,
      },
    }),
  );
  withCloud(cluster, scanned.get(`arn:aws:eks:${REGION}:${AWS_ACCOUNT}:cluster/${CLUSTER}`));
  const replacedAt = hoursAgo(REPLACEMENT_HOURS_AGO, now);
  NODES.forEach((node, i) => {
    const a = add(
      draft(pid, 'node', nodeKey(CLUSTER, node), node, now, {
        parentKey: cluster.key,
        cluster: CLUSTER,
        node,
        firstSeen: iso(node === NODES[3] ? replacedAt : now - (34 - i * 3) * DAY),
        attributes: {
          host_name: node,
          k8s_node_name: node,
          k8s_cluster_name: CLUSTER,
          host_id: instanceId(node),
          host_arch: 'amd64',
          os_type: 'linux',
          os_description: 'Amazon Linux 2023.6.20241111',
          cloud_provider: 'aws',
          cloud_platform: 'aws_ec2',
          cloud_region: REGION,
          cloud_account_id: AWS_ACCOUNT,
          k8s_kubelet_version: 'v1.31.2-eks-94953ac',
        },
        metrics: nodeMetrics(node, now),
      }),
    );
    withCloud(a, scanned.get(instanceId(node)));
  });

  // Namespaces, workloads, pods and containers.
  const namespaces = [...new Set(ALL_WORKLOADS.map((w) => w.namespace))];
  for (const ns of namespaces) {
    add(
      draft(pid, 'namespace', namespaceKey(CLUSTER, ns), ns, now, {
        parentKey: cluster.key,
        cluster: CLUSTER,
        namespace: ns,
        firstSeen: cluster.firstSeen,
        attributes: { k8s_cluster_name: CLUSTER, k8s_namespace_name: ns },
      }),
    );
  }
  for (const w of ALL_WORKLOADS) {
    const subtype = SUBTYPE[w.kind];
    const key = workloadKey(CLUSTER, w.namespace, subtype, w.name);
    const deploys = deploysFor(w.service, now - 4 * DAY, now);
    const release = deploys.length ? deploys[deploys.length - 1].time : undefined;
    add(
      draft(pid, 'workload', key, w.name, now, {
        subtype,
        parentKey: namespaceKey(CLUSTER, w.namespace),
        cluster: CLUSTER,
        namespace: w.namespace,
        firstSeen: iso(now - (90 + (hashString(w.name) % 200)) * DAY),
        attributes: {
          k8s_cluster_name: CLUSTER,
          k8s_namespace_name: w.namespace,
          [`k8s_${subtype.toLowerCase()}_name`]: w.name,
          container_image_name: imageOf(w),
          container_image_tag: w.version,
        },
        metrics: { desired: w.replicas, available: w.replicas },
      }),
    );
    const pods = podsFor(w, now);
    pods.forEach((pod, index) => {
      const uid = podUid(pod.name);
      const pKey = podKey(CLUSTER, w.namespace, uid);
      const firstSeen =
        release ?? now - (w.kind === 'deployment' ? 4 : 9 + (hashString(pod.name) % 20)) * DAY;
      const node = pod.node;
      const metrics = podMetrics(w, index, now);
      add(
        draft(pid, 'pod', pKey, pod.name, now, {
          parentKey: key,
          nodeKey: nodeKey(CLUSTER, node),
          cluster: CLUSTER,
          namespace: w.namespace,
          node,
          firstSeen: iso(Math.max(firstSeen, node === NODES[3] ? replacedAt : 0)),
          attributes: {
            k8s_cluster_name: CLUSTER,
            k8s_namespace_name: w.namespace,
            k8s_pod_name: pod.name,
            k8s_pod_uid: uid,
            k8s_node_name: node,
            [`k8s_${subtype.toLowerCase()}_name`]: w.name,
            ...(pod.replicaSet ? { k8s_replicaset_name: pod.replicaSet } : {}),
            service_name: w.service,
          },
          metrics,
        }),
      );
      add(
        draft(pid, 'container', containerKey(pKey, w.container), w.container, now, {
          parentKey: pKey,
          nodeKey: nodeKey(CLUSTER, node),
          cluster: CLUSTER,
          namespace: w.namespace,
          node,
          firstSeen: iso(Math.max(firstSeen, node === NODES[3] ? replacedAt : 0)),
          attributes: {
            k8s_cluster_name: CLUSTER,
            k8s_namespace_name: w.namespace,
            k8s_pod_name: pod.name,
            k8s_container_name: w.container,
            container_image_name: imageOf(w),
            container_image_tag: w.version,
          },
          metrics: { ...metrics, phase: undefined },
        }),
      );
    });
    // Pods the last rollout replaced, kept while they're recent.
    for (const deploy of deploys.filter((d) => now - d.time < DAY)) {
      for (const pod of podsFor(w, deploy.time - 1_000)) {
        const uid = podUid(pod.name);
        const pKey = podKey(CLUSTER, w.namespace, uid);
        if (out.some((a) => a.key === pKey)) continue;
        add(
          draft(pid, 'pod', pKey, pod.name, now, {
            parentKey: key,
            nodeKey: nodeKey(CLUSTER, pod.node),
            cluster: CLUSTER,
            namespace: w.namespace,
            node: pod.node,
            firstSeen: iso(deploy.time - 6 * HOUR),
            lastSeen: iso(deploy.time + 40_000),
            attributes: {
              k8s_cluster_name: CLUSTER,
              k8s_namespace_name: w.namespace,
              k8s_pod_name: pod.name,
              k8s_pod_uid: uid,
              k8s_node_name: pod.node,
              [`k8s_${subtype.toLowerCase()}_name`]: w.name,
              service_name: w.service,
            },
            metrics: { phase: 'Running', cpuBasis: 'limit', memoryBasis: 'limit' },
          }),
        );
      }
    }
  }

  // The traced services, each linked to its workload.
  const traced = new Set(Object.keys(CALLS).filter((service) => service !== 'ingress-nginx'));
  for (const w of WORKLOADS.filter((w) => traced.has(w.service))) {
    add(
      draft(pid, 'service', serviceKey(w.service), w.service, now, {
        sources: ['traces'],
        parentKey: workloadKey(CLUSTER, w.namespace, SUBTYPE[w.kind], w.name),
        cluster: CLUSTER,
        namespace: w.namespace,
        attributes: {
          service_name: w.service,
          k8s_namespace_name: w.namespace,
          k8s_deployment_name: w.name,
          ...(w.language ? { telemetry_sdk_language: w.language } : {}),
          service_version: w.version,
        },
      }),
    );
  }

  // The batch VM: agent host metrics joined with its EC2 instance.
  const batch = add(
    draft(pid, 'host', hostKey(BATCH_HOST), BATCH_HOST, now, {
      subtype: 'EC2 instance',
      node: BATCH_HOST,
      firstSeen: iso(now - 212 * DAY),
      attributes: {
        host_name: BATCH_HOST,
        host_id: instanceId(BATCH_HOST),
        host_arch: 'amd64',
        os_type: 'linux',
        os_description: 'Ubuntu 24.04.1 LTS',
        cloud_provider: 'aws',
        cloud_platform: 'aws_ec2',
        cloud_region: REGION,
        cloud_account_id: AWS_ACCOUNT,
      },
      metrics: batchMetrics(now),
    }),
  );
  withCloud(batch, scanned.get(instanceId(BATCH_HOST)));

  // Resources only the cloud reports.
  const joined = new Set([
    ...NODES.map(instanceId),
    instanceId(BATCH_HOST),
    `arn:aws:eks:${REGION}:${AWS_ACCOUNT}:cluster/${CLUSTER}`,
  ]);
  for (const resource of scanned.values()) {
    if (joined.has(resource.id)) continue;
    const projectId = connectionProject(resource.connectionId)!;
    const kind = cloudKind(resource);
    if (!kind) continue;
    const seen = lastHealthScan(now);
    const firstSeen = Math.max(now - resource.ageDays * DAY, dataStart(now) - 400 * DAY);
    const a = draft(projectId, kind.kind, kind.key, resource.name, now, {
      subtype: kind.subtype,
      sources: ['cloud'],
      firstSeen: iso(resource.ageDays < 1 ? hoursAgo(resource.ageDays * 24, now) : firstSeen),
      lastSeen: iso(seen),
      attributes: cloudAttributes(resource, refresh),
    });
    if (kind.kind === 'cluster') a.cluster = resource.name;
    if (kind.kind === 'host') a.node = resource.name;
    add(a);
  }
  return out;
}

function cloudKind(
  resource: CloudResource,
): { kind: AssetKind; subtype: string; key: string } | undefined {
  const key = `cloud:${resource.type}/${resource.id}`;
  switch (resource.type) {
    case 'aws_ec2_instance':
      return { kind: 'host', subtype: 'EC2 instance', key: `host:cloud/${resource.id}` };
    case 'azure_virtual_machine':
      return { kind: 'host', subtype: 'Azure VM', key: `host:cloud/${resource.id}` };
    case 'aws_eks_cluster':
    case 'azure_aks_cluster':
      return { kind: 'cluster', subtype: '', key: clusterKey(resource.name) };
    case 'aws_load_balancer': {
      const lb = resource.attributes.lb_type;
      const subtype =
        lb === 'network'
          ? 'Network Load Balancer'
          : lb === 'gateway'
            ? 'Gateway Load Balancer'
            : 'Application Load Balancer';
      return { kind: 'load_balancer', subtype, key };
    }
    case 'aws_rds_instance':
      return { kind: 'database', subtype: 'RDS', key };
    case 'aws_s3_bucket':
      return { kind: 'bucket', subtype: 'S3 bucket', key };
    case 'aws_lambda_function':
      return { kind: 'function', subtype: 'Lambda', key };
    case 'aws_autoscaling_group':
      return { kind: 'scaling_group', subtype: 'Auto Scaling group', key };
    case 'azure_application_gateway':
      return { kind: 'load_balancer', subtype: 'Application Gateway', key };
    case 'azure_load_balancer':
      return { kind: 'load_balancer', subtype: 'Azure Load Balancer', key };
    case 'azure_postgresql_server':
      return { kind: 'database', subtype: 'PostgreSQL flexible server', key };
    case 'azure_sql_database':
      return { kind: 'database', subtype: 'Azure SQL', key };
    case 'azure_storage_account':
      return { kind: 'bucket', subtype: 'Storage account', key };
    case 'azure_function_app':
      return { kind: 'function', subtype: 'Function app', key };
    case 'azure_vm_scale_set':
      return { kind: 'scaling_group', subtype: 'VM scale set', key };
    default:
      return undefined;
  }
}

let cache: { bucket: number; version: string; assets: Asset[] } | undefined;

/** Every asset now, health assessed (cached for 15 s). */
export function inventoryAssets(now = Date.now()): Asset[] {
  const bucket = Math.floor(now / 15_000);
  const version = JSON.stringify(
    cloudConnections.all().map((c) => [c.id, c.enabled, c.destinationId]),
  );
  if (cache && cache.bucket === bucket && cache.version === version) return cache.assets;
  const drafts = build(now);
  const children = new Map<string, Draft[]>();
  for (const a of drafts) {
    a.state = lifecycle(a, now);
    if (!a.parentKey) continue;
    const id = `${a.projectId}|${a.parentKey}`;
    children.set(id, [...(children.get(id) ?? []), a]);
  }
  // Leaves first, then workloads, namespaces, services and clusters.
  const order: AssetKind[] = [
    'container',
    'pod',
    'node',
    'host',
    'load_balancer',
    'database',
    'bucket',
    'function',
    'scaling_group',
    'docker_container',
    'workload',
    'namespace',
    'service',
    'cluster',
  ];
  const keyed = new Map(drafts.map((a) => [a.key, a]));
  for (const kind of order) {
    for (const a of drafts.filter((d) => d.kind === kind)) {
      assess(a, children.get(`${a.projectId}|${a.key}`) ?? [], keyed, now);
      a.health = worst(a);
    }
  }
  const names = new Map(projects.all().map((p) => [p.id, p.name]));
  const assets = drafts.map((a): Asset => ({
    ...a,
    id: uuidFrom(`${a.projectId}|${a.key}`),
    projectName: names.get(a.projectId) ?? '',
    state: a.state!,
    health: a.health!,
  }));
  cache = { bucket, version, assets };
  return assets;
}

const HEALTH_ORDER: Record<AssetHealth, number> = {
  critical: 0,
  warning: 1,
  healthy: 2,
  unknown: 3,
  inactive: 4,
};

/** Worst health first, then kind and name, like the Site's query. */
export function sortAssets(assets: Asset[]): Asset[] {
  return [...assets].sort(
    (a, b) =>
      HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );
}

export function summarize(assets: Asset[]): InventorySummary {
  const summary: InventorySummary = { total: 0, kinds: {}, health: {}, states: {}, projects: [] };
  const perProject = new Map<string, { id: string; name: string; assets: number }>();
  for (const a of assets) {
    summary.total++;
    const kind = (summary.kinds[a.kind] ??= {});
    kind[a.health] = (kind[a.health] ?? 0) + 1;
    summary.health[a.health] = (summary.health[a.health] ?? 0) + 1;
    summary.states[a.state] = (summary.states[a.state] ?? 0) + 1;
    const project = perProject.get(a.projectId) ?? {
      id: a.projectId,
      name: a.projectName,
      assets: 0,
    };
    project.assets++;
    perProject.set(a.projectId, project);
  }
  summary.projects = [...perProject.values()];
  return summary;
}

export const refOf = (a: Asset): AssetRef => ({
  id: a.id,
  kind: a.kind,
  subtype: a.subtype,
  name: a.name,
  health: a.health,
});

// --- the change feed ------------------------------------------------------------------

interface ChangeDraft {
  projectId: string;
  assetKey: string;
  assetName: string;
  kind: AssetKind;
  change: AssetChange['change'];
  from: string;
  to: string;
  detail: string;
  at: number;
}

/** Inventory changes in [from, to], newest first. */
export function changesBetween(from: number, to: number, now = Date.now()): AssetChange[] {
  const out: ChangeDraft[] = [];
  const pid = PROJECT_ID;
  const push = (c: Omit<ChangeDraft, 'projectId'> & { projectId?: string }) => {
    if (c.at >= from && c.at <= to && c.at <= now) out.push({ projectId: pid, ...c });
  };

  // Rollouts: new pods, then the old ones go.
  for (const w of WORKLOADS.filter((w) => w.kind === 'deployment')) {
    for (const deploy of deploysFor(w.service, from - 31 * MINUTE, to)) {
      podsFor(w, deploy.time + 1_000).forEach((pod, i) =>
        push({
          assetKey: podKey(CLUSTER, w.namespace, podUid(pod.name)),
          assetName: pod.name,
          kind: 'pod',
          change: 'new',
          from: '',
          to: 'new',
          detail: 'Pod',
          at: deploy.time + 20_000 + i * 25_000,
        }),
      );
      podsFor(w, deploy.time - 1_000).forEach((pod, i) =>
        push({
          assetKey: podKey(CLUSTER, w.namespace, podUid(pod.name)),
          assetName: pod.name,
          kind: 'pod',
          change: 'state',
          from: 'active',
          to: 'terminated',
          detail: '',
          at: deploy.time + 31 * MINUTE + i * 25_000,
        }),
      );
    }
  }

  // The checkout incident: error logs turn checkout and payments amber, rolled up the tree.
  for (const incident of incidentsBetween(from - HOUR, to)) {
    const startAt = incident.start + 4 * MINUTE;
    const endAt = incident.end + 15 * MINUTE;
    const flip = (
      c: Pick<ChangeDraft, 'assetKey' | 'assetName' | 'kind'>,
      detail: string,
      offset: number,
    ) => {
      push({
        ...c,
        change: 'health',
        from: 'healthy',
        to: 'warning',
        detail,
        at: startAt + offset,
      });
      push({
        ...c,
        change: 'health',
        from: 'warning',
        to: 'healthy',
        detail: '',
        at: endAt + offset,
      });
    };
    const rolled: Record<string, string> = {};
    for (const service of ['payments', 'checkout']) {
      const w = WORKLOADS.find((x) => x.service === service)!;
      const pods = podsFor(w, incident.start + 6 * MINUTE);
      const share = service === 'payments' ? 26.4 : 17.8;
      const text = (i: number) =>
        `Error logs are ${(share - i * 1.3).toFixed(1)}% of its lines in the last 15 min`;
      pods.forEach((pod, i) =>
        flip(
          {
            assetKey: podKey(CLUSTER, w.namespace, podUid(pod.name)),
            assetName: pod.name,
            kind: 'pod',
          },
          text(i),
          i * 1_000,
        ),
      );
      const more = pods.length > 1 ? ` (and ${pods.length - 1} more)` : '';
      rolled[service] = `Pod ${pods[0].name}: ${text(0)}${more}`;
      flip(
        {
          assetKey: workloadKey(CLUSTER, w.namespace, SUBTYPE[w.kind], w.name),
          assetName: w.name,
          kind: 'workload',
        },
        rolled[service],
        5_000,
      );
      flip(
        { assetKey: serviceKey(service), assetName: service, kind: 'service' },
        `Workload ${w.name}: ${rolled[service]}`,
        6_000,
      );
    }
    const nsText = `Deployment payments: ${rolled.payments} (and 1 more)`;
    flip(
      { assetKey: namespaceKey(CLUSTER, 'shop'), assetName: 'shop', kind: 'namespace' },
      nsText,
      8_000,
    );
    flip(
      { assetKey: clusterKey(CLUSTER), assetName: CLUSTER, kind: 'cluster' },
      `Namespace shop: ${nsText}`,
      9_000,
    );
  }

  // A node replaced overnight: the new one joins, the old one stops reporting and is dropped.
  const replacedAt = hoursAgo(REPLACEMENT_HOURS_AGO, now);
  const newNode = NODES[3];
  push({
    assetKey: nodeKey(CLUSTER, newNode),
    assetName: newNode,
    kind: 'node',
    change: 'new',
    from: '',
    to: 'new',
    detail: 'Node',
    at: replacedAt,
  });
  push({
    assetKey: nodeKey(CLUSTER, REPLACED_NODE),
    assetName: REPLACED_NODE,
    kind: 'node',
    change: 'state',
    from: 'active',
    to: 'not_reporting',
    detail: '',
    at: replacedAt + 6 * MINUTE,
  });
  push({
    assetKey: nodeKey(CLUSTER, REPLACED_NODE),
    assetName: REPLACED_NODE,
    kind: 'node',
    change: 'health',
    from: 'healthy',
    to: 'critical',
    detail: 'No data for 10 min',
    at: replacedAt + 6 * MINUTE + 2_000,
  });
  push({
    assetKey: clusterKey(CLUSTER),
    assetName: CLUSTER,
    kind: 'cluster',
    change: 'health',
    from: 'healthy',
    to: 'warning',
    detail: '1 of 5 nodes critical',
    at: replacedAt + 6 * MINUTE + 3_000,
  });
  push({
    assetKey: clusterKey(CLUSTER),
    assetName: CLUSTER,
    kind: 'cluster',
    change: 'health',
    from: 'warning',
    to: 'healthy',
    detail: '',
    at: replacedAt + 62 * MINUTE,
  });

  // The batch host's disk crossed 85%.
  push({
    assetKey: hostKey(BATCH_HOST),
    assetName: BATCH_HOST,
    kind: 'host',
    change: 'health',
    from: 'healthy',
    to: 'warning',
    detail: 'Filesystem at 85%',
    at: hoursAgo(5, now) + 7 * MINUTE,
  });

  // Cloud: a new bucket, and an SFTP target failing its health check.
  if (connectionProject(AWS_CONNECTION_ID) === pid) {
    push({
      assetKey: 'cloud:aws_s3_bucket/arn:aws:s3:::harborline-exports-tmp',
      assetName: 'harborline-exports-tmp',
      kind: 'bucket',
      change: 'new',
      from: '',
      to: 'new',
      detail: 'S3 bucket',
      at: lastHealthScanBefore(hoursAgo(NEW_BUCKET_HOURS_AGO, now)),
    });
    const nlb =
      'cloud:aws_load_balancer/arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/net/partner-sftp/1d4e7a0c3b6f9e82';
    push({
      assetKey: nlb,
      assetName: 'partner-sftp',
      kind: 'load_balancer',
      change: 'health',
      from: 'healthy',
      to: 'warning',
      detail: '1 of 2 targets unhealthy',
      at: lastHealthScanBefore(hoursAgo(2, now)),
    });
  }

  const names = new Map(projects.all().map((p) => [p.id, p.name]));
  return out
    .sort((a, b) => b.at - a.at)
    .map((c) => ({
      id: uuidFrom(`change|${c.assetKey}|${c.change}|${c.at}`),
      projectId: c.projectId,
      projectName: names.get(c.projectId) ?? '',
      assetKey: c.assetKey,
      assetName: c.assetName,
      kind: c.kind,
      change: c.change,
      from: c.from,
      to: c.to,
      detail: c.detail,
      at: iso(c.at),
    }));
}

// --- cloud_resource_info / cloud_lb_targets ------------------------------------------

const CLOUD_METRICS: MetricInfo[] = [
  {
    name: 'cloud_resource_info',
    type: 'gauge',
    help: 'One per resource a cloud connection found; its identity, state and attributes as labels',
  },
  {
    name: 'cloud_lb_targets',
    type: 'gauge',
    help: "A load balancer's registered targets, by health",
  },
];

export function cloudSeries(
  projectId: string,
  name: string,
  matchers: LabelMatcher[],
  from: number,
  to: number,
  now = Date.now(),
): RawSeries[] {
  const out: RawSeries[] = [];
  for (const resource of cloudResources()) {
    if (connectionProject(resource.connectionId) !== projectId) continue;
    const connection = cloudConnections.get(resource.connectionId)!;
    const step = connection.healthIntervalSeconds * 1000;
    const born =
      resource.ageDays < 1 ? hoursAgo(resource.ageDays * 24, now) : now - resource.ageDays * DAY;
    const start = Math.max(from, born, dataStart(now));
    const end = Math.min(to, now);
    const timestamps: number[] = [];
    for (let t = Math.ceil((start - 47_000) / step) * step + 47_000; t <= end; t += step) {
      timestamps.push(t);
    }
    if (!timestamps.length) continue;
    const series = (labels: Record<string, string>, value: number) => {
      const full = { __name__: name, ...labels, service_name: 'obzly-probe' };
      if (matchAll(full, matchers)) {
        out.push({ labels: full, timestamps, values: timestamps.map(() => value) });
      }
    };
    if (name === 'cloud_resource_info') {
      series(resourceLabels(resource, connection.healthIntervalSeconds), 1);
    } else if (name === 'cloud_lb_targets' && resource.targets) {
      const identity = resourceLabels(resource, connection.healthIntervalSeconds);
      for (const [health, count] of Object.entries(resource.targets)) {
        series(
          {
            health,
            cloud_connection_id: identity.cloud_connection_id,
            cloud_provider: identity.cloud_provider,
            cloud_account_id: identity.cloud_account_id,
            cloud_region: identity.cloud_region,
            cloud_resource_type: identity.cloud_resource_type,
            cloud_resource_id: identity.cloud_resource_id,
          },
          count,
        );
      }
    }
  }
  return out;
}

registerSeriesProvider({
  metrics: (projectId) =>
    cloudResources().some((r) => connectionProject(r.connectionId) === projectId)
      ? CLOUD_METRICS
      : [],
  series: (projectId, name, matchers, from, to) => cloudSeries(projectId, name, matchers, from, to),
});
