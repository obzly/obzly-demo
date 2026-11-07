// Incident sessions (Incidents screen), grouped the way the backend's
// correlation worker does it: ERROR logs and ERROR spans are bucketed per
// service into fixed 5-minute windows, and buckets of services that call
// each other merge when they share a trace id (trigger "trace_id_link").
//
// Incident windows are computed exactly from the generated logs and traces,
// so a session's signals are the real rows (the payments pool errors, the
// checkout timeouts, storefront's and ingress-nginx's 502s, all linked by
// trace). Between incidents, the odd cache timeout makes a small
// span-only session about once every hour or two.
import type { Session, SignalDetail } from '../../entity/correlation';
import { hashString, hex, mix } from '../lib/rng';
import { CALLS, dataStart, incidentsBetween, traceIdAt } from '../world';
import { slotLogs, slotOf } from './logs';
import {
  type GenTrace,
  LEAF_ERROR_RATE,
  buildCandidate,
  buildTrace,
  candidateInfo,
  candidatesInSlot,
  isoMicro,
  leafRoll,
  planTrace,
} from './traces';

export const BUCKET_MS = 5 * 60_000;
/** The worker runs once a minute: the newest minute has no sessions yet. */
const SETTLE_MS = 60_000;
/** The worker reads at most this many rows per service and stream. */
const PER_STREAM_LIMIT = 500;
const MAX_LOOKBACK = 30 * 24 * 3_600_000;

interface Signal {
  type: 'log' | 'span';
  service: string;
  at: number;
  traceId?: string;
  detail: SignalDetail;
}

export interface SessionWithSignals {
  session: Session;
  signals: SignalDetail[];
}

const connected = new Set<string>();
for (const [src, targets] of Object.entries(CALLS)) {
  for (const dst of targets) {
    connected.add(`${src}>${dst}`);
    connected.add(`${dst}>${src}`);
  }
}

function sessionId(projectId: string, bucket: number, index: string): string {
  const h = hex(mix(bucket, hashString(index), hashString(projectId)), 18);
  return `${bucket.toString(16).padStart(8, '0')}-${index}-4${h.slice(0, 3)}-8${h.slice(3, 6)}-${h.slice(6, 18)}`;
}

const isIncidentBucket = (bucket: number) =>
  incidentsBetween(bucket * BUCKET_MS, bucket * BUCKET_MS + BUCKET_MS - 1).length > 0;

function spanSignals(trace: GenTrace, service?: string): Signal[] {
  const out: Signal[] = [];
  for (const span of trace.spans) {
    if (span.status !== 'ERROR' || (service && span.service !== service)) continue;
    const startTime = isoMicro(span.start);
    out.push({
      type: 'span',
      service: span.service,
      at: span.start,
      traceId: trace.traceId,
      detail: {
        signalType: 'span',
        occurredAt: startTime,
        available: true,
        span: {
          name: span.name,
          serviceName: span.service,
          statusCode: span.status,
          traceId: trace.traceId,
          spanId: span.spanId,
          startTime,
        },
      },
    });
  }
  return out;
}

function toSession(
  projectId: string,
  bucket: number,
  index: string,
  services: string[],
  signals: Signal[],
  now: number,
): SessionWithSignals {
  services.sort();
  let start = Infinity;
  let end = -Infinity;
  let logs = 0;
  let spans = 0;
  for (const signal of signals) {
    start = Math.min(start, signal.at);
    end = Math.max(end, signal.at);
    if (signal.type === 'log') logs++;
    else spans++;
  }
  const trigger =
    services.length > 1 ? 'trace_id_link' : logs > 0 ? 'error_log' : 'span_error_status';
  // Created by the next worker pass after the last signal.
  const created = Math.min(
    now,
    Math.ceil((end + 1000) / 60_000) * 60_000 + 2000 + (mix(bucket, hashString(index)) % 5000),
  );
  return {
    session: {
      id: sessionId(projectId, bucket, index),
      projectId,
      serviceName: services[0],
      windowStart: isoMicro(start),
      windowEnd: isoMicro(end),
      triggerType: trigger,
      triggerSummary: `${logs} error log(s), ${spans} error span(s) across service(s): [${services.join(' ')}] (dimensional+temporal correlation only, not semantic/ML)`,
      createdAt: new Date(created).toISOString(),
    },
    signals: signals
      .map((signal) => signal.detail)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1)),
  };
}

