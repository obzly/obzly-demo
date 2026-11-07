// Traces: search, a single trace, services, operations and stats, plus the
// incident sessions built from the same error logs and spans (correlation).
import type { ListTracesRequest } from '../../entity/traces';
import {
  getTrace,
  listTraces,
  operationsFor,
  resolveRange,
  spanStats,
  toSpanDtos,
  tracedServices,
} from '../gen/traces';
import { getSession, listSessions } from '../gen/tracesCorrelation';
import { DemoError, type Router } from '../router';
import { dataStart } from '../world';
import { requireProject } from './bootstrap';

const HOUR = 3_600_000;

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

  r.get('/traces/query/stats/:pid', (req) => spanStats(requireProject(req.params.pid).id));

  // --- correlation (Incidents) ---------------------------------------------

  r.get('/correlation/sessions/:pid', (req) => {
    const project = requireProject(req.params.pid);
    const { from, to } = resolveRange(queryRange(req.query), 30 * 24 * HOUR);
    const requested = Number(req.query.get('limit'));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    return { sessions: listSessions(project.id, from, to, limit) };
  });

  r.get('/correlation/sessions/:pid/:sessionId', (req) => {
    const project = requireProject(req.params.pid);
    const detail = getSession(project.id, req.params.sessionId);
    if (!detail) throw new DemoError(404, 'Incident session not found');
    return detail;
  });
}
