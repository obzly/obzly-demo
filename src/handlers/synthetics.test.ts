import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CheckView,
  ImportPreview,
  MaintenanceWindow,
  Probe,
  RunResult,
  TestRun,
} from '../../entity/synthetics';
import sample from '../../features/synthetics/lib/synthetics-checks.sample.yaml?raw';
import { probeRunLogs, runIndices, runOf, simulate, syntheticsSeries } from '../gen/synthetics';
import { rng } from '../lib/rng';
import { Router } from '../router';
import { checkId, checks } from '../seed/synthetics';
import { resetDemo } from '../store';
import { INCIDENT_LENGTH, PROJECT_ID, incidentStart } from '../world';
import { register } from './synthetics';

const router = new Router();
register(router);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(path, 'http://demo.test');
  const route = router.match(method, url.pathname);
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`);
  const result = await route.handler({
    method,
    path: url.pathname,
    params: route.params,
    query: url.searchParams,
    body,
  });
  if (result instanceof Response) return (await result.text()) as T;
  return result as T;
}

const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
  resetDemo();
});

describe('synthetics monitors', () => {
  it('lists the seeded monitors with destinations and secret states', async () => {
    const list = await call<CheckView[]>('GET', '/synthetics/checks');
    expect(list.length).toBeGreaterThanOrEqual(10);
    expect(new Set(list.map((c) => c.type))).toEqual(
      new Set(['http', 'multi', 'tls', 'tcp', 'dns', 'icmp']),
    );
    const flow = list.find((c) => c.id === checkId('checkout-flow'))!;
    expect(flow.destination.projectId).toBe(PROJECT_ID);
    expect(flow.destination.siteId).toBeTruthy();
    expect(flow.secrets).toEqual([{ name: 'OBZLY_SECRET_CHECKOUT_PASSWORD', stored: true }]);
    expect(flow.parentIds).toEqual([checkId('checkout-api')]);
  });

  it('creates, edits with version checks, clones and deletes', async () => {
    const [existing] = await call<CheckView[]>('GET', '/synthetics/checks');
    const request = {
      name: 'Gift cards API',
      enabled: true,
      intervalSeconds: 120,
      downLocations: 0,
      locations: [],
      destinationId: existing.destination.id,
      definition: {
        type: 'http',
        timeoutSeconds: 10,
        request: { method: 'GET', url: 'https://api.harborline.example.com/gift-cards/health' },
        assertions: [{ kind: 'status', op: 'equals', value: '200' }],
      },
    };
    const created = await call<CheckView>('POST', '/synthetics/checks', request);
    expect(created.version).toBe(1);
    await expect(call('POST', '/synthetics/checks', request)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      call('POST', '/synthetics/checks', { ...request, name: 'Too fast', intervalSeconds: 10 }),
    ).rejects.toMatchObject({ status: 400 });
    const edited = await call<CheckView>('PUT', `/synthetics/checks/${created.id}`, {
      ...request,
      intervalSeconds: 300,
      version: 1,
    });
    expect(edited).toMatchObject({ version: 2, intervalSeconds: 300 });
    await expect(
      call('PUT', `/synthetics/checks/${created.id}`, { ...request, version: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    const clone = await call<CheckView>('POST', `/synthetics/checks/${created.id}/clone`);
    expect(clone).toMatchObject({ name: 'Gift cards API (copy)', enabled: false });
    await call('DELETE', `/synthetics/checks/${created.id}`);
    await expect(call('GET', `/synthetics/checks/${created.id}`)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses to delete a destination monitors still use', async () => {
    const [destination] = await call<{ id: string }[]>('GET', '/synthetics/destinations');
    await expect(
      call('DELETE', `/synthetics/destinations/${destination.id}`),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('synthetics results', () => {
  const peak = incidentStart(Date.now() - 6 * 3_600_000) + 10 * MINUTE;
  const calm = incidentStart(Date.now() - 6 * 3_600_000) + INCIDENT_LENGTH + 90 * MINUTE;

  const statuses = (slug: string, location: string, t: number, n = 200) => {
    const check = checks.get(checkId(slug))!;
    const out: RunResult[] = [];
    for (let i = 0; i < n; i++) out.push(simulate(check, location, location, t + i, rng(i + 1)));
    return out;
  };

  it('fails the checkout API from exposed locations during the incident only', () => {
    const during = statuses('checkout-api', 'aws-eu-west-1', peak);
    const share = during.filter((run) => run.status === 'down').length / during.length;
    expect(share).toBeGreaterThan(0.75);
    expect(during.some((run) => run.httpStatus === 503)).toBe(true);
    const asia = statuses('checkout-api', 'aws-ap-southeast-1', peak);
    expect(asia.filter((run) => run.status === 'down').length / asia.length).toBeLessThan(0.4);
    const after = statuses('checkout-api', 'aws-eu-west-1', calm);
    expect(after.filter((run) => run.status === 'down').length).toBeLessThan(3);
  });

  it('fails the checkout flow at Create order and still cleans up', () => {
    const failed = statuses('checkout-flow', 'aws-eu-west-1', peak).find(
      (run) => run.status === 'down' && run.steps?.[2]?.status === 'down',
    )!;
    expect(failed.steps!.map((s) => s.status)).toEqual(['up', 'up', 'down', 'up']);
    expect(failed.steps![3].afterFailure).toBe(true);
    const fine = statuses('checkout-flow', 'aws-eu-west-1', calm, 5)[0];
    expect(fine.status).toBe('up');
    expect(fine.steps!.every((s) => s.status === 'up')).toBe(true);
  });

  it('warns about the auth certificate expiring in about 12 days', () => {
    const [run] = statuses('auth-cert', 'aws-eu-west-1', Date.now(), 1);
    expect(run.status).toBe('warn');
    expect(run.tls!.daysLeft).toBeGreaterThan(11);
    expect(run.tls!.daysLeft).toBeLessThan(13.5);
    const [www] = statuses('www-cert', 'aws-eu-west-1', Date.now(), 1);
    expect(www.status).toBe('up');
  });

  it('serves synthetics_* series per monitor and location, deterministically', () => {
    const now = Date.now();
    const matchers = [{ name: 'check_id', op: '=' as const, value: checkId('checkout-api') }];
    const a = syntheticsSeries(PROJECT_ID, 'synthetics_up', matchers, now - 3_600_000, now, 15_000);
    const b = syntheticsSeries(PROJECT_ID, 'synthetics_up', matchers, now - 3_600_000, now, 15_000);
    expect(a.length).toBe(4);
    expect(a).toEqual(b);
    for (const series of a) {
      expect(series.labels).toMatchObject({ check: 'Checkout API health', type: 'http' });
      expect(series.timestamps.length).toBeGreaterThan(50);
      expect(series.timestamps.every((t) => t >= now - 3_600_000 && t <= now)).toBe(true);
    }
    const phases = syntheticsSeries(
      PROJECT_ID,
      'synthetics_duration_seconds',
      [...matchers, { name: 'phase', op: '=' as const, value: 'total' }],
      now - 3_600_000,
      now,
      15_000,
    );
    expect(phases.every((s) => s.labels.phase === 'total')).toBe(true);
    const steps = syntheticsSeries(
      PROJECT_ID,
      'synthetics_step_up',
      [],
      now - 3_600_000,
      now,
      15_000,
    );
    expect(new Set(steps.map((s) => s.labels.step))).toEqual(
      new Set(['Sign in', 'Add to cart', 'Create order', 'Cancel order']),
    );
    const cert = syntheticsSeries(
      PROJECT_ID,
      'synthetics_cert_expiry_seconds',
      [],
      now - 7_200_000,
      now,
      15_000,
    );
    expect(cert.some((s) => s.labels.tls_verified === 'true')).toBe(true);
  });

  it('answers the run history log search', () => {
    const now = Date.now();
    const query = (failuresOnly: boolean) => ({
      query: {
        type: 'logical',
        logic: {
          operator: 'and',
          children: [
            {
              type: 'condition',
              condition: { field: 'service_name', operator: 'equals', value: 'obzly-probe' },
            },
            {
              type: 'condition',
              condition: { field: 'check_id', operator: 'equals', value: checkId('checkout-api') },
            },
            ...(failuresOnly
              ? [
                  {
                    type: 'condition',
                    condition: { field: 'level', operator: 'not_equals', value: 'info' },
                  },
                ]
              : []),
          ],
        },
      },
      timeRange: {
        from: new Date(now - 2 * 86_400_000).toISOString(),
        to: new Date(now).toISOString(),
      },
      limit: 30,
      sortOrder: 'desc' as const,
    });
    const all = probeRunLogs(PROJECT_ID, query(false))!;
    expect(all.logs).toHaveLength(30);
    expect(all.logs[0].timestamp >= all.logs[29].timestamp).toBe(true);
    const failures = probeRunLogs(PROJECT_ID, query(true))!;
    expect(failures.logs.length).toBeGreaterThan(0);
    for (const log of failures.logs) {
      expect(log.level).not.toBe('info');
      const run = JSON.parse(log.fields.synthetics_run) as RunResult;
      expect(run.checkId).toBe(checkId('checkout-api'));
      expect(run.status).not.toBe('up');
    }
    expect(probeRunLogs(PROJECT_ID, { query: null })).toBeUndefined();
  });

  it('keeps run k the same however it is reached', () => {
    const check = checks.get(checkId('storefront-home'))!;
    const now = Date.now();
    const [, last] = runIndices(check, 'aws-us-east-1', now - 600_000, now);
    expect(runOf(check, 'aws-us-east-1', last)).toBe(runOf(check, 'aws-us-east-1', last));
  });
});

describe('synthetics run test', () => {
  it('queues per online location and answers after about 1.5 s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
    const [check] = await call<CheckView[]>('GET', '/synthetics/checks');
    const run = await call<TestRun>('POST', '/synthetics/tests', {
      checkId: check.id,
      check: { ...check, destinationId: check.destination.id },
    });
    expect(run.tasks.length).toBe(4);
    expect(run.tasks.every((task) => task.status === 'queued')).toBe(true);
    const early = await call<TestRun>('GET', `/synthetics/tests/${run.id}`);
    expect(early.tasks.every((task) => task.status === 'queued')).toBe(true);
    vi.setSystemTime(new Date('2026-11-07T10:00:05Z'));
    const done = await call<TestRun>('GET', `/synthetics/tests/${run.id}`);
    expect(done.tasks.every((task) => task.status === 'done' && task.result)).toBe(true);
    const local = await call<TestRun>('POST', '/synthetics/tests', {
      check: { ...check, destinationId: check.destination.id },
      fromControlPlane: true,
    });
    expect(local.tasks[0]).toMatchObject({ status: 'done', location: 'control-plane' });
  });
});

describe('synthetics probes', () => {
  it('shows probe groups with versions, members and last seen', async () => {
    const list = await call<Probe[]>('GET', '/synthetics/probes');
    expect(list.map((p) => p.location)).toContain('aws-eu-west-1');
    expect(list.every((p) => p.online && p.lastSeenAt)).toBe(true);
    const sg = list.find((p) => p.location === 'aws-ap-southeast-1')!;
    expect(sg.members).toHaveLength(2);
    expect(sg.members.filter((m) => m.live)).toHaveLength(1);
    const created = await call<{ probe: Probe; token: string }>('POST', '/synthetics/probes', {
      name: 'office-berlin',
      location: 'office-berlin',
      description: '',
    });
    expect(created.token).toMatch(/^obz_prb_/);
    expect(created.probe.online).toBe(false);
  });
});

describe('synthetics maintenance', () => {
  it('lists windows with their states and previews schedules', async () => {
    const windows = await call<MaintenanceWindow[]>('GET', '/synthetics/maintenance');
    expect(windows.length).toBe(5);
    const states = new Set(windows.map((w) => w.state));
    expect(states.has('paused')).toBe(true);
    expect(states.has('upcoming')).toBe(true);
    const payments = windows.find((w) => w.name === 'Payments provider upgrade')!;
    expect(payments.monitorIds).toEqual([checkId('checkout-api'), checkId('checkout-flow')]);
    const data = windows.find((w) => w.name === 'Weekly database patching')!;
    expect(data.monitorIds).toEqual(
      expect.arrayContaining([checkId('sftp-port'), checkId('batch-ping')]),
    );
    const preview = await call<{ occurrences: { start: string; end: string }[] }>(
      'POST',
      '/synthetics/maintenance/preview',
      {
        schedule: {
          kind: 'weekly',
          timeZone: 'Europe/London',
          startTime: '02:00',
          durationMinutes: 60,
          weekdays: ['sun'],
        },
      },
    );
    expect(preview.occurrences).toHaveLength(3);
    for (const o of preview.occurrences) {
      expect(new Date(o.start).getUTCDay()).toBe(0);
      expect([1, 2]).toContain(new Date(o.start).getUTCHours());
    }
    const from = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const occurrences = await call<unknown[]>(
      'GET',
      `/synthetics/maintenance/occurrences?from=${from}&to=${to}`,
    );
    expect(occurrences.length).toBeGreaterThan(2);
  });

  it('starts and ends a window now', async () => {
    const windows = await call<MaintenanceWindow[]>('GET', '/synthetics/maintenance');
    const weekly = windows.find((w) => w.name === 'Weekly database patching')!;
    const started = await call<MaintenanceWindow>(
      'POST',
      `/synthetics/maintenance/${weekly.id}/start`,
    );
    expect(started.state).toBe('active');
    const ended = await call<MaintenanceWindow>('POST', `/synthetics/maintenance/${weekly.id}/end`);
    expect(ended.state).toBe('upcoming');
  });
});

describe('synthetics import and export', () => {
  it('exports YAML that imports back unchanged', async () => {
    const yaml = await call<string>('GET', '/synthetics/checks/export');
    expect(yaml).toContain('apiVersion: obzly.com/synthetics/v1');
    expect(yaml).toContain('maintenance:');
    const preview = await call<ImportPreview>('POST', '/synthetics/checks/import/preview', {
      yaml,
      secrets: {},
    });
    expect(preview.errors).toEqual([]);
    expect(preview.create).toEqual([]);
    expect(preview.update).toEqual([]);
    expect(preview.unchanged.length).toBe(checks.all().length);
    expect(preview.maintenance?.update).toEqual([]);
  });

  it('previews and applies creates and updates, reporting problems with lines', async () => {
    const yaml = `apiVersion: obzly.com/synthetics/v1
