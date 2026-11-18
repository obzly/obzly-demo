import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AlertRule,
  AlertView,
  NotificationChannel,
  PreviewSeries,
  SettingsChannel,
  Silence,
} from '../../entity/alerting';
import { Router } from '../router';
import {
  CHANNEL_SRE_EMAIL,
  CHANNEL_WEBHOOK,
  RULE_CHECKOUT_5XX,
  RULE_PAYMENTS_P95,
  RULE_POSTGRES_CONNECTIONS,
  seedRules,
} from '../seed/alerting';
import { checkout5xx } from '../seed/dashboards';
import { resetDemo } from '../store';
import { MINUTE, PROJECT_ID, STAGING_PROJECT_ID, incidentsBetween } from '../world';
import { deriveAlerts, evaluateRule, register, sqlSamples } from './alerting';
import { fakeSql, resetFakeSql, setSqlResult } from './sql.testkit';

vi.mock('../gen/traces', () => ({
  aggregateSpanPanel: vi.fn(() => [
    { timestamp: '2026-11-07T10:00:00.000Z', value: 100 },
    { timestamp: '2026-11-07T10:01:00.000Z', value: 300 },
  ]),
}));
vi.mock('../query/promql', () => ({
  evaluatePromQL: vi.fn(() => ({
    resultType: 'vector',
    series: [
      { labels: { __name__: 'm', host_name: 'a' }, points: [{ timestamp: 'x', value: 0.95 }] },
      { labels: { __name__: 'm', host_name: 'b' }, points: [{ timestamp: 'x', value: 0.2 }] },
    ],
  })),
}));

vi.mock('../lib/duckdb', async () => (await import('./sql.testkit')).fakeDuckDB);

const router = new Router();
register(router);

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const route = router.match(method, path);
  if (!route) throw new Error(`no route for ${method} ${path}`);
  const result = await route.handler({
    method,
    path,
    params: route.params,
    query: new URLSearchParams(),
    body,
  });
  return JSON.parse(JSON.stringify(result ?? {}));
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

const p = `/projects/${PROJECT_ID}`;

/** The most recent incident that is fully over. */
function lastIncident() {
  const now = Date.now();
  return incidentsBetween(now - 13 * 3_600_000, now)
    .filter((i) => i.end + 10 * MINUTE < now)
    .pop()!;
}

const newRule = {
  name: 'Too many errors',
  source: 'logs',
  query: {
    logs: { type: 'condition', condition: { field: 'level', operator: 'equals', value: 'error' } },
  },
  comparison: '>',
  threshold: 5,
  windowSeconds: 300,
  intervalSeconds: 60,
  forSeconds: 0,
  repeatSeconds: 3600,
  labels: { severity: 'warning' },
  summary: '',
  channelIds: [CHANNEL_SRE_EMAIL],
};

beforeEach(() => {
  resetDemo();
  resetFakeSql();
});

