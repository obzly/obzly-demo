// Data sources › ingestion status: every source sending to a project (a
// Kubernetes workload, a service on a host, a host), with health and recent
// rates per signal. Log rates come from the generated logs; spans and metric
// points from the same traffic curve.
import type {
  IngestionHealth,
  IngestionSignal,
  IngestionSource,
  IngestionStatus,
} from '../../entity/projects';
import { countLogs } from '../gen/logs';
import { SUPPORT_ASSISTANT, TRACED_SERVICES } from '../gen/traces';
import { hashString, hex } from '../lib/rng';
import type { Router } from '../router';
import { BATCH_HOST, CLUSTER, PROJECT_ID, WORKLOADS, dataStart, traffic } from '../world';
import { requireProject } from './bootstrap';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const QUIET_AFTER = 5 * MINUTE;
const STOPPED_AFTER = DAY;
const RATE_WINDOW = 15 * MINUTE;

/** Spans a traced service writes per log line, roughly. */
const SPANS_PER_LOG = 2.6;

const LANGUAGE_SOURCES: Record<string, string> = {
  go: 'lang-go',
  java: 'lang-java',
  python: 'lang-python',
  nodejs: 'lang-nodejs',
};
const SERVICE_SOURCES: Record<string, string> = {
  'ingress-nginx': 'nginx',
  postgres: 'postgresql',
  valkey: 'valkey',
  'otel-collector': 'kubernetes',
};
/** Metric points a minute per replica (30 s scrapes of each series). */
const METRIC_POINTS: Record<string, number> = {
  'ingress-nginx': 220,
  postgres: 380,
  valkey: 140,
  'otel-collector': 610,
};

const sourceId = (identity: string) => hex(hashString(identity), 32);

function healthOf(lastSeen: number, now: number): IngestionHealth {
  if (now - lastSeen >= STOPPED_AFTER) return 'stopped';
  if (now - lastSeen >= QUIET_AFTER) return 'quiet';
  return 'sending';
}

interface SignalPlan {
  signal: IngestionSignal;
  perMinute: number;
  firstSeen: number;
  lastSeen: number;
}

function source(
  now: number,
  base: Omit<IngestionSource, 'health' | 'firstSeen' | 'lastSeen' | 'signals'>,
  plans: SignalPlan[],
): IngestionSource {
  const signals = plans.map((p) => {
    const health = healthOf(p.lastSeen, now);
    const perMinute = health === 'sending' ? Math.round(p.perMinute * 10) / 10 : 0;
    return {
      signal: p.signal,
      health,
      firstSeen: new Date(p.firstSeen).toISOString(),
      lastSeen: new Date(p.lastSeen).toISOString(),
      recentCount: Math.round(perMinute * (RATE_WINDOW / MINUTE)),
      perMinute,
    };
  });
  const lastSeen = Math.max(...plans.map((p) => p.lastSeen));
  const rank: Record<IngestionHealth, number> = { sending: 0, quiet: 1, stopped: 2 };
  return {
    ...base,
    health: plans
      .map((p) => healthOf(p.lastSeen, now))
      .reduce((best, h) => (rank[h] < rank[best] ? h : best), 'stopped' as IngestionHealth),
    firstSeen: new Date(Math.min(...plans.map((p) => p.firstSeen))).toISOString(),
    lastSeen: new Date(lastSeen).toISOString(),
    signals,
  };
}

/** The nightly export runs 02:00-02:20 UTC: its last line is from the latest run. */
function nightlyLastSeen(now: number): number {
  const runEnd = Math.floor(now / DAY) * DAY + 140 * MINUTE;
  const runStart = runEnd - 20 * MINUTE;
  if (now >= runStart && now < runEnd) return now - 4_000;
  return now >= runEnd ? runEnd : runEnd - DAY;
}

