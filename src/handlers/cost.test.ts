import { afterEach, describe, expect, it } from 'vitest';

import type { CloudConnection, CloudCostSettings } from '../../entity/cloud';
import type {
  CommitmentsResponse,
  CostAnomaly,
  CostBudget,
  CostSummary,
  ExploreResponse,
  FacetsResponse,
  PlannerResponse,
  RecommendationsResponse,
  ResourceCostResponse,
} from '../../entity/cost';
import type { SavedViewList } from '../../entity/savedViews';
import { DemoError, Router } from '../router';
import { DAY, UNATTACHED_VOLUME, dayKey, today } from '../seed/cost';
import { AWS_CONNECTION_ID, AZURE_CONNECTION_ID, instanceId } from '../seed/inventory';
import { resetDemo } from '../store';
import { BATCH_HOST, PROJECT_ID } from '../world';
import { register as cost } from './cost';
import { register as inventory } from './inventory';
import { register as savedViews } from './savedViews';

const router = new Router();
cost(router);
inventory(router);
savedViews(router);

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

const day = (ago: number) => dayKey(today() - ago * DAY);

describe('cloud cost', () => {
  it('summarises each currency apart, with a forecast and both sources', async () => {
    const summary = await call<CostSummary>('GET', '/cloud-cost/summary');
    expect(summary.currencies.map((c) => c.currency)).toEqual(['EUR', 'USD']);
    for (const currency of summary.currencies) {
      expect(currency.forecast).toBeGreaterThanOrEqual(currency.monthToDate);
      expect(currency.daily.length).toBeGreaterThan(80);
      expect(currency.daily[currency.daily.length - 1]?.estimated).toBe(true);
    }
    expect(summary.sources.map((s) => s.source).sort()).toEqual(['api', 'export']);
    expect(summary.openAnomalies).toBe(1);
  });

  it('explores by period: single resources only from the export, n/a before data', async () => {
    const byResource = await call<ExploreResponse>('POST', '/cloud-cost/explore', {
      from: day(60),
      to: day(1),
      granularity: 'monthly',
      groupBy: 'resource',
      metric: 'effective',
      filters: {},
    });
    expect(byResource.currencies.map((c) => c.currency)).toEqual(['USD']);
    expect(byResource.currencies[0].rows.map((r) => r.key)).toContain(instanceId(BATCH_HOST));

    const yearly = await call<ExploreResponse>('POST', '/cloud-cost/explore', {
      from: day(1000),
      to: day(1),
      granularity: 'yearly',
      groupBy: 'account',
      metric: 'billed',
      filters: { provider: ['aws'] },
    });
    expect(yearly.periods[0].coverage).toBe('none');
    expect(yearly.periods[yearly.periods.length - 1]?.coverage).toBe('full');
    expect(yearly.currencies[0].rows[0].label).toBe('Harborline production');

    expect(
      await status(
        call('POST', '/cloud-cost/explore', {
          from: day(200),
          to: day(1),
          granularity: 'daily',
          groupBy: 'service',
          metric: 'effective',
          filters: {},
        }),
      ),
    ).toBe(400);
  });

  it('narrows facets by the other filters, never adding currencies', async () => {
    const facets = await call<FacetsResponse>('POST', '/cloud-cost/facets', {
      from: day(30),
      to: day(1),
      granularity: 'monthly',
      groupBy: 'service',
      metric: 'effective',
      filters: { provider: ['azure'] },
    });
    expect(facets.dimensions.provider.map((v) => v.value).sort()).toEqual(['aws', 'azure']);
    for (const service of facets.dimensions.service) {
      expect(Object.keys(service.amounts)).toEqual(['EUR']);
    }
    expect(Object.keys(facets.dimensions)).toEqual(expect.arrayContaining(['tag:team', 'tag:env']));
  });

  it("shows an EC2 instance's cost by its ARN, and an Azure resource as not covered", async () => {
    const arn = `arn:aws:ec2:eu-west-1:123456789012:instance/${instanceId(BATCH_HOST)}`;
    const instance = await call<ResourceCostResponse>(
      'GET',
      `/cloud-cost/resource?key=${encodeURIComponent(arn)}&days=30`,
    );
    expect(instance.covered).toBe(true);
    expect(instance.currencies[0].total).toBeGreaterThan(40);
    const azure = await call<ResourceCostResponse>(
      'GET',
      '/cloud-cost/resource?key=' +
        encodeURIComponent('/subscriptions/x/resourcegroups/y/providers/z/w/v'),
    );
    expect(azure.covered).toBe(false);
  });

  it('flags the spike against the same weekday and lets it be acknowledged', async () => {
    const [anomaly] = await call<CostAnomaly[]>(
      'GET',
      `/cloud-cost/anomalies?from=${day(30)}&to=${day(0)}`,
    );
    expect(anomaly.actual).toBeGreaterThan(anomaly.expected * 1.5);
    await call('PATCH', `/cloud-cost/anomalies/${anomaly.id}`, {
      status: 'acknowledged',
      note: 'Partner backfill',
    });
    const [after] = await call<CostAnomaly[]>(
      'GET',
      `/cloud-cost/anomalies?from=${day(30)}&to=${day(0)}`,
    );
    expect(after.status).toBe('acknowledged');
  });

  it('keeps budgets with their projection', async () => {
    const budgets = await call<CostBudget[]>('GET', `/projects/${PROJECT_ID}/cost-budgets`);
    expect(budgets.map((b) => b.name)).toEqual(['Production AWS', 'Shop team']);
    for (const budget of budgets) expect(budget.projected).toBeGreaterThanOrEqual(budget.spent);
    expect(
      await status(
        call('POST', `/projects/${PROJECT_ID}/cost-budgets`, {
          name: '',
          currency: 'USD',
          amount: 1,
        }),
      ),
    ).toBe(400);
  });

  it('lists recommendations with their savings basis, and keeps decisions', async () => {
    const { items, sections } = await call<RecommendationsResponse>(
      'GET',
      '/cloud-cost/recommendations',
    );
    const volume = items.find((r) => r.resourceKey === UNATTACHED_VOLUME)!;
    expect(volume.savingsBasis).toBe('resource_cost');
    expect(volume.monthlySavings).toBeGreaterThan(20);
    expect(items.find((r) => r.status === 'done')?.realizedMonthly).toBeGreaterThan(0);
    expect(
      sections.find((s) => s.connectionId === AZURE_CONNECTION_ID && s.section === 'commitments')
        ?.state,
    ).toBe('needs_permission');

    const key = items.find((r) => r.kind === 'rightsizing' && r.provider === 'aws')!.key;
    expect(
      await status(
        call('PATCH', '/cloud-cost/recommendations', {
          projectId: PROJECT_ID,
          key,
          status: 'dismissed',
        }),
      ),
    ).toBe(400);
    const planned = await call<{ status: string; owner: string }>(
      'PATCH',
      '/cloud-cost/recommendations',
      {
        projectId: PROJECT_ID,
        key,
        status: 'planned',
        owner: 'alex.rivera@harborline.example.com',
      },
    );
    expect(planned.status).toBe('planned');
  });

  it('flags commitments, and plans with rightsizing first', async () => {
    const { commitments } = await call<CommitmentsResponse>('GET', '/cloud-cost/commitments');
    expect(commitments.filter((c) => c.endingSoon)).toHaveLength(1);
    expect(commitments.filter((c) => c.unused)).toHaveLength(1);

    const first = await call<PlannerResponse>('GET', '/cloud-cost/planner?lookbackDays=30');
    const plain = await call<PlannerResponse>(
      'GET',
      '/cloud-cost/planner?lookbackDays=30&rightsizingFirst=false',
    );
    const compute = first.plans.find((p) => p.type === 'compute_sp')!;
    const computePlain = plain.plans.find((p) => p.type === 'compute_sp')!;
    expect(compute.rightsizingMonthly).toBeGreaterThan(0);
    expect(compute.options[0].monthlySavings).toBeLessThan(computePlain.options[0].monthlySavings);
    expect(compute.options.find((o) => o.labels.includes('lowest_risk'))?.term).toBe('1y');
    const rds = first.plans.find((p) => p.type === 'rds_ri')!;
    expect(rds.options.find((o) => o.term === '3y' && o.payment === 'no_upfront')?.offered).toBe(
      false,
    );
    expect(await status(call('GET', '/cloud-cost/planner?lookbackDays=14'))).toBe(400);
  });

  it('shows the connections reading cost and posture, and keeps tracked tags', async () => {
    const connections = await call<CloudConnection[]>('GET', '/cloud-connections');
    const aws = connections.find((c) => c.id === AWS_CONNECTION_ID)!;
    expect(aws.scanTypes).toEqual(['inventory', 'cost', 'posture']);
    expect(aws.status.cost?.cost?.source).toBe('export');
    expect(aws.status.posture?.posture?.findings).toBeGreaterThan(0);
    const settings = await call<CloudCostSettings>('PUT', '/cloud-connections/cost-settings', {
      trackedTags: ['team', 'cost-center'],
    });
    expect(settings.trackedTags).toEqual(['team', 'cost-center']);
    expect(await call<CloudCostSettings>('GET', '/cloud-connections/cost-settings')).toEqual(
      settings,
    );
  });

  it('saves views, keeping a shared one read-only to the visitor', async () => {
    const list = await call<SavedViewList>('GET', '/saved-views?kind=cost');
    expect(list.views).toHaveLength(1);
    expect(list.views[0].mine).toBe(false);
    expect(await status(call('DELETE', `/saved-views/${list.views[0].id}`))).toBe(403);
    const mine = await call<{ id: string }>('POST', '/saved-views', {
      kind: 'cost',
      name: 'EC2 by resource',
      shared: false,
      state: {
        range: 'mtd',
        granularity: 'daily',
        groupBy: 'resource',
        metric: 'effective',
        filters: {},
      },
    });
    const withDefault = await call<SavedViewList>('PUT', '/saved-views/default', {
      kind: 'cost',
      viewId: mine.id,
    });
    expect(withDefault.defaultId).toBe(mine.id);
  });
});
