// Traces: search, a single trace, services, operations and stats, plus the
// incident sessions built from the same error logs and spans (correlation).
import type {
  ListTracesRequest,
  ServiceErrorsRequest,
  TraceSummaryRequest,
  TraceSummaryResponse,
  TraceSummaryTotals,
} from '../../entity/traces';
import { SLOT_MS, slotOf, walkLogs } from '../gen/logs';
import {
  type GenSpan,
  type GenTrace,
  buildCandidate,
  candidateInfo,
  candidatesInSlot,
  getTrace,
  listTraces,
  operationsFor,
  resolveRange,
  sampledTraces,
  spanStats,
  toSpanDtos,
  tracedServices,
} from '../gen/traces';
import { getSession, listSessions } from '../gen/tracesCorrelation';
import { DemoError, type Router } from '../router';
import { dataStart } from '../world';
import { requireProject } from './bootstrap';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** About this many points in a summary trend (the server's summaryTrendPoints). */
const TREND_POINTS = 30;
const MATCHING_TRACES_CAP = 10_000;
const SUMMARY_BUDGET = 240;

interface DurationAcc {
  count: number;
  errors: number;
  durations: [number, number][];
}

const newAcc = (): DurationAcc => ({ count: 0, errors: 0, durations: [] });

function percentile(values: [number, number][], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, w]) => sum + w, 0);
  let seen = 0;
  for (const [value, weight] of sorted) {
    seen += weight;
    if (seen >= total * p) return Math.round(value * 100) / 100;
  }
  return Math.round(sorted[sorted.length - 1][0] * 100) / 100;
}

function requiredRange(range: { from?: string; to?: string } | undefined) {
  const from = range?.from ? Date.parse(range.from) : NaN;
  const to = range?.to ? Date.parse(range.to) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    throw new DemoError(400, 'timeRange.from and timeRange.to are required, with from before to');
  return { from, to };
}

/**
 * The Traces summary tiles: root spans (or the chosen service's spans)
 * matching the filters, now and in the window before, with trends.
 */
function traceSummary(projectId: string, body: TraceSummaryRequest): TraceSummaryResponse {
  const { from, to } = requiredRange(body.timeRange);
  const span = Math.max(to - from, 1000);
  const stepMs = Math.max(1, Math.ceil(span / 1000 / TREND_POINTS)) * 1000;
  const rootOnly = !body.serviceName;
  const picks = (trace: GenTrace): GenSpan[] =>
    trace.spans.filter((s) => {
      if (rootOnly ? !!s.parentSpanId : s.service !== body.serviceName) return false;
      if (body.operationName && s.name !== body.operationName) return false;
      const duration = s.end - s.start;
      if (body.minDurationMs !== undefined && duration < body.minDurationMs) return false;
      if (body.maxDurationMs !== undefined && duration > body.maxDurationMs) return false;
      return !body.errorsOnly || s.status === 'ERROR';
    });

  const firstIndex = Math.floor(from / stepMs);
  const slots = Math.floor(to / stepMs) - firstIndex + 1;
  const perSlot = Array.from({ length: slots }, newAcc);
  const current = newAcc();
  let matching = 0;
  const budget = Math.max(1, Math.floor(SUMMARY_BUDGET / slots));
  for (let i = 0; i < slots; i++) {
    const start = Math.max(from, (firstIndex + i) * stepMs);
    const end = Math.min(to, (firstIndex + i + 1) * stepMs - 1);
    if (start > end) continue;
    sampledTraces(projectId, start, end, budget, (trace, weight) => {
      const spans = picks(trace);
      if (spans.length) matching += weight;
      for (const s of spans) {
        for (const acc of [perSlot[i], current]) {
          acc.count += weight;
          if (s.status === 'ERROR') acc.errors += weight;
          acc.durations.push([s.end - s.start, weight]);
        }
      }
    });
  }
  const matchingTraces = Math.round(matching);
  const response: TraceSummaryResponse = {
    current: { count: null, errors: null, p50Ms: null, p95Ms: null },
    previous: { count: null, errors: null, p50Ms: null, p95Ms: null },
    windowMinutes: span / 60_000,
    rootSpansOnly: rootOnly,
    stepMs,
    countTrend: [],
    errorRateTrend: [],
    p50Trend: [],
    p95Trend: [],
    matchingTraces: Math.min(matchingTraces, MATCHING_TRACES_CAP),
    matchingTracesCapped: matchingTraces > MATCHING_TRACES_CAP,
    matchingTracesCap: MATCHING_TRACES_CAP,
  };
  if (body.countOnly) return response;

  const previous = newAcc();
  sampledTraces(projectId, from - span, from - 1, SUMMARY_BUDGET / 2, (trace, weight) => {
    for (const s of picks(trace)) {
      previous.count += weight;
      if (s.status === 'ERROR') previous.errors += weight;
      previous.durations.push([s.end - s.start, weight]);
    }
  });
  const totals = (acc: DurationAcc): TraceSummaryTotals => ({
    count: Math.round(acc.count),
    errors: Math.round(acc.errors),
    p50Ms: acc.count > 0 ? percentile(acc.durations, 0.5) : null,
    p95Ms: acc.count > 0 ? percentile(acc.durations, 0.95) : null,
  });
  response.current = totals(current);
  response.previous = totals(previous);
  for (const acc of perSlot) {
    response.countTrend.push(Math.round(acc.count));
    if (acc.count > 0) {
      response.errorRateTrend.push(Math.round((acc.errors / acc.count) * 100_000) / 1000);
      response.p50Trend.push(percentile(acc.durations, 0.5)!);
      response.p95Trend.push(percentile(acc.durations, 0.95)!);
    }
  }
  return response;
}