export function ingestionStatus(projectId: string, now = Date.now()): IngestionStatus {
  // Any project but production gets a fraction of its volume (like the log generator).
  const staging = projectId !== PROJECT_ID;
  const scale = staging ? 0.08 : 1;
  const since = Math.max(dataStart(now), now - 30 * DAY);
  const recent = (offset: number) => now - 1_500 - (offset % 9_000);
  const logsPerMinute = new Map<string, number>();
  for (const groups of countLogs(
    projectId,
    now - RATE_WINDOW,
    now,
    RATE_WINDOW + 1,
    () => true,
    (log) => log.fields.service_name ?? '',
    45,
  ).values()) {
    for (const [service, count] of groups)
      logsPerMinute.set(service, (logsPerMinute.get(service) ?? 0) + count / 15);
  }

  const sources: IngestionSource[] = [];
  const workloads = staging
    ? WORKLOADS.filter((w) => ['storefront', 'checkout', 'payments', 'catalog'].includes(w.service))
    : WORKLOADS;
  for (const w of workloads) {
    const identity = `k8s\n${CLUSTER}\n${w.namespace}\n${w.kind}\n${w.name}`;
    const h = hashString(identity);
    const logs = logsPerMinute.get(w.service) ?? 0;
    const plans: SignalPlan[] = [
      { signal: 'logs', perMinute: logs, firstSeen: since, lastSeen: recent(h) },
    ];
    if (TRACED_SERVICES.includes(w.service)) {
      plans.push({
        signal: 'traces',
        perMinute: logs * SPANS_PER_LOG,
        firstSeen: since + 20 * MINUTE,
        lastSeen: recent(h >> 3),
      });
    }
    const points = METRIC_POINTS[w.service] ?? (w.language ? 160 : 0);
    if (points) {
      plans.push({
        signal: 'metrics',
        perMinute: points * w.replicas * scale * (0.95 + 0.1 * traffic(now)),
        firstSeen: since,
        lastSeen: recent(h >> 5),
      });
    }
    sources.push(
      source(
        now,
        {
          id: sourceId(identity),
          name: w.name,
          identifiedBy: 'k8s_workload',
          dataSource:
            SERVICE_SOURCES[w.service] ??
            (w.language ? LANGUAGE_SOURCES[w.language] : 'kubernetes'),
          location: {
            cluster: CLUSTER,
            namespace: w.namespace,
            workloadKind: w.kind,
            workload: w.name,
            serviceName: w.service,
            ...(w.language ? { sdkLanguage: w.language } : {}),
          },
        },
        plans,
      ),
    );
  }

  if (projectId === PROJECT_ID) {
    // The LLM-backed support chat: spans and gen_ai metrics, no logs.
    const assistant = `k8s\n${CLUSTER}\n${SUPPORT_ASSISTANT.namespace}\ndeployment\n${SUPPORT_ASSISTANT.deployment}`;
    sources.push(
      source(
        now,
        {
          id: sourceId(assistant),
          name: SUPPORT_ASSISTANT.deployment,
          identifiedBy: 'k8s_workload',
          dataSource: 'llm-app-otel',
          location: {
            cluster: CLUSTER,
            namespace: SUPPORT_ASSISTANT.namespace,
            workloadKind: 'deployment',
            workload: SUPPORT_ASSISTANT.deployment,
            serviceName: SUPPORT_ASSISTANT.service,
            sdkLanguage: 'python',
          },
        },
        [
          {
            signal: 'traces',
            perMinute: 14 * traffic(now),
            firstSeen: now - 12 * DAY,
            lastSeen: recent(77),
          },
          { signal: 'metrics', perMinute: 96, firstSeen: now - 12 * DAY, lastSeen: recent(31) },
        ],
      ),
    );
    // The nightly export on the batch VM, quiet between runs.
    const nightly = `service\n\nnightly-export\n${BATCH_HOST}`;
    const lastRun = nightlyLastSeen(now);
    sources.push(
      source(
        now,
        {
          id: sourceId(nightly),
          name: 'nightly-export',
          identifiedBy: 'service',
          dataSource: 'linux',
          location: { serviceName: 'nightly-export', host: BATCH_HOST },
        },
        [
          {
            signal: 'logs',
            perMinute: logsPerMinute.get('nightly-export') ?? 0,
            firstSeen: since,
            lastSeen: lastRun,
          },
        ],
      ),
    );
    // The VM itself: host metrics from its collector.
    sources.push(
      source(
        now,
        {
          id: sourceId(`host\n${BATCH_HOST}`),
          name: BATCH_HOST,
          identifiedBy: 'host',
          dataSource: 'linux',
          location: { host: BATCH_HOST },
        },
        [{ signal: 'metrics', perMinute: 84, firstSeen: since, lastSeen: recent(5) }],
      ),
    );
    // An old Fluent Bit shipper that was switched off three days ago.
    sources.push(
      source(
        now,
        {
          id: sourceId('source\nlegacy-fluent-bit'),
          name: 'legacy-fluent-bit',
          identifiedBy: 'obzly_source',
          dataSource: 'fluent-bit',
          location: { host: BATCH_HOST },
        },
        [
          {
            signal: 'logs',
            perMinute: 0,
            firstSeen: since,
            lastSeen: Math.floor((now - 3 * DAY - 5 * HOUR) / MINUTE) * MINUTE,
          },
        ],
      ),
    );
  }

  const rank: Record<IngestionHealth, number> = { stopped: 0, quiet: 1, sending: 2 };
  sources.sort((a, b) => rank[a.health] - rank[b.health] || a.name.localeCompare(b.name));
  return {
    sources,
    truncated: false,
    generatedAt: new Date(now).toISOString(),
    quietAfterMinutes: QUIET_AFTER / MINUTE,
    stoppedAfterHours: STOPPED_AFTER / HOUR,
    rateWindowMinutes: RATE_WINDOW / MINUTE,
  };
}

export function register(r: Router) {
  r.get('/projects/:id/ingestion-status', (req) =>
    ingestionStatus(requireProject(req.params.id).id),
  );
}
