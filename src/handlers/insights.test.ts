// The Obzly 1.2 pages: project Overview (trace summary, service errors,
// alerts summary, ingestion status), Logs insights (patterns, explain,
// volume, health map, anomaly counts), Web analytics, log panel measures and
// notification templates.
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AlertRule,
  AlertsSummary,
  IncidentNotificationSettings,
  MessageTemplatesView,
  RuleActivityResponse,
  TemplatePreviewResponse,
} from '../../entity/alerting';
import type { ListSessionsResponse, SessionImpact } from '../../entity/correlation';
import type { AggregationBucket } from '../../entity/dashboards';
import type { IngestionStatus } from '../../entity/projects';
import type {
  ExplainResponse,
  HealthMapResponse,
  PatternChangesResponse,
  PatternTrendsResponse,
  VolumeResponse,
} from '../../entity/query';
import type { ServiceMapResponse } from '../../entity/serviceMap';
import type { ServiceErrorsResponse, TraceSummaryResponse } from '../../entity/traces';
import type { UserDetail, UsersSummary } from '../../entity/users';
import type { WebAnalyticsReport, WebAnalyticsSettings } from '../../entity/webAnalytics';
import { resetDemo } from '../store';
import { PROJECT_ID, incidentStart } from '../world';
import { call } from './admin.testkit';
import { buildRouter } from './index';

const router = buildRouter();
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
const lastHours = (hours: number) => ({
  from: iso(Date.now() - hours * HOUR),
  to: iso(Date.now()),
});

afterEach(() => resetDemo());

