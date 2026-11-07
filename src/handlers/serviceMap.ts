// Service map: span-derived edges (parent service -> child service, from
// sampled traces) merged with network-derived ones, like the server does
// with OBI flow metrics. Postgres and Valkey aren't instrumented, so their
// edges come from the network only; instrumented edges carry both.
import type { ServiceMapEdge, ServiceMapNode, ServiceMapResponse } from '../../entity/serviceMap';
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
  sampledTraces(
    projectId,
    start,
    end,
    SAMPLE_BUDGET,
    (trace, weight) => {
      for (const span of trace.spans) {
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
  return { nodes, edges: outEdges };
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