describe('rules', () => {
  it('lists the seeded rules with a last evaluation for enabled ones', async () => {
    const rules = (await call('GET', `${p}/alert-rules`)) as AlertRule[];
    expect(rules.length).toBe(seedRules().length);
    expect(rules.every((r) => (r.enabled ? !!r.lastEvalAt : !r.lastEvalAt))).toBe(true);
    expect(new Set(rules.map((r) => r.source))).toEqual(
      new Set(['logs', 'traces', 'metrics', 'log_patterns']),
    );
    expect((await call('GET', `/projects/${STAGING_PROJECT_ID}/alert-rules`)) as unknown[]).toEqual(
      [],
    );
  });

  it('creates, updates and deletes a rule, validating like the backend', async () => {
    const created = (await call('POST', `${p}/alert-rules`, newRule)) as AlertRule;
    expect(created.enabled).toBe(true);
    const updated = (await call('PUT', `${p}/alert-rules/${created.id}`, {
      ...newRule,
      threshold: 9,
      enabled: false,
    })) as AlertRule;
    expect(updated.threshold).toBe(9);
    expect(updated.enabled).toBe(false);
    await call('DELETE', `${p}/alert-rules/${created.id}`);
    expect(await status(call('DELETE', `${p}/alert-rules/${created.id}`))).toBe(404);

    expect(await status(call('POST', `${p}/alert-rules`, { ...newRule, comparison: '=>' }))).toBe(
      400,
    );
    expect(await status(call('POST', `${p}/alert-rules`, { ...newRule, name: ' ' }))).toBe(400);
    expect(
      await status(call('POST', `${p}/alert-rules`, { ...newRule, labels: { alertname: 'x' } })),
    ).toBe(400);
    expect(
      await status(call('POST', `${p}/alert-rules`, { ...newRule, source: 'metrics', query: {} })),
    ).toBe(400);
    // The incident webhook belongs to the production project only.
    expect(
      await status(
        call('POST', `/projects/${STAGING_PROJECT_ID}/alert-rules`, {
          ...newRule,
          channelIds: [CHANNEL_WEBHOOK],
        }),
      ),
    ).toBe(400);
  });

  it('previews logs rules over the generated logs', async () => {
    const preview = (await call('POST', `${p}/alert-rules/preview`, {
      ...newRule,
      // Info logs, not errors: between incidents a 5-minute window may have no errors at all.
      query: {
        logs: {
          type: 'condition',
          condition: { field: 'level', operator: 'equals', value: 'info' },
        },
        groupBy: 'service_name',
      },
      threshold: 0,
    })) as PreviewSeries[];
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.every((s) => 'service_name' in s.labels && s.firing === s.value > 0)).toBe(true);
  });

  it('previews metrics and traces rules through their areas', async () => {
    const metrics = (await call('POST', `${p}/alert-rules/preview`, {
      ...newRule,
      source: 'metrics',
      query: { promql: 'avg by (host_name) (system_cpu_utilization)' },
      threshold: 0.85,
    })) as PreviewSeries[];
    expect(metrics).toEqual([
      { labels: { host_name: 'a' }, value: 0.95, firing: true },
      { labels: { host_name: 'b' }, value: 0.2, firing: false },
    ]);
    const traces = (await call('POST', `${p}/alert-rules/preview`, {
      ...newRule,
      source: 'traces',
      query: { serviceName: 'payments', metric: 'p95_duration_ms' },
      threshold: 150,
    })) as PreviewSeries[];
    // Timed buckets collapse to their mean for a duration metric.
    expect(traces).toEqual([{ labels: {}, value: 200, firing: true }]);
  });

  it('the Checkout 5xx rule crosses its threshold at an incident peak only', () => {
    const rule = seedRules().find((r) => r.id === RULE_CHECKOUT_5XX)!;
    expect(rule.query.logs).toEqual(checkout5xx());
    const incident = lastIncident();
    const peak = evaluateRule(PROJECT_ID, rule, incident.start + 12 * MINUTE)[0].value;
    const calm = evaluateRule(PROJECT_ID, rule, incident.start - 60 * MINUTE)[0].value;
    expect(peak).toBeGreaterThan(rule.threshold);
    expect(calm).toBeLessThanOrEqual(rule.threshold);
  });

  it('the sign-in failures rule stays quiet', () => {
    const rule = seedRules().find((r) => r.name === 'Sign-in failures spike')!;
    const incident = lastIncident();
    for (const t of [incident.start + 12 * MINUTE, incident.start - 3 * 60 * MINUTE]) {
      expect(evaluateRule(PROJECT_ID, rule, t)[0].value).toBeLessThanOrEqual(rule.threshold);
    }
  });
});

