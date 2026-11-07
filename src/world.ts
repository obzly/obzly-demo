// The fictional company behind the demo: Harborline, a small online shop on a
// Kubernetes cluster. Every name, host and address here is made up; IPs come
// from the documentation ranges (RFC 5737), domains from example.com.
import { hashString, hex, mix } from './lib/rng';

export const DEMO_USER_ID = '7d1e2c3b-4a59-4f68-9e77-1c2b3a4d5e6f';
export const DEMO_TOKEN = 'demo-token-not-a-secret';
export const DEMO_USER = {
  id: DEMO_USER_ID,
  email: 'alex.rivera@harborline.example.com',
  name: 'Alex Rivera',
};

export const PROJECT_ID = '0b5f6c1e-3a2d-4e8f-9b7a-6c5d4e3f2a10';
export const PROJECT_NAME = 'Harborline Shop';
export const STAGING_PROJECT_ID = '1c6a7d2f-4b3e-4f90-8c8b-7d6e5f4a3b21';
export const STAGING_PROJECT_NAME = 'Harborline Staging';

export const CLUSTER = 'harborline-prod';
export const REGION = 'eu-west-1';

/** Demo time starts this long before "now"; older ranges are empty. */
export const DATA_DAYS = 14;

export interface Workload {
  service: string;
  namespace: string;
  kind: 'deployment' | 'statefulset' | 'daemonset';
  name: string;
  container: string;
  replicas: number;
  /** Share of the project's logs. */
  logWeight: number;
  language?: string;
  version: string;
}

export const WORKLOADS: Workload[] = [
  {
    service: 'ingress-nginx',
    namespace: 'ingress-nginx',
    kind: 'deployment',
    name: 'ingress-nginx-controller',
    container: 'controller',
    replicas: 2,
    logWeight: 30,
    version: '1.11.3',
  },
  {
    service: 'storefront',
    namespace: 'shop',
    kind: 'deployment',
    name: 'storefront',
    container: 'storefront',
    replicas: 3,
    logWeight: 12,
    language: 'nodejs',
    version: '4.18.2',
  },
  {
    service: 'checkout',
    namespace: 'shop',
    kind: 'deployment',
    name: 'checkout',
    container: 'checkout',
    replicas: 3,
    logWeight: 10,
    language: 'go',
    version: '2.31.0',
  },
  {
    service: 'payments',
    namespace: 'shop',
    kind: 'deployment',
    name: 'payments',
    container: 'payments',
    replicas: 2,
    logWeight: 7,
    language: 'java',
    version: '3.9.4',
  },
  {
    service: 'catalog',
    namespace: 'shop',
    kind: 'deployment',
    name: 'catalog',
    container: 'catalog',
    replicas: 2,
    logWeight: 9,
    language: 'python',
    version: '1.42.1',
  },
  {
    service: 'inventory',
    namespace: 'shop',
    kind: 'deployment',
    name: 'inventory',
    container: 'inventory',
    replicas: 2,
    logWeight: 6,
    language: 'go',
    version: '1.17.0',
  },
  {
    service: 'search',
    namespace: 'shop',
    kind: 'deployment',
    name: 'search',
    container: 'search',
    replicas: 2,
    logWeight: 6,
    language: 'python',
    version: '0.28.3',
  },
  {
    service: 'auth',
    namespace: 'identity',
    kind: 'deployment',
    name: 'auth',
    container: 'auth',
    replicas: 2,
    logWeight: 6,
    language: 'go',
    version: '5.2.0',
  },
  {
    service: 'postgres',
    namespace: 'data',
    kind: 'statefulset',
    name: 'postgres',
    container: 'postgres',
    replicas: 2,
    logWeight: 5,
    version: '16.4',
  },
  {
    service: 'valkey',
    namespace: 'data',
    kind: 'statefulset',
    name: 'valkey',
    container: 'valkey',
    replicas: 1,
    logWeight: 2,
    version: '8.0.1',
  },
  {
    service: 'otel-collector',
    namespace: 'observability',
    kind: 'daemonset',
    name: 'otel-collector',
    container: 'otel-collector',
    replicas: 4,
    logWeight: 2,
    version: '0.114.0',
  },
];

/** The one service outside Kubernetes: a nightly export on a VM. */
export const BATCH_HOST = 'batch-01.harborline.example.com';

export const NODES = [
  'ip-10-20-1-14.eu-west-1.compute.internal',
  'ip-10-20-2-37.eu-west-1.compute.internal',
  'ip-10-20-3-52.eu-west-1.compute.internal',
  'ip-10-20-1-88.eu-west-1.compute.internal',
];

export const workloadByService = new Map(WORKLOADS.map((w) => [w.service, w]));

export interface Pod {
  name: string;
  node: string;
  replicaSet?: string;
}

/**
 * A workload's current release changes at each deploy, so pod names (and the
 * replica set hash) change too, like a real rollout. The key is the latest
 * deploy's time (or a 4-day epoch when none is that recent).
 */
const releaseCache = new Map<string, number>();
export function releaseIndex(service: string, t: number): number {
  const key = `${service}:${Math.floor(t / 10_000)}`;
  const hit = releaseCache.get(key);
  if (hit !== undefined) return hit;
  const lookback = 4 * 24 * HOUR;
  const deploys = deploysFor(service, t - lookback, t);
  const release = deploys.length ? deploys[deploys.length - 1].time : Math.floor(t / lookback);
  if (releaseCache.size > 20_000) releaseCache.clear();
  releaseCache.set(key, release);
  return release;
}

