// Service map: span-derived edges (parent service -> child service, from
// sampled traces) merged with network-derived ones, like the server does
// with OBI flow metrics. Postgres and Valkey aren't instrumented, so their
// edges come from the network only; instrumented edges carry both.
import type {
  ServiceMapEdge,
  ServiceMapHealth,
  ServiceMapNode,
  ServiceMapNodeType,
  ServiceMapResponse,
} from '../../entity/serviceMap';
import { SUPPORT_ASSISTANT, namespaceOf, resolveRange, sampledTraces } from '../gen/traces';
import type { Router } from '../router';
import { podsFor, workloadByService } from '../world';
import { requireProject } from './bootstrap';

const HOUR = 3_600_000;
/** Like the server's maxServiceMapLookback. */
const MAX_LOOKBACK = 24 * HOUR;
const SAMPLE_BUDGET = 200;

/** Request + response bytes per call, as OBI would count them. */
const BYTES_PER_CALL: Record<string, number> = {
  'ingress-nginx>storefront': 21_500,
  'storefront>catalog': 5_400,
  'storefront>search': 3_900,
  'storefront>checkout': 1_900,
  'storefront>auth': 640,
  'checkout>payments': 1_400,
  'checkout>inventory': 520,
};
const DB_BYTES: Record<string, number> = { postgres: 2_300, valkey: 410 };

interface EdgeAcc {
  src: string;
  dst: string;
  spans: boolean;
  calls: number;
  errors: number;
  durationSum: number;
  bytes: number;
}

interface NodeAcc {
  requests: number;
  errors: number;
  durations: [number, number][];
}

const NODE_TYPES: Record<string, ServiceMapNodeType> = { postgres: 'database', valkey: 'cache' };

/** The server's healthOf: 5%+ errors fail; 1%+ errors or a p95 of 800 ms+ degrade. */
function healthOf(errorRate: number, p95: number | undefined): ServiceMapHealth {
  if (errorRate >= 0.05) return 'failing';
  if (errorRate >= 0.01 || (p95 !== undefined && p95 >= 800)) return 'degraded';
  return 'ok';
}

function p95Of(values: [number, number][]): number | undefined {
  if (!values.length) return undefined;
  values.sort((a, b) => a[0] - b[0]);
  const total = values.reduce((sum, [, w]) => sum + w, 0);
  let seen = 0;
  for (const [value, weight] of values) {
    seen += weight;
    if (seen >= total * 0.95) return Math.round(value * 100) / 100;
  }
  return Math.round(values[values.length - 1][0] * 100) / 100;
}

export function buildServiceMap(projectId: string, from: number, to: number): ServiceMapResponse {
  const now = Date.now();
  const end = Math.min(to, now);
  const start = Math.max(from, end - MAX_LOOKBACK);
  const edges = new Map<string, EdgeAcc>();
  const edge = (src: string, dst: string) => {
    const key = `${src}>${dst}`;
    let acc = edges.get(key);
    if (!acc) {
      acc = { src, dst, spans: false, calls: 0, errors: 0, durationSum: 0, bytes: 0 };
      edges.set(key, acc);
    }
    return acc;
  };
  // RED per node: a service's entry spans, or the client spans calling an untraced peer.
  const red = new Map<string, NodeAcc>();
  const redOf = (name: string) => {
    let acc = red.get(name);
    if (!acc) red.set(name, (acc = { requests: 0, errors: 0, durations: [] }));
    return acc;
  };
  sampledTraces(
    projectId,
    start,
    end,
    SAMPLE_BUDGET,
    (trace, weight) => {
      for (const span of trace.spans) {
        if (span.kind === 'SERVER' || !span.parentSpanId) {
          const acc = redOf(span.service);
          acc.requests += weight;
          if (span.status === 'ERROR') acc.errors += weight;
          acc.durations.push([span.end - span.start, weight]);
        }
        if (span.parentService && span.parentService !== span.service) {
          const acc = edge(span.parentService, span.service);
          acc.spans = true;
          acc.calls += weight;
          if (span.status === 'ERROR') acc.errors += weight;
          acc.durationSum += (span.end - span.start) * weight;
          acc.bytes += (BYTES_PER_CALL[`${acc.src}>${acc.dst}`] ?? 1_200) * weight;
        }
        const db = span.attrs.db_system_name;
        if (span.kind === 'CLIENT' && (db === 'postgresql' || db === 'valkey')) {
          const target = db === 'postgresql' ? 'postgres' : 'valkey';
          edge(span.service, target).bytes += DB_BYTES[target] * weight;
          const acc = redOf(target);
          acc.requests += weight;
          if (span.status === 'ERROR') acc.errors += weight;
          acc.durations.push([span.end - span.start, weight]);
        }
      }
    },
    now,
  );

  const sources = new Map<string, Set<'spans' | 'network'>>();
  const touch = (name: string, source: 'spans' | 'network') => {
    const set = sources.get(name) ?? new Set();
    set.add(source);
    sources.set(name, set);
  };
  const outEdges: ServiceMapEdge[] = [];
  for (const acc of [...edges.values()].sort((a, b) =>
    a.src === b.src ? (a.dst < b.dst ? -1 : 1) : a.src < b.src ? -1 : 1,
  )) {
    const out: ServiceMapEdge = {
      src: acc.src,
      dst: acc.dst,
      sources: acc.spans ? ['spans', 'network'] : ['network'],
      bytesTotal: Math.round(acc.bytes),
    };
    if (acc.spans) {
      const calls = Math.max(1, Math.round(acc.calls));
      out.callCount = calls;
      out.errorRate = acc.calls ? acc.errors / acc.calls : 0;
      out.avgLatencyMs = acc.calls ? Math.round((acc.durationSum / acc.calls) * 100) / 100 : 0;
    }
    for (const name of [acc.src, acc.dst]) {
      touch(name, 'network');
      if (acc.spans) touch(name, 'spans');
    }
    outEdges.push(out);
  }

  const nodes: ServiceMapNode[] = [...sources.keys()].sort().map((name) => {
    const set = sources.get(name)!;
    const node: ServiceMapNode = {
      name,
      sources: (['spans', 'network'] as const).filter((s) => set.has(s)),
    };
    const acc = red.get(name);
    const type = NODE_TYPES[name] ?? (set.has('spans') || acc ? 'service' : undefined);
    if (type) node.type = type;
    if (acc && acc.requests > 0) {
      node.requests = Math.round(acc.requests);
      node.errors = Math.round(acc.errors);
      node.errorRate = acc.errors / acc.requests;
      node.p95LatencyMs = p95Of(acc.durations);
      node.health = healthOf(node.errorRate, node.p95LatencyMs);
    }
    const workload = workloadByService.get(name);
    if (name === SUPPORT_ASSISTANT.service) node.namespace = namespaceOf(name);
    if (workload) {
      node.namespace = workload.namespace;
      // Deployment and node come from span resource attributes only.
      if (set.has('spans')) {
        if (workload.kind === 'deployment') node.deployment = workload.name;
        node.node = podsFor(workload, end)[0]?.node;
      }
    }
    return node;
  });
  return { nodes, edges: outEdges, windowSeconds: Math.round((end - start) / 1000) };
}

export function register(r: Router) {
  r.get('/service-map/:pid', (req) => {
    const project = requireProject(req.params.pid);
    const { from, to } = resolveRange(
      { from: req.query.get('from') ?? undefined, to: req.query.get('to') ?? undefined },
      HOUR,
    );
    return buildServiceMap(project.id, from, to);
  });
}