describe('alerts', () => {
  const incidentRules = [RULE_CHECKOUT_5XX, RULE_PAYMENTS_P95, RULE_POSTGRES_CONNECTIONS];

  it('the incident rules fire during an incident and resolve after it', () => {
    const incident = lastIncident();
    const firing = deriveAlerts(PROJECT_ID, incident.start + 12 * MINUTE);
    expect(firing.map((a) => a.ruleId).sort()).toEqual([...incidentRules].sort());
    expect(firing.every((a) => a.state === 'firing' && !!a.firedAt && !a.resolvedAt)).toBe(true);

    const pending = deriveAlerts(PROJECT_ID, incident.start + 3 * MINUTE + 1);
    expect(pending.find((a) => a.ruleId === RULE_PAYMENTS_P95)?.state).toBe('pending');

    const after = deriveAlerts(PROJECT_ID, incident.end + 30 * MINUTE);
    expect(after.every((a) => a.state === 'resolved')).toBe(true);
    for (const alert of after) {
      expect(Date.parse(alert.resolvedAt!)).toBeGreaterThan(Date.parse(alert.firedAt!));
      expect(alert.labels.alertname).toBe(alert.ruleName);
    }
  });

  it('lists current alerts and drops those of disabled rules', async () => {
    const alerts = (await call('GET', `${p}/alerts`)) as AlertView[];
    expect(alerts).toHaveLength(3);
    const rule = ((await call('GET', `${p}/alert-rules`)) as AlertRule[]).find(
      (r) => r.id === RULE_CHECKOUT_5XX,
    )!;
    await call('PUT', `${p}/alert-rules/${rule.id}`, { ...rule, enabled: false });
    const after = (await call('GET', `${p}/alerts`)) as AlertView[];
    expect(after.map((a) => a.ruleId)).not.toContain(RULE_CHECKOUT_5XX);
  });
});

describe('silences', () => {
  it('lists active and upcoming silences, creates and deletes them', async () => {
    const seeded = (await call('GET', `${p}/silences`)) as Silence[];
    expect(seeded).toHaveLength(3);
    expect(seeded.filter((s) => s.mcpClient)).toHaveLength(1);
    const created = (await call('POST', `${p}/silences`, {
      matchers: [{ name: 'team', value: 'checkout' }],
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      comment: 'deploy',
    })) as Silence;
    expect(((await call('GET', `${p}/silences`)) as Silence[]).length).toBe(4);
    await call('DELETE', `${p}/silences/${created.id}`);
    // Expiring ends it now and keeps it on record; the list shows current ones only.
    const mcp = seeded.find((s) => s.mcpClient)!;
    const expired = (await call('POST', `${p}/silences/${mcp.id}/expire`)) as Silence;
    expect(Date.parse(expired.endsAt)).toBeLessThanOrEqual(Date.now());
    expect(((await call('GET', `${p}/silences`)) as Silence[]).length).toBe(2);
    expect(await status(call('POST', `${p}/silences/${mcp.id}/expire`))).toBe(409);
    expect(
      await status(
        call('POST', `${p}/silences`, {
          matchers: [{ name: 'team', value: 'x' }],
          endsAt: new Date(Date.now() - 1000).toISOString(),
          comment: '',
        }),
      ),
    ).toBe(400);
    expect(
      await status(
        call('POST', `${p}/silences`, {
          matchers: [],
          endsAt: new Date(Date.now() + 1e6).toISOString(),
        }),
      ),
    ).toBe(400);
  });
});

