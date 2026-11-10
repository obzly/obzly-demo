import { afterEach, describe, expect, it } from 'vitest';

import type {
  ActionsResponse,
  CoverageRow,
  Finding,
  FindingDetail,
  FindingsResponse,
  PostureAction,
  PostureSummary,
  TrendsResponse,
} from '../../entity/posture';
import { DemoError, Router } from '../router';
import { DAY, dayKey, today } from '../seed/cost';
import { instanceId } from '../seed/inventory';
import { resetDemo } from '../store';
import { NODES, PROJECT_ID } from '../world';
import { register } from './posture';

const router = new Router();
register(router);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(path, 'http://demo.test');
  const route = router.match(method, url.pathname);
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`);
  return (await route.handler({
    method,
    path: url.pathname,
    params: route.params,
    query: url.searchParams,
    body,
  })) as T;
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    return error instanceof DemoError ? error.status : 500;
  }
}

afterEach(() => resetDemo());

const list = (filters: object) =>
  call<FindingsResponse>('POST', '/posture/findings', {
    filters,
    limit: 200,
  }).then((r) => r.findings);

describe('posture', () => {
  it('scores standards from evaluated controls, leaving suppressed findings out', async () => {
    const summary = await call<PostureSummary>('GET', '/posture/summary');
    const fsbp = summary.standards.find((s) => s.standard === 'aws-fsbp')!;
    expect(fsbp.sources).toEqual(['baseline', 'native']);
    expect(fsbp.failed).toBe(7);
    expect(fsbp.trend?.length).toBe(30);
    expect(summary.open.critical).toBe(1);
    expect(summary.suppressed).toBe(1);
    expect(summary.resolved30d).toBe(1);
    expect(summary.coverage).toEqual({
      native: 1,
      fallback: 2,
      baseline: 0,
      notCovered: 0,
      stale: 0,
    });
  });

  it('lists, filters and suppresses findings, keeping their history', async () => {
    const open = await list({});
    expect(open.every((f) => f.status === 'open' && !f.suppressed)).toBe(true);
    expect((await list({ status: 'suppressed' })).map((f) => f.control)).toEqual([
      'azure-storage-min-tls',
    ]);
    const s3 = open.find((f) => f.control === 'S3.8')!;
    expect(
      await status(
        call('PATCH', `/posture/findings/${s3.id}`, {
          suppressed: true,
          reason: '',
        }),
      ),
    ).toBe(400);
    await call<Finding>('PATCH', `/posture/findings/${s3.id}`, {
      suppressed: true,
      reason: 'Temporary share, deleted Friday',
    });
    const detail = await call<FindingDetail>('GET', `/posture/findings/${s3.id}`);
    expect(detail.suppressed).toBe(true);
    expect(detail.events[0].kind).toBe('suppressed');
    const baseline = open.find((f) => f.source === 'baseline')!;
    expect(
      (await call<FindingDetail>('GET', `/posture/findings/${baseline.id}`)).remediation?.cli,
    ).toBeTruthy();
  });

  it("finds an EC2 instance's findings by the instance ID the asset drawer has", async () => {
    const findings = await call<Finding[]>('GET', `/posture/resource?key=${instanceId(NODES[0])}`);
    expect(findings.map((f) => f.control)).toEqual(['EC2.8']);
  });

  it('trends open findings, opened and resolved, and scores', async () => {
    const { periods } = await call<TrendsResponse>('POST', '/posture/trends', {
      from: dayKey(today() - 59 * DAY),
      to: dayKey(today()),
      granularity: 'monthly',
      filters: {},
    });
    const last = periods[periods.length - 1]!;
    expect(Object.values(last.open).reduce<number>((a, b) => a + (b ?? 0), 0)).toBeGreaterThan(5);
    expect(periods.reduce((sum, p) => sum + p.resolved, 0)).toBe(1);
    expect(last.scores['aws-fsbp']).toBeGreaterThan(0);
  });

  it('says why each scope falls back', async () => {
    const rows = await call<CoverageRow[]>('GET', '/posture/coverage');
    expect(rows.find((r) => r.region === 'us-east-1')?.reason).toBe(
      'Security Hub not enabled in us-east-1',
    );
  });

  it('ranks coverage gaps, fixes and guardrails, and simulates the plan', async () => {
    const { actions, standards } = await call<ActionsResponse>(
      'GET',
      `/posture/actions?projectId=${PROJECT_ID}`,
    );
    expect(actions[0].kind).toBe('coverage');
    const bucket = actions.find((a) => a.title.startsWith('Fix 2 findings on'))!;
    expect(bucket.findings).toHaveLength(2);
    const ebs = actions.find((a) => a.key.startsWith('guardrail:aws-ebs-encryption-default'))!;
    expect(ebs.findings.map((f) => f.control)).toEqual(['EC2.7']);
    expect(
      actions.some((a) => a.kind === 'fix' && a.findings.some((f) => f.control === 'EC2.7')),
    ).toBe(false);
    const before = standards.find((s) => s.standard === 'aws-fsbp')!;
    expect(before.withPlan).toBe(before.current);
    expect(before.withAll).toBe(100);

    expect(
      await status(
        call('PATCH', '/posture/actions', {
          projectId: PROJECT_ID,
          key: bucket.key,
          dismissed: true,
        }),
      ),
    ).toBe(400);
    const planned = await call<PostureAction>('PATCH', '/posture/actions', {
      projectId: PROJECT_ID,
      key: bucket.key,
      planned: true,
    });
    expect(planned.planned).toBe(true);
    const after = (
      await call<ActionsResponse>('GET', `/posture/actions?projectId=${PROJECT_ID}`)
    ).standards.find((s) => s.standard === 'aws-fsbp')!;
    expect(after.withPlan).toBeGreaterThan(before.withPlan);
  });

  it('shows a planned action whose findings were suppressed as an accepted risk', async () => {
    const { actions } = await call<ActionsResponse>(
      'GET',
      `/posture/actions?projectId=${PROJECT_ID}`,
    );
    const bucket = actions.find((a) => a.title.startsWith('Fix 2 findings on'))!;
    await call('PATCH', '/posture/actions', {
      projectId: PROJECT_ID,
      key: bucket.key,
      planned: true,
    });
    for (const finding of bucket.findings) {
      await call('PATCH', `/posture/findings/${finding.id}`, {
        suppressed: true,
        reason: 'Deleted on Friday',
      });
    }
    const after = await call<ActionsResponse>('GET', `/posture/actions?projectId=${PROJECT_ID}`);
    expect(after.actions.find((a) => a.key === bucket.key)?.status).toBe('accepted_risk');
  });
});