describe('overview', () => {
  it('summarises root spans now and before, with trends', async () => {
    const summary = await call<TraceSummaryResponse>(
      router,
      'POST',
      `/traces/query/summary/${PROJECT_ID}`,
      { timeRange: lastHours(24) },
    );
    expect(summary.rootSpansOnly).toBe(true);
    expect(summary.current.count).toBeGreaterThan(1000);
    expect(summary.previous.count).toBeGreaterThan(1000);
    expect(summary.current.p95Ms).toBeGreaterThan(summary.current.p50Ms!);
    expect(summary.countTrend.length).toBeGreaterThanOrEqual(30);
    expect(summary.matchingTraces).toBeLessThanOrEqual(summary.matchingTracesCap);
    const countOnly = await call<TraceSummaryResponse>(
      router,
      'POST',
      `/traces/query/summary/${PROJECT_ID}`,
      { timeRange: lastHours(1), countOnly: true, serviceName: 'payments' },
    );
    expect(countOnly.current.count).toBeNull();
    expect(countOnly.matchingTraces).toBeGreaterThan(0);
  });

  it('ranks services by failed entry spans, payments and checkout during an incident', async () => {
    const start = incidentStart(Date.now() - 6 * 3_600_000);
    const errors = await call<ServiceErrorsResponse>(
      router,
      'POST',
      `/traces/query/service-errors/${PROJECT_ID}`,
      { timeRange: { from: iso(start), to: iso(start + 22 * 60_000) }, limit: 6 },
    );
    expect(errors.services.length).toBeGreaterThan(2);
    expect(errors.services[0].errors).toBeGreaterThan(0);
    expect(['payments', 'checkout', 'storefront', 'ingress-nginx']).toContain(
      errors.services[0].serviceName,
    );
  });

  it('counts an incident session’s error signals per service', async () => {
    const { sessions } = await call<ListSessionsResponse>(
      router,
      'GET',
      `/correlation/sessions/${PROJECT_ID}?limit=20`,
    );
    const incident = sessions.find((s) => s.triggerType === 'trace_id_link') ?? sessions[0];
    const impact = await call<SessionImpact>(
      router,
      'GET',
      `/correlation/sessions/${PROJECT_ID}/${incident.id}/impact`,
    );
    expect(impact.sessionId).toBe(incident.id);
    expect(impact.services.length).toBeGreaterThan(0);
    const [top] = impact.services;
    expect(top.total).toBe(top.errorLogs + top.errorSpans);
  });

  it('gives the alerts header and each rule’s week', async () => {
    const summary = await call<AlertsSummary>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/alerts/summary`,
    );
    expect(summary.rules).toBeGreaterThan(5);
    expect(summary.silences).toBeGreaterThan(0);
    const activity = await call<RuleActivityResponse>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/alert-rules/activity`,
    );
    expect(activity.days).toHaveLength(7);
    expect(activity.rules.length).toBeGreaterThan(2);
    for (const rule of activity.rules) {
      expect(rule.fired).toHaveLength(7);
      expect(rule.firedTotal).toBe(rule.fired.reduce((a, b) => a + b, 0));
    }
  });

  it('lists the sources sending to the project', async () => {
    const status = await call<IngestionStatus>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/ingestion-status`,
    );
    const byName = new Map(status.sources.map((s) => [s.name, s]));
    expect(byName.get('checkout')?.health).toBe('sending');
    expect(byName.get('checkout')?.signals.map((s) => s.signal)).toEqual([
      'logs',
      'traces',
      'metrics',
    ]);
    expect(byName.get('legacy-fluent-bit')?.health).toBe('stopped');
    expect(status.sources[0].health).not.toBe('sending');
  });

  it('adds RED, type and health to service map nodes', async () => {
    const map = await call<ServiceMapResponse>(router, 'GET', `/service-map/${PROJECT_ID}`);
    const node = (name: string) => map.nodes.find((n) => n.name === name)!;
    expect(node('postgres').type).toBe('database');
    expect(node('valkey').type).toBe('cache');
    expect(node('checkout').type).toBe('service');
    expect(node('checkout').requests).toBeGreaterThan(0);
    expect(['ok', 'degraded', 'failing']).toContain(node('checkout').health);
    expect(map.windowSeconds).toBeGreaterThan(3000);
  });
});

describe('logs insights', () => {
  it('trends patterns per bucket, adding up with the rest', async () => {
    const trends = await call<PatternTrendsResponse>(
      router,
      'POST',
      `/logs/query/pattern-trends/${PROJECT_ID}`,
      { timeRange: lastHours(6) },
    );
    expect(trends.buckets.length).toBeLessThanOrEqual(60);
    expect(trends.patterns.length).toBeGreaterThan(10);
    const listed = trends.patterns.reduce((sum, p) => sum + p.count, 0);
    const other = trends.other.reduce((a, b) => a + b, 0);
    expect(listed + other).toBe(trends.total);
    for (const p of trends.patterns) expect(p.series).toHaveLength(trends.buckets.length);
  });

  it('explains an incident by the payments service', async () => {
    const start = incidentStart(Date.now() - 6 * 3_600_000);
    const explain = await call<ExplainResponse>(
      router,
      'POST',
      `/logs/query/explain/${PROJECT_ID}`,
      {
        current: { from: iso(start + 5 * 60_000), to: iso(start + 18 * 60_000) },
        baseline: { from: iso(start - 2 * HOUR), to: iso(start - 10 * 60_000) },
      },
    );
    expect(explain.fields.length).toBeGreaterThan(0);
    const values = explain.fields.map((f) => `${f.field}=${f.value}`);
    expect(values.some((v) => /payments|postgres|checkout|level=error/.test(v))).toBe(true);
  });

  it('shows volume by day, level and the noisiest patterns', async () => {
    const volume = await call<VolumeResponse>(router, 'POST', `/logs/query/volume/${PROJECT_ID}`, {
      days: 14,
    });
    expect(volume.days).toHaveLength(14);
    expect(volume.services[0].counts).toHaveLength(14);
    expect(volume.services.some((s) => s.other)).toBe(true);
    expect(volume.noisy[0].service).toBe('ingress-nginx');
    expect(volume.bytesPerLine).toBeGreaterThan(0);
  });

  it('maps workloads by namespace', async () => {
    const map = await call<HealthMapResponse>(
      router,
      'POST',
      `/logs/query/health-map/${PROJECT_ID}`,
      { timeRange: lastHours(1), groupBy: 'k8s' },
    );
    expect(map.groups.map((g) => g.name)).toContain('shop');
    const shop = map.groups.find((g) => g.name === 'shop')!;
    expect(shop.tiles.map((t) => t.name)).toContain('checkout');
  });

  it('counts anomalies only, unless the query searches messages', async () => {
    const body = {
      current: lastHours(1),
      baseline: { from: iso(Date.now() - 25 * HOUR), to: iso(Date.now() - HOUR) },
      countOnly: true,
    };
    const counted = await call<PatternChangesResponse>(
      router,
      'POST',
      `/logs/query/changes/${PROJECT_ID}`,
      body,
    );
    expect(counted.counted).toBe(true);
    expect(counted.changes).toEqual([]);
    const search = await call<PatternChangesResponse>(
      router,
      'POST',
      `/logs/query/changes/${PROJECT_ID}`,
      {
        ...body,
        query: {
          type: 'condition',
          condition: { field: 'message', operator: 'contains', value: 'x' },
        },
      },
    );
    expect(search.counted).toBe(false);
  });

  it('computes log panel measures, top groups and log bands', async () => {
    const run = (panel: Record<string, unknown>) =>
      call<{ buckets: AggregationBucket[] }>(
        router,
        'POST',
        `/projects/dashboards/${PROJECT_ID}/query`,
        {
          panel: { id: 'p', title: '', gridPos: { x: 0, y: 0, w: 1, h: 1 }, ...panel },
          timeRange: lastHours(2),
        },
      );
    const p95 = await run({ type: 'stat', measure: 'p95', measureField: 'duration_ms' });
    expect(p95.buckets[0].value).toBeGreaterThan(0);
    const top = await run({
      type: 'line',
      bucketMs: 600_000,
      groupField: 'service_name',
      topGroups: 3,
    });
    expect(new Set(top.buckets.map((b) => b.groupKey)).size).toBe(3);
    const bands = await run({
      type: 'line',
      bucketMs: 600_000,
      groupField: 'duration_ms',
      groupBands: 'log',
    });
    for (const b of bands.buckets) expect(Number.isFinite(Number(b.groupKey))).toBe(true);
    await expect(run({ type: 'stat', measure: 'avg' })).rejects.toThrow(/measureField/);
  });
});

describe('web analytics', () => {
  it('reports the ingress access logs with countries and DB-IP attribution', async () => {
    const report = await call<WebAnalyticsReport>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/web-analytics/report?from=${iso(Date.now() - 24 * HOUR)}`,
    );
    expect(report.bucketSeconds).toBe(3600);
    expect(report.totals.requests).toBeGreaterThan(10_000);
    expect(report.previous?.requests).toBeGreaterThan(10_000);
    expect(report.series.length).toBeGreaterThanOrEqual(24);
    expect(report.panels.countries.length).toBeGreaterThan(8);
    expect(report.panels.ips[0].key).toMatch(/\/(24|48)$/);
    expect(report.geo.attribution).toBe('IP geolocation by DB-IP');
    expect(report.heatmap.length).toBeGreaterThan(100);
    const statusTotal = report.panels.status.reduce((sum, r) => sum + r.hits, 0);
    expect(statusTotal).toBe(report.totals.requests);
  });

  it('saves settings and follows them in the report', async () => {
    const saved = await call<WebAnalyticsSettings>(
      router,
      'PUT',
      `/projects/${PROJECT_ID}/web-analytics/settings`,
      { ipMode: 'full', geoEnabled: false },
    );
    expect(saved.ipMode).toBe('full');
    const report = await call<WebAnalyticsReport>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/web-analytics/report?from=${iso(Date.now() - 15 * 60_000)}`,
    );
    expect(report.rollups.used).toBe(false);
    expect(report.panels.countries).toEqual([]);
    expect(report.panels.ips[0].key).not.toMatch(/\//);
  });
});

describe('users', () => {
  it('summarises accounts and filters the list', async () => {
    const summary = await call<UsersSummary>(router, 'GET', '/users/summary');
    expect(summary.total).toBe(summary.activeAccounts + summary.invited + summary.deactivated);
    const invited = await call<{ users: { email: string }[] }>(
      router,
      'GET',
      '/users?status=INVITED',
    );
    expect(invited.users).toHaveLength(summary.invited);
    const admins = await call<{ total: number }>(router, 'GET', '/users?role=ADMIN');
    expect(admins.total).toBe(summary.admins);
  });

  it('details a SCIM-provisioned user', async () => {
    const list = await call<{ users: { id: string; email: string }[] }>(
      router,
      'GET',
      '/users?query=hana',
    );
    const detail = await call<UserDetail>(router, 'GET', `/users/${list.users[0].id}/detail`);
    expect(detail.provisionedBy?.name).toBe('IdP provisioning');
    expect(detail.organizations[0].teams).toContain('Shop engineering');
    expect(detail.siteAccess.length).toBeGreaterThan(0);
  });
});

describe('notification templates and incident notifications', () => {
  it('previews the built-in templates of every kind without errors', async () => {
    for (const kind of ['email', 'slack', 'pagerduty', 'webhook'] as const) {
      const { templates } = await call<MessageTemplatesView>(
        router,
        'GET',
        '/settings/message-templates',
      );
      const view = templates.find((t) => t.kind === kind)!;
      const preview = await call<TemplatePreviewResponse>(
        router,
        'POST',
        '/settings/message-templates/preview',
        { kind, subject: view.defaultSubject, body: view.defaultBody },
      );
      expect(preview.errors, kind).toEqual([]);
      expect(preview.samples).toHaveLength(8);
      const critical = preview.samples[0];
      if (kind === 'email') {
        expect(critical.subject).toBe(
          '\u{1F4E3}❗\u{1F525} [FIRING] Critical: High error rate on checkout',
        );
        expect(critical.text).toContain('Value 0.0734 (> 0.05)');
        expect(critical.text).toContain('team=payments <oncall> & "night"');
        expect(critical.text).toContain('tab=alerts');
      }
      if (kind === 'slack') {
        expect(critical.color).toBe('#DC2626');
        expect(critical.text).toContain('payments &lt;oncall&gt; &amp;');
        const incident = preview.samples.find((s) => s.key === 'incident-open')!;
        expect(incident.text).toContain('• checkout: 11 errors');
      }
      if (kind === 'webhook') expect(JSON.parse(critical.body!).severity).toBe('critical');
    }
  });

  it('reports template errors with their line and refuses to save them', async () => {
    const body = 'first line\n{{.Rule.Name}}\n{{nosuch .Status}}';
    const preview = await call<TemplatePreviewResponse>(
      router,
      'POST',
      '/settings/message-templates/preview',
      { kind: 'slack', subject: '', body },
    );
    expect(preview.errors[0]).toMatchObject({ field: 'body', line: 3 });
    expect(preview.errors[0].message).toContain('"nosuch" not defined');
    const refused = (await call(router, 'PUT', '/settings/message-templates/slack', {
      subject: '',
      body,
    })) as Response;
    expect(refused.status).toBe(400);
    const saved = await call<MessageTemplatesView>(
      router,
      'PUT',
      '/settings/message-templates/pagerduty',
      {
        subject: '',
        body: '[{{upper .Status}}] {{.Rule.Name}} ({{.SeverityKey}})',
      },
    );
    expect(saved.templates.find((t) => t.kind === 'pagerduty')?.isDefault).toBe(false);
    const reset = await call<MessageTemplatesView>(
      router,
      'DELETE',
      '/settings/message-templates/pagerduty',
    );
    expect(reset.templates.find((t) => t.kind === 'pagerduty')?.isDefault).toBe(true);
  });

  it('keeps a project’s incident notification settings', async () => {
    const current = await call<IncidentNotificationSettings>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/incident-notifications`,
    );
    expect(current.notifyOpen).toBe(true);
    const saved = await call<IncidentNotificationSettings>(
      router,
      'PUT',
      `/projects/${PROJECT_ID}/incident-notifications`,
      { ...current, minSignals: 10, severity: 'critical' },
    );
    expect(saved).toMatchObject({ minSignals: 10, severity: 'critical' });
  });

  it('gives rules a severity and a runbook', async () => {
    const rules = await call<AlertRule[]>(router, 'GET', `/projects/${PROJECT_ID}/alert-rules`);
    const checkout = rules.find((r) => r.name === 'Checkout 5xx rate')!;
    expect(checkout.severity).toBe('critical');
    expect(checkout.description).toContain('runbook');
  });

  it('creates write tokens and appends dashboard panels', async () => {
    const created = await call<{ accessToken: { scopes: string[] } }>(
      router,
      'POST',
      '/access-tokens',
      {
        name: 'agent',
        expiresInDays: 30,
        write: true,
      },
    );
    expect(created.accessToken.scopes).toContain('mcp:write');
    const {
      dashboards: [dashboard],
    } = await call<{ dashboards: { id: string }[] }>(
      router,
      'GET',
      `/projects/dashboards/${PROJECT_ID}`,
    );
    const added = await call<{ panel: { id: string; gridPos: { x: number; w: number } } }>(
      router,
      'POST',
      `/projects/dashboards/${PROJECT_ID}/${dashboard.id}/panels`,
      { tabId: '', panel: { title: 'Errors', type: 'stat', source: 'logs', gridPos: {} } },
    );
    expect(added.panel.id).not.toBe('');
    expect(added.panel.gridPos).toMatchObject({ x: 0, w: 6 });
  });
});