export function podsFor(workload: Workload, t: number): Pod[] {
  const release = releaseIndex(workload.service, t);
  const rsHash = hex(mix(hashString(workload.name), release), 10).replace(/[0-9]/g, (d) =>
    'bcdfghjklm'.charAt(Number(d)),
  );
  const pods: Pod[] = [];
  for (let i = 0; i < workload.replicas; i++) {
    const node = NODES[(hashString(workload.name) + i) % NODES.length];
    if (workload.kind === 'statefulset') {
      pods.push({ name: `${workload.name}-${i}`, node });
    } else if (workload.kind === 'daemonset') {
      pods.push({
        name: `${workload.name}-${hex(mix(hashString(workload.name), i), 5)}`,
        node: NODES[i % NODES.length],
      });
    } else {
      const suffix = hex(mix(hashString(workload.name), release, i), 5);
      pods.push({
        name: `${workload.name}-${rsHash}-${suffix}`,
        node,
        replicaSet: `${workload.name}-${rsHash}`,
      });
    }
  }
  return pods;
}

// ---------------------------------------------------------------------------
// Time shape: a daily traffic curve and a recurring incident.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Traffic multiplier, ~0.35 at night to ~1.4 in the evening peak (UTC). */
export function traffic(t: number): number {
  const hour = (t % (24 * HOUR)) / HOUR;
  const day = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
  const weekday = new Date(t).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 0.8 : 1;
  return Math.max(0.3, (0.85 + 0.55 * day) * weekend);
}

/**
 * Every 6 hours a payments release exhausts its database pool for ~22
 * minutes: checkout errors, slow payments, Postgres connection errors. Gives
 * the alerts, anomalies, correlation and synthetics screens a story.
 */
export const INCIDENT_PERIOD = 6 * HOUR;
export const INCIDENT_OFFSET = 2 * HOUR + 10 * MINUTE;
export const INCIDENT_LENGTH = 22 * MINUTE;

export function incidentStart(t: number): number {
  return Math.floor((t - INCIDENT_OFFSET) / INCIDENT_PERIOD) * INCIDENT_PERIOD + INCIDENT_OFFSET;
}

/** 0 outside an incident, ramping to 1 at its peak. */
export function incidentLevel(t: number): number {
  const start = incidentStart(t);
  const into = t - start;
  if (into < 0 || into > INCIDENT_LENGTH) return 0;
  const ramp = Math.min(1, into / (3 * MINUTE), (INCIDENT_LENGTH - into) / (4 * MINUTE));
  return Math.max(0, ramp);
}

export function incidentsBetween(from: number, to: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let s = incidentStart(from); s <= to; s += INCIDENT_PERIOD) {
    if (s + INCIDENT_LENGTH >= from) out.push({ start: s, end: s + INCIDENT_LENGTH });
  }
  return out;
}

export interface Deploy {
  time: number;
  service: string;
}

/**
 * Rollouts: payments ships right before each incident; other services ship a
 * couple of times a day at fixed, seed-derived times.
 */
export function deploysFor(service: string, from: number, to: number): Deploy[] {
  const out: Deploy[] = [];
  if (service === 'payments') {
    for (let s = incidentStart(from); s <= to + INCIDENT_PERIOD; s += INCIDENT_PERIOD) {
      const time = s - 90_000;
      if (time >= from && time <= to) out.push({ time, service });
    }
    return out;
  }
  const workload = workloadByService.get(service);
  if (!workload || workload.kind !== 'deployment') return out;
  // Two deploy slots a day per service, offset by its name.
  const base = hashString(service);
  const DAY = 24 * HOUR;
  for (let day = Math.floor(from / DAY) - 1; day * DAY <= to; day++) {
    for (const slot of [0, 1]) {
      const r = mix(base, day, slot);
      if (r % 3 === 0) continue; // not every slot ships
      const time = day * DAY + (9 + slot * 6) * HOUR + (r % (5 * HOUR));
      if (time >= from && time <= to) out.push({ time, service });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Shared ids so logs, traces and the service map line up.
// ---------------------------------------------------------------------------

/** A trace id that carries its start time: the first 12 hex digits are the ms timestamp. */
export function traceIdAt(t: number, seed: number): string {
  return Math.floor(t).toString(16).padStart(12, '0').slice(-12) + hex(seed, 20);
}

export function traceTime(traceId: string): number {
  return parseInt(traceId.slice(0, 12), 16);
}

/** The span id a service's k-th span in a trace gets; logs reuse k = 0. */
export function spanIdFor(traceId: string, service: string, k = 0): string {
  return hex(mix(hashString(traceId), hashString(service), k), 16);
}

/** Calls between services: the service map and the traces follow these edges. */
export const CALLS: Record<string, string[]> = {
  'ingress-nginx': ['storefront'],
  storefront: ['catalog', 'search', 'checkout', 'auth'],
  checkout: ['payments', 'inventory', 'postgres', 'valkey'],
  payments: ['postgres'],
  catalog: ['postgres', 'valkey'],
  inventory: ['postgres'],
  search: ['valkey'],
  auth: ['postgres', 'valkey'],
};

export const CLIENT_IPS = [
  '203.0.113.12',
  '203.0.113.45',
  '203.0.113.77',
  '203.0.113.140',
  '203.0.113.201',
  '198.51.100.7',
  '198.51.100.23',
  '198.51.100.64',
  '198.51.100.150',
  '198.51.100.233',
  '192.0.2.10',
  '192.0.2.31',
  '192.0.2.99',
  '192.0.2.144',
  '192.0.2.250',
];

export const nowMs = () => Date.now();
export const dataStart = (now = Date.now()) => now - DATA_DAYS * 24 * HOUR;
export { HOUR, MINUTE };