/** Services by failed entry spans (SERVER spans and trace roots), now and in the window before. */
function serviceErrors(projectId: string, body: ServiceErrorsRequest) {
  const range = requiredRange(body.timeRange);
  let from = range.from;
  const to = range.to;
  const clamped = to - from > 7 * DAY;
  if (clamped) from = to - 7 * DAY;
  const previousFrom = from - (to - from);
  const limit = Math.min(Math.max(Math.floor(body.limit || 10), 1), 50);
  const count = (start: number, end: number) => {
    const out = new Map<string, { requests: number; errors: number }>();
    sampledTraces(projectId, start, end, SUMMARY_BUDGET, (trace, weight) => {
      for (const s of trace.spans) {
        if (s.kind !== 'SERVER' && s.parentSpanId) continue;
        const acc = out.get(s.service) ?? { requests: 0, errors: 0 };
        acc.requests += weight;
        if (s.status === 'ERROR') acc.errors += weight;
        out.set(s.service, acc);
      }
    });
    return out;
  };
  const current = count(from, to);
  const previous = count(previousFrom, from - 1);
  const services = [...new Set([...current.keys(), ...previous.keys()])]
    .map((serviceName) => ({
      serviceName,
      requests: Math.round(current.get(serviceName)?.requests ?? 0),
      errors: Math.round(current.get(serviceName)?.errors ?? 0),
      previousRequests: Math.round(previous.get(serviceName)?.requests ?? 0),
      previousErrors: Math.round(previous.get(serviceName)?.errors ?? 0),
    }))
    .filter((s) => s.requests > 0)
    .sort(
      (a, b) =>
        b.errors - a.errors ||
        b.requests - a.requests ||
        a.serviceName.localeCompare(b.serviceName),
    )
    .slice(0, limit);
  const iso = (t: number) => new Date(t).toISOString();
  return { from: iso(from), to: iso(to), previousFrom: iso(previousFrom), clamped, services };
}