kind: MonitorList
defaults:
  destination: Harborline Shop
monitors:
  - name: Storefront home page
    type: http
    interval: 120s
    request:
      url: https://www.harborline.example.com/
    assertions:
      - status: 200
  - name: Returns API
    type: http
    folder: Shop/Returns
    depends_on: [Checkout API health]
    request:
      url: https://api.harborline.example.com/returns/health
    assertions:
      - status: {in: [200, 204]}
      - response_time_ms: {below: 800, severity: warn}
`;
    const preview = await call<ImportPreview>('POST', '/synthetics/checks/import/preview', {
      yaml,
    });
    expect(preview.errors).toEqual([]);
    expect(preview.create).toEqual(['Returns API']);
    expect(preview.update[0].name).toBe('Storefront home page');
    expect(preview.update[0].changes).toContain('interval 60s → 120s');
    const applied = await call<ImportPreview>('POST', '/synthetics/checks/import', { yaml });
    expect(applied.applied).toBe(true);
    const list = await call<CheckView[]>('GET', '/synthetics/checks');
    const returns = list.find((c) => c.name === 'Returns API')!;
    expect(returns.parentIds).toEqual([checkId('checkout-api')]);
    expect(returns.definition.assertions?.[1]).toMatchObject({ op: 'below', severity: 'warn' });

    const broken = await call<ImportPreview>('POST', '/synthetics/checks/import/preview', {
      yaml: 'apiVersion: obzly.com/synthetics/v1\nkind: MonitorList\nmonitors:\n  - name: X\n    type: carrier-pigeon\n',
    });
    expect(broken.errors[0]).toMatchObject({ line: 4, monitor: 'X' });
  });

  it('reads the sample file shipped with the UI', async () => {
    const preview = await call<ImportPreview>('POST', '/synthetics/checks/import/preview', {
      yaml: sample,
    });
    // Its destination ("synthetics") doesn't exist in the demo: one error per monitor, no parse errors.
    expect(preview.errors.length).toBeGreaterThan(0);
    expect(preview.errors.every((e) => e.message.includes('destination'))).toBe(true);
  });
});