describe('channels and settings', () => {
  it('lists project channels and tests them without sending', async () => {
    const prod = (await call('GET', `${p}/notification-channels`)) as NotificationChannel[];
    const staging = (await call(
      'GET',
      `/projects/${STAGING_PROJECT_ID}/notification-channels`,
    )) as NotificationChannel[];
    expect(prod.map((c) => c.id)).toContain(CHANNEL_WEBHOOK);
    expect(staging.map((c) => c.id)).not.toContain(CHANNEL_WEBHOOK);
    expect(prod.every((c) => !('config' in c))).toBe(true);
    const result = (await call('POST', `${p}/notification-channels/${CHANNEL_SRE_EMAIL}/test`)) as {
      message: string;
    };
    expect(result.message).toContain('(demo: nothing was sent)');
  });

  it('manages deployment channels, keeping config on a null update', async () => {
    const list = (await call('GET', '/settings/channels')) as SettingsChannel[];
    const email = list.find((c) => c.id === CHANNEL_SRE_EMAIL)!;
    expect(email.usedBy).toBeGreaterThan(0);
    const created = (await call('POST', '/settings/channels', {
      name: 'Ops webhook',
      kind: 'webhook',
      config: { url: 'https://ops.example.com/hook?token=secret' },
      allProjects: true,
    })) as SettingsChannel;
    expect(created.target).toBe('https://ops.example.com');
    expect('config' in created).toBe(false);
    const renamed = (await call('PUT', `/settings/channels/${created.id}`, {
      name: 'Ops hook',
      kind: 'webhook',
      config: null,
    })) as SettingsChannel;
    expect(renamed.target).toBe('https://ops.example.com');
    expect(
      await status(
        call('POST', '/settings/channels', { name: 'x', kind: 'email', config: { to: ['nope'] } }),
      ),
    ).toBe(400);

    await call('DELETE', `/settings/channels/${CHANNEL_SRE_EMAIL}`);
    const rules = (await call('GET', `${p}/alert-rules`)) as AlertRule[];
    expect(rules.some((r) => r.channelIds.includes(CHANNEL_SRE_EMAIL))).toBe(false);
    const test = (await call('POST', `/settings/channels/${created.id}/test`)) as {
      message: string;
    };
    expect(test.message).toContain('nothing was sent');
  });

  it('keeps SMTP settings without the password and refuses a real test email', async () => {
    expect(((await call('GET', '/settings/smtp')) as { configured: boolean }).configured).toBe(
      true,
    );
    await call('PUT', '/settings/smtp', {
      host: 'mail.example.com',
      port: 465,
      username: 'u',
      password: 'p',
      from: 'a@example.com',
      tls: 'tls',
    });
    const saved = (await call('GET', '/settings/smtp')) as Record<string, unknown>;
    expect(saved.host).toBe('mail.example.com');
    expect(JSON.stringify(saved)).not.toContain('"p"');
    expect(await status(call('POST', '/settings/smtp/test', { to: 'a@example.com' }))).toBe(403);
    expect(((await call('GET', '/settings/sync')) as { mode: string }).mode).toBe('control-plane');
  });
});

