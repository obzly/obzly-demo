// The traces area through its handlers: trace search and regeneration from
// an id, log <-> span id links, the service map and incident sessions.
import { describe, expect, it } from 'vitest';

import type { Session, SessionDetail } from '../entity/correlation';
import type { ServiceMapResponse } from '../entity/serviceMap';
import type { GetTraceResponse, ListTracesResponse, SpansStats } from '../entity/traces';
import { llmSpansBetween } from './gen/aiUsage';
import { slotLogs, slotOf } from './gen/logs';
import { aggregateSpanPanel } from './gen/traces';
import { register as registerServiceMap } from './handlers/serviceMap';
import { register as registerTraces } from './handlers/traces';
import { type DemoRequest, Router } from './router';
import { CALLS, HOUR, MINUTE, PROJECT_ID, incidentsBetween } from './world';

const router = new Router();
registerTraces(router);
registerServiceMap(router);

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const parsed = new URL(url, 'http://demo.test');
  const route = router.match(method, parsed.pathname);
  if (!route) throw new Error(`no route for ${method} ${parsed.pathname}`);
  const req: DemoRequest = {
    method,
    path: parsed.pathname,
    params: route.params,
    query: parsed.searchParams,
    body,
  };
  return (await route.handler(req)) as T;
}

const iso = (t: number) => new Date(t).toISOString();
const timed = async <T>(fn: () => Promise<T>) => {
  const started = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - started };
};

/** The most recent finished incident. */
function lastIncident() {
  const now = Date.now();
  const list = incidentsBetween(now - 7 * HOUR, now).filter((i) => i.end < now - 2 * MINUTE);
  return list[list.length - 1];
}