/** Error logs and error spans per service in an incident session's window, most first. */
function sessionImpact(projectId: string, sessionId: string) {
  const found = getSession(projectId, sessionId);
  if (!found) throw new DemoError(404, 'Incident session not found');
  const { session } = found;
  const start = Date.parse(session.windowStart);
  const end = Date.parse(session.windowEnd);
  const services = new Map<string, { errorLogs: number; errorSpans: number }>();
  const entry = (name: string) => {
    let acc = services.get(name);
    if (!acc) services.set(name, (acc = { errorLogs: 0, errorSpans: 0 }));
    return acc;
  };
  walkLogs(projectId, start, end, 'asc', (log) => {
    if (log.level === 'error') entry(log.fields.service_name ?? 'unknown').errorLogs++;
    return true;
  });
  const now = Date.now();
  for (let slot = slotOf(start); slot <= slotOf(end); slot++) {
    for (const candidate of candidatesInSlot(slot, projectId, now, false)) {
      if (candidate.t0 < start || candidate.t0 > end) continue;
      const info = candidateInfo(candidate);
      if (!info.errors) continue;
      for (const s of buildCandidate(candidate, projectId, info.plan).spans) {
        if (s.status === 'ERROR' && s.start >= start && s.start <= end + SLOT_MS)
          entry(s.service).errorSpans++;
      }
    }
  }
  return {
    sessionId: session.id,
    windowStart: session.windowStart,
    windowEnd: session.windowEnd,
    services: [...services.entries()]
      .map(([serviceName, acc]) => ({ serviceName, ...acc, total: acc.errorLogs + acc.errorSpans }))
      .sort((a, b) => b.total - a.total || a.serviceName.localeCompare(b.serviceName)),
  };
}

const optionalNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const queryRange = (query: URLSearchParams) => ({
  from: query.get('from') ?? undefined,
  to: query.get('to') ?? undefined,
});

/** True when the range ends before the demo's data starts (nothing to list). */
function beforeData(query: URLSearchParams) {
  const to = query.get('to');
  return to !== null && Date.parse(to) < dataStart();
}

export function register(r: Router) {
  r.post('/traces/query/list/:pid', (req) => {
    const project = requireProject(req.params.pid);
    const body = (req.body ?? {}) as ListTracesRequest;
    const { from, to } = resolveRange(body.timeRange, HOUR);
    const limit = Math.min(Math.max(Math.floor(body.limit || 20), 1), 1000);
    return {
      traces: listTraces(project.id, {
        from,
        to,
        serviceName: body.serviceName || undefined,
        operationName: body.operationName || undefined,
        minDurationMs: optionalNumber(body.minDurationMs),
        maxDurationMs: optionalNumber(body.maxDurationMs),
        errorsOnly: !!body.errorsOnly,
        limit,
      }),
    };
  });

  // Like the server: an unknown id is an empty trace, not an error.
  r.get('/traces/query/get/:pid/:traceId', (req) => {
    const project = requireProject(req.params.pid);
    const traceId = req.params.traceId.toLowerCase();
    const trace = getTrace(project.id, traceId);
    return { traceId, spans: trace ? toSpanDtos(trace) : [] };
  });

  r.get('/traces/query/services/:pid', (req) => {
    const project = requireProject(req.params.pid);
    return { services: beforeData(req.query) ? [] : tracedServices(project.id) };
  });

  r.get('/traces/query/operations/:pid', (req) => {
    requireProject(req.params.pid);
    const service = req.query.get('service') ?? '';
    return { operations: beforeData(req.query) ? [] : operationsFor(service) };
  });

  r.post('/traces/query/summary/:pid', (req) =>
    traceSummary(requireProject(req.params.pid).id, (req.body ?? {}) as TraceSummaryRequest),
  );

  r.post('/traces/query/service-errors/:pid', (req) =>
    serviceErrors(requireProject(req.params.pid).id, (req.body ?? {}) as ServiceErrorsRequest),
  );

  r.get('/traces/query/stats/:pid', (req) => spanStats(requireProject(req.params.pid).id));

  // --- correlation (Incidents) ---------------------------------------------

  r.get('/correlation/sessions/:pid', (req) => {
    const project = requireProject(req.params.pid);
    const { from, to } = resolveRange(queryRange(req.query), 30 * 24 * HOUR);
    const requested = Number(req.query.get('limit'));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    return { sessions: listSessions(project.id, from, to, limit) };
  });

  r.get('/correlation/sessions/:pid/:sessionId/impact', (req) =>
    sessionImpact(requireProject(req.params.pid).id, req.params.sessionId),
  );

  r.get('/correlation/sessions/:pid/:sessionId', (req) => {
    const project = requireProject(req.params.pid);
    const detail = getSession(project.id, req.params.sessionId);
    if (!detail) throw new DemoError(404, 'Incident session not found');
    return detail;
  });
}