describe('logs_sql rules', () => {
  const SQL =
    "SELECT json_extract_string(fields, '$.service_name') AS service, count(*) AS value " +
    "FROM logs WHERE lower(level) = 'error' GROUP BY 1";
  const sqlRule = { ...newRule, source: 'logs_sql', query: { sql: SQL }, threshold: 10 };

  it('creates and lists a SQL rule with only its trimmed SQL', async () => {
    const created = (await call('POST', `${p}/alert-rules`, {
      ...sqlRule,
      query: { sql: `  ${SQL}\n`, logs: newRule.query.logs, groupBy: 'level', promql: 'up' },
    })) as AlertRule;
    expect(created.source).toBe('logs_sql');
    expect(created.query).toEqual({ sql: SQL });
    const listed = (await call('GET', `${p}/alert-rules`)) as AlertRule[];
    expect(listed.find((r) => r.id === created.id)?.query).toEqual({ sql: SQL });
    const updated = (await call('PUT', `${p}/alert-rules/${created.id}`, {
      ...sqlRule,
      query: { sql: 'SELECT count(*) AS value FROM logs' },
    })) as AlertRule;
    expect(updated.query).toEqual({ sql: 'SELECT count(*) AS value FROM logs' });
  });

  it('refuses SQL the backend refuses, with a clear message', async () => {
    const create = (sql: unknown) =>
      call('POST', `${p}/alert-rules`, { ...sqlRule, query: { sql } });
    await expect(create('  ')).rejects.toThrow('a SQL query is required');
    await expect(create(undefined)).rejects.toThrow('a SQL query is required');
    await expect(create(`SELECT 1 ${'-'.repeat(10_000)}`)).rejects.toThrow(
      'the SQL query exceeds the 10000 character limit',
    );
    await expect(create('DROP TABLE logs')).rejects.toThrow(
      'invalid SQL query: only SELECT statements are allowed',
    );
    await expect(create('SELECT 1; SELECT 2')).rejects.toThrow(
      'invalid SQL query: only one statement is allowed',
    );
    expect(await status(create('DROP TABLE logs'))).toBe(400);
    await expect(call('POST', `${p}/alert-rules`, { ...sqlRule, source: 'sql' })).rejects.toThrow(
      'source must be metrics, logs, log_patterns, logs_sql or traces',
    );
  });

  it('previews each row as a series over [now - window, now]', async () => {
    setSqlResult({
      columns: ['service', { name: 'value', type: 'Int64' }],
      rows: [
        ['checkout', 42n],
        ['payments', 3n],
      ],
    });
    const before = Date.now();
    const preview = (await call('POST', `${p}/alert-rules/preview`, {
      ...sqlRule,
      windowSeconds: 600,
    })) as PreviewSeries[];
    expect(preview).toEqual([
      { labels: { service: 'checkout' }, value: 42, firing: true },
      { labels: { service: 'payments' }, value: 3, firing: false },
    ]);
    expect(fakeSql.statements).toEqual([SQL]);
    expect(fakeSql.tableTimes.length).toBeGreaterThan(0);
    expect(fakeSql.tableTimes.every((t) => t >= before - 600_000 && t <= Date.now())).toBe(true);
  });

  it('refuses a truncated result and a failing query', async () => {
    setSqlResult({ columns: ['value'], rows: Array.from({ length: 10_001 }, (_, i) => [i]) });
    await expect(call('POST', `${p}/alert-rules/preview`, sqlRule)).rejects.toThrow(
      'the query returns more than 10000 rows; aggregate it to one row per series',
    );
    setSqlResult(new Error('Binder Error: nope'));
    expect(await status(call('POST', `${p}/alert-rules/preview`, sqlRule))).toBe(400);
  });

  describe('sqlSamples', () => {
    it('takes the value column, else the last numeric column', () => {
      expect(sqlSamples(['value', 'service'], [[5, 'checkout']])).toEqual([
        { labels: { service: 'checkout' }, value: 5 },
      ]);
      expect(sqlSamples(['service', 'lines', 'p95'], [['checkout', 10, 2.5]])).toEqual([
        { labels: { service: 'checkout', lines: '10' }, value: 2.5 },
      ]);
      // VALUE matches case-insensitively, even before a later numeric column.
      expect(sqlSamples(['VALUE', 'n'], [[1, 2]])).toEqual([{ labels: { n: '2' }, value: 1 }]);
    });

    it('reads numeric text only in the value column', () => {
      expect(sqlSamples(['service', 'value'], [['checkout', ' 7.5 ']])).toEqual([
        { labels: { service: 'checkout' }, value: 7.5 },
      ]);
      // "200" is a status code label, not the measurement.
      expect(sqlSamples(['status', 'n'], [['200', 4]])).toEqual([
        { labels: { status: '200' }, value: 4 },
      ]);
      expect(() => sqlSamples(['status'], [['200']])).toThrow(
        'the query must return a number: a column named value, or a numeric column',
      );
      expect(() => sqlSamples(['service'], [['checkout']])).toThrow('a numeric column');
    });

    it('skips null values and makes column names label-safe', () => {
      expect(
        sqlSamples(
          ['service.name', 'count_star()', '1st', '', 'value'],
          [
            ['checkout', 'a', 'b', 'c', 1],
            ['payments', 'a', 'b', 'c', null],
          ],
        ),
      ).toEqual([
        {
          labels: { service_name: 'checkout', count_star__: 'a', _1st: 'b', column_4: 'c' },
          value: 1,
        },
      ]);
      expect(sqlSamples(['value'], [])).toEqual([]);
    });

    it("keeps each label set's latest row when there is a time column", () => {
      expect(
        sqlSamples(
          ['minute', 'service', 'value'],
          [
            ['2026-11-18T10:01:00.000Z', 'checkout', 9],
            ['2026-11-18T10:00:00.000Z', 'checkout', 4],
            ['2026-11-18T10:00:00.000Z', 'payments', 2],
            ['2026-11-18T10:02:00.000Z', 'checkout', 7],
          ],
        ),
      ).toEqual([
        { labels: { service: 'checkout' }, value: 7 },
        { labels: { service: 'payments' }, value: 2 },
      ]);
    });

    it('allows at most 100 series', () => {
      const rows = (n: number) => Array.from({ length: n }, (_, i) => [`s${i}`, i]);
      expect(sqlSamples(['service', 'value'], rows(100))).toHaveLength(100);
      expect(() => sqlSamples(['service', 'value'], rows(101))).toThrow(
        'the query returns 101 series; a SQL rule may watch at most 100',
      );
    });
  });
});