describe('traces', () => {
  it('links every traced log to a span with its span id', async () => {
    const slot = slotOf(Date.now() - 30 * MINUTE);
    const logs = [slot, slot + 1, slot + 2].flatMap((s) => slotLogs(s)).filter((l) => l.traceId);
    expect(logs.length).toBeGreaterThan(3);
    for (const log of logs) {
      const trace = await call<GetTraceResponse>(
        'GET',
        `/traces/query/get/${PROJECT_ID}/${log.traceId}`,
      );
      const span = trace.spans.find((s) => s.spanId === log.spanId);
      expect(span, `${log.template} ${log.traceId}`).toBeDefined();
      expect(span!.serviceName).toBe(log.fields.service_name);
      // The log was written while its span was running.
      expect(Date.parse(span!.startTime)).toBeLessThanOrEqual(log.ts);
      expect(Date.parse(span!.endTime)).toBeGreaterThanOrEqual(log.ts);
      expect(trace.spans[0].serviceName).toBe('ingress-nginx');
      expect(trace.spans[0].parentSpanId).toBeUndefined();
    }
  });

  it('lists traces newest first and regenerates them identically from the id', async () => {
    const now = Date.now();
    const { result, ms } = await timed(() =>
      call<ListTracesResponse>('POST', `/traces/query/list/${PROJECT_ID}`, {
        timeRange: { from: iso(now - HOUR), to: iso(now) },
        limit: 50,
      }),
    );
    expect(ms).toBeLessThan(400);
    expect(result.traces).toHaveLength(50);
    const starts = result.traces.map((t) => Date.parse(t.startTime));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    const first = result.traces[0];
    const trace = await call<GetTraceResponse>(
      'GET',
      `/traces/query/get/${PROJECT_ID}/${first.traceId}`,
    );
    expect(trace.spans).toHaveLength(first.spanCount);
    expect(trace.spans.filter((s) => s.statusCode === 'ERROR')).toHaveLength(first.errorCount);
    const again = await call<GetTraceResponse>(
      'GET',
      `/traces/query/get/${PROJECT_ID}/${first.traceId}`,
    );
    expect(again).toEqual(trace);
    // Every parent is in the trace, and children start within their parents.
    const byId = new Map(trace.spans.map((s) => [s.spanId, s]));
    for (const span of trace.spans) {
      if (!span.parentSpanId) continue;
      const parent = byId.get(span.parentSpanId);
      expect(parent).toBeDefined();
      expect(Date.parse(span.startTime)).toBeGreaterThanOrEqual(Date.parse(parent!.startTime));
    }
  });

  it('shows the incident: failing checkouts with the payments pool exhausted', async () => {
    const incident = lastIncident();
    const { result } = await timed(() =>
      call<ListTracesResponse>('POST', `/traces/query/list/${PROJECT_ID}`, {
        timeRange: { from: iso(incident.start + 5 * MINUTE), to: iso(incident.end - 5 * MINUTE) },
        serviceName: 'payments',
        errorsOnly: true,
        limit: 20,
      }),
    );
    expect(result.traces.length).toBe(20);
    for (const t of result.traces) {
      expect(t.errorCount).toBeGreaterThan(0);
      expect(t.services).toContain('payments');
      expect(t.rootName).toBe('POST /checkout');
    }
    const trace = await call<GetTraceResponse>(
      'GET',
      `/traces/query/get/${PROJECT_ID}/${result.traces[0].traceId}`,
    );
    const pool = trace.spans.find((s) => s.name === 'HikariDataSource.getConnection');
    expect(pool?.statusCode).toBe('ERROR');
    expect(pool?.events?.[0].attributes?.exception_type).toBe(
      'java.sql.SQLTransientConnectionException',
    );

    const slow = await call<ListTracesResponse>('POST', `/traces/query/list/${PROJECT_ID}`, {
      timeRange: { from: iso(incident.start), to: iso(incident.end) },
      minDurationMs: 2000,
      limit: 10,
    });
    expect(slow.traces.length).toBe(10);
    for (const t of slow.traces) expect(t.durationMs).toBeGreaterThanOrEqual(2000);
  });

  it('filters by operation and lists services and operations', async () => {
    const services = await call<{ services: string[] }>(
      'GET',
      `/traces/query/services/${PROJECT_ID}`,
    );
    expect(services.services).toContain('checkout');
    expect(services.services).not.toContain('postgres');
    const ops = await call<{ operations: string[] }>(
      'GET',
      `/traces/query/operations/${PROJECT_ID}?service=checkout`,
    );
    expect(ops.operations).toContain('SELECT shop.orders');
    expect(ops.operations).toContain('harborline.checkout.v1.CheckoutService/PlaceOrder');
    const now = Date.now();
    const list = await call<ListTracesResponse>('POST', `/traces/query/list/${PROJECT_ID}`, {
      timeRange: { from: iso(now - HOUR), to: iso(now) },
      serviceName: 'catalog',
      operationName: 'GET /products/{product_id}',
      limit: 10,
    });
    expect(list.traces.length).toBe(10);
    for (const t of list.traces) expect(t.rootName).toBe('GET /products/:id');
  });

  it('opens an LLM call as a trace around its gen_ai span', async () => {
    const now = Date.now();
    // Three days, so a failed call and an embeddings call are always among them.
    const calls = llmSpansBetween(PROJECT_ID, now - 72 * HOUR, now - 10 * MINUTE);
    const chat = calls.find((c) => c.operation === 'chat' && !c.isError)!;
    const failed = calls.find((c) => c.isError)!;
    const embed = calls.find((c) => c.operation === 'embeddings')!;
    for (const row of [chat, failed, embed]) {
      const trace = await call<GetTraceResponse>(
        'GET',
        `/traces/query/get/${PROJECT_ID}/${row.traceId}`,
      );
      const llm = trace.spans.find((s) => s.spanId === row.spanId)!;
      expect(llm.name).toBe(`${row.operation} ${row.model}`);
      expect(llm.serviceName).toBe(row.service);
      expect(Date.parse(llm.startTime)).toBe(row.timestamp);
      expect(llm.durationMs).toBeCloseTo(row.durationMs, 3);
      expect(llm.attributes?.gen_ai_request_model).toBe(row.model);
      expect(llm.attributes?.gen_ai_provider_name).toBe(row.provider);
      expect(llm.statusCode).toBe(row.isError ? 'ERROR' : 'UNSET');
      if (row.isError) expect(llm.attributes?.error_type).toBe(row.errorType);
      else expect(llm.attributes?.gen_ai_usage_input_tokens).toBe(row.inputTokens);
      expect(trace.spans[0].parentSpanId).toBeUndefined();
      expect(trace.spans.some((s) => s.attributes?.db_system_name === 'postgresql')).toBe(true);
    }
    const services = await call<{ services: string[] }>(
      'GET',
      `/traces/query/services/${PROJECT_ID}`,
    );
    expect(services.services).toContain('support-assistant');
    const ops = await call<{ operations: string[] }>(
      'GET',
      `/traces/query/operations/${PROJECT_ID}?service=support-assistant`,
    );
    expect(ops.operations).toContain('POST /v1/conversations/{conversation_id}/messages');
    const list = await call<ListTracesResponse>('POST', `/traces/query/list/${PROJECT_ID}`, {
      timeRange: { from: iso(now - 2 * HOUR), to: iso(now) },
      serviceName: 'support-assistant',
      limit: 5,
    });
    expect(list.traces.length).toBe(5);
    for (const t of list.traces) expect(t.rootServiceName).toBe('support-assistant');
  });

  it('reports span stats', async () => {
    const stats = await call<SpansStats>('GET', `/traces/query/stats/${PROJECT_ID}`);
    expect(stats.totalSpans).toBeGreaterThan(1_000_000);
    expect(stats.totalSizeMb).toBeGreaterThan(0);
  });

  it('aggregates span panels', () => {
    const now = Date.now();
    const range = { from: iso(now - 24 * HOUR), to: iso(now) };
    const started = performance.now();
    const counts = aggregateSpanPanel(
      PROJECT_ID,
      {
        id: 'p',
        title: 'Requests',
        type: 'line',
        source: 'spans',
        rootSpansOnly: true,
        metric: 'count',
        gridPos: { x: 0, y: 0, w: 6, h: 4 },
      },
      range,
    );
    expect(performance.now() - started).toBeLessThan(600);
    expect(counts.length).toBeGreaterThan(100);
    expect(counts.every((b) => b.timestamp && b.value >= 0)).toBe(true);

    const p95 = aggregateSpanPanel(
      PROJECT_ID,
      {
        id: 'q',
        title: 'p95',
        type: 'table',
        source: 'spans',
        metric: 'p95_duration_ms',
        groupField: 'service_name',
        gridPos: { x: 0, y: 0, w: 6, h: 4 },
      },
      range,
    );
    const services = p95.map((b) => b.groupKey);
    expect(services).toContain('payments');
    expect(p95.every((b) => b.timestamp === undefined)).toBe(true);
  });
});