/** One bucket's sessions, computed from every ERROR log and span in it. */
function exactSessions(projectId: string, bucket: number, now: number): SessionWithSignals[] {
  const start = bucket * BUCKET_MS;
  const end = Math.min(start + BUCKET_MS, now - SETTLE_MS);
  if (end <= start || start < dataStart(now)) return [];
  const byService = new Map<string, Signal[]>();
  const counts = new Map<string, number>();
  const add = (signal: Signal) => {
    const key = `${signal.type}:${signal.service}`;
    const count = counts.get(key) ?? 0;
    if (count >= PER_STREAM_LIMIT) return;
    counts.set(key, count + 1);
    const list = byService.get(signal.service) ?? [];
    list.push(signal);
    byService.set(signal.service, list);
  };
  for (let slot = slotOf(start); slot <= slotOf(end - 1); slot++) {
    for (const log of slotLogs(slot, projectId, now)) {
      if (log.ts < start || log.ts >= end || log.level !== 'error') continue;
      add({
        type: 'log',
        service: log.fields.service_name,
        at: log.ts,
        traceId: log.traceId,
        detail: {
          signalType: 'log',
          occurredAt: log.timestamp,
          available: true,
          log: { level: log.level, message: log.message, timestamp: log.timestamp },
        },
      });
    }
    for (const candidate of candidatesInSlot(slot, projectId, now)) {
      if (candidate.t0 < start || candidate.t0 >= end) continue;
      const info = candidateInfo(candidate);
      if (!info.errors) continue;
      for (const signal of spanSignals(buildCandidate(candidate, projectId, info.plan)))
        add(signal);
    }
  }
  if (!byService.size) return [];

  // Union services that share a trace id and call each other.
  const parent = new Map<string, string>([...byService.keys()].map((s) => [s, s]));
  const find = (s: string): string => {
    const p = parent.get(s)!;
    if (p === s) return s;
    const root = find(p);
    parent.set(s, root);
    return root;
  };
  const servicesByTrace = new Map<string, Set<string>>();
  for (const [service, signals] of byService) {
    for (const signal of signals) {
      if (!signal.traceId) continue;
      const set = servicesByTrace.get(signal.traceId) ?? new Set<string>();
      set.add(service);
      servicesByTrace.set(signal.traceId, set);
    }
  }
  for (const set of servicesByTrace.values()) {
    const members = [...set];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (!connected.has(`${members[i]}>${members[j]}`)) continue;
        const a = find(members[i]);
        const b = find(members[j]);
        if (a !== b) parent.set(a, b);
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const service of byService.keys()) {
    const root = find(service);
    groups.set(root, [...(groups.get(root) ?? []), service]);
  }
  return [...groups.values()]
    .map((services) => services.sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map((services, i) =>
      toSession(
        projectId,
        bucket,
        i.toString(16).padStart(4, '0'),
        services,
        services.flatMap((s) => byService.get(s) ?? []),
        now,
      ),
    );
}

/** Between incidents: now and then a cache timeout in one service. */
function backgroundSessions(projectId: string, bucket: number, now: number): SessionWithSignals[] {
  if (mix(bucket, hashString(projectId), 0xb6) % 30 !== 0) return [];
  const start = bucket * BUCKET_MS;
  if (start < dataStart(now) || start + BUCKET_MS > now - SETTLE_MS) return [];
  const want = 1 + (mix(bucket, 7) % 3);
  let service: string | undefined;
  const signals: Signal[] = [];
  let found = 0;
  for (let k = 0; k < 8000 && found < want; k++) {
    const t = start + (mix(bucket, k, 3) % BUCKET_MS);
    const traceId = traceIdAt(t, mix(bucket, k, 0x5e55));
    if (leafRoll(traceId) >= LEAF_ERROR_RATE) continue;
    const plan = planTrace(traceId);
    if (!plan.leaf || (service && plan.leaf !== service)) continue;
    service = plan.leaf;
    signals.push(...spanSignals(buildTrace(traceId, projectId, undefined, plan), service));
    found++;
  }
  if (!service || !signals.length) return [];
  return [toSession(projectId, bucket, 'b000', [service], signals, now)];
}

const cache = new Map<string, SessionWithSignals[]>();

function bucketSessions(projectId: string, bucket: number, now: number): SessionWithSignals[] {
  const key = `${projectId}:${bucket}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const sessions = isIncidentBucket(bucket)
    ? exactSessions(projectId, bucket, now)
    : backgroundSessions(projectId, bucket, now);
  if ((bucket + 1) * BUCKET_MS <= now - SETTLE_MS) {
    if (cache.size > 600) cache.clear();
    cache.set(key, sessions);
  }
  return sessions;
}

/** Sessions overlapping [from, to], newest window first. */
export function listSessions(
  projectId: string,
  from: number,
  to: number,
  limit: number,
  now = Date.now(),
): Session[] {
  const end = Math.min(to, now);
  const start = Math.max(from, end - MAX_LOOKBACK, dataStart(now));
  const out: Session[] = [];
  if (start > end) return out;
  for (
    let bucket = Math.floor(end / BUCKET_MS);
    bucket >= Math.floor(start / BUCKET_MS);
    bucket--
  ) {
    for (const { session } of bucketSessions(projectId, bucket, now)) {
      if (Date.parse(session.windowEnd) >= from && Date.parse(session.windowStart) <= to)
        out.push(session);
    }
    if (out.length >= limit) break;
  }
  return out
    .sort((a, b) => (a.windowStart < b.windowStart ? 1 : a.windowStart > b.windowStart ? -1 : 0))
    .slice(0, limit);
}

export function getSession(
  projectId: string,
  sessionId: string,
  now = Date.now(),
): SessionWithSignals | undefined {
  const match = /^([0-9a-f]{8})-[0-9a-fb]{4}-/.exec(sessionId);
  if (!match) return undefined;
  const bucket = parseInt(match[1], 16);
  return bucketSessions(projectId, bucket, now).find((s) => s.session.id === sessionId);
}