describe('service map', () => {
  it('follows CALLS, with the databases seen only on the network', async () => {
    const now = Date.now();
    const { result: map, ms } = await timed(() =>
      call<ServiceMapResponse>(
        'GET',
        `/service-map/${PROJECT_ID}?from=${iso(now - 24 * HOUR)}&to=${iso(now)}`,
      ),
    );
    expect(ms).toBeLessThan(600);
    const allowed = new Set(
      Object.entries(CALLS).flatMap(([src, dsts]) => dsts.map((d) => `${src}>${d}`)),
    );
    allowed.add('support-assistant>postgres');
    allowed.add('support-assistant>valkey');
    for (const edge of map.edges) expect(allowed.has(`${edge.src}>${edge.dst}`)).toBe(true);
    expect(map.nodes.find((n) => n.name === 'support-assistant')?.namespace).toBe('support');
    const pg = map.edges.find((e) => e.src === 'payments' && e.dst === 'postgres');
    expect(pg?.sources).toEqual(['network']);
    expect(pg?.callCount).toBeUndefined();
    const payments = map.edges.find((e) => e.src === 'checkout' && e.dst === 'payments');
    expect(payments?.sources).toEqual(['spans', 'network']);
    expect(payments!.callCount).toBeGreaterThan(100);
    expect(payments!.errorRate).toBeGreaterThan(0.01);
    const catalog = map.edges.find((e) => e.src === 'storefront' && e.dst === 'catalog');
    expect(catalog!.errorRate).toBeLessThan(0.02);
    expect(map.nodes.find((n) => n.name === 'checkout')?.namespace).toBe('shop');
    expect(map.nodes.find((n) => n.name === 'postgres')?.sources).toEqual(['network']);
  });
});

describe('correlation', () => {
  it('groups each incident window into a trace-linked checkout session', async () => {
    const now = Date.now();
    const { result, ms } = await timed(() =>
      call<{ sessions: Session[] }>(
        'GET',
        `/correlation/sessions/${PROJECT_ID}?from=${iso(now - 24 * HOUR)}&to=${iso(now)}&limit=50`,
      ),
    );
    expect(ms).toBeLessThan(1500);
    const sessions = result.sessions;
    const starts = sessions.map((s) => s.windowStart);
    expect([...starts].sort().reverse()).toEqual(starts);
    const linked = sessions.filter((s) => s.triggerType === 'trace_id_link');
    expect(linked.length).toBeGreaterThanOrEqual(12);
    expect(linked[0].serviceName).toBe('checkout');
    expect(linked[0].triggerSummary).toContain('payments');

    // The busiest window: the newest can be the tail end of an incident,
    // with a handful of errors and none of the pool-exhausted logs yet.
    const errorLogs = (s: Session) =>
      Number(/(\d+) error log/.exec(s.triggerSummary ?? '')?.[1] ?? 0);
    const busiest = linked.reduce((a, b) => (errorLogs(b) > errorLogs(a) ? b : a));
    const detail = await call<SessionDetail>(
      'GET',
      `/correlation/sessions/${PROJECT_ID}/${busiest.id}`,
    );
    expect(detail.session).toEqual(busiest);
    const logs = detail.signals.filter((s) => s.signalType === 'log').length;
    const spans = detail.signals.filter((s) => s.signalType === 'span').length;
    expect(busiest.triggerSummary).toContain(`${logs} error log(s), ${spans} error span(s)`);
    expect(detail.signals.some((s) => s.log?.message.includes('HikariPool-1'))).toBe(true);

    // Repeat reads are cached and identical.
    const again = await timed(() =>
      call<{ sessions: Session[] }>(
        'GET',
        `/correlation/sessions/${PROJECT_ID}?from=${iso(now - 24 * HOUR)}&to=${iso(now)}&limit=50`,
      ),
    );
    expect(again.result.sessions).toEqual(sessions);
    expect(again.ms).toBeLessThan(100);
  });
});
