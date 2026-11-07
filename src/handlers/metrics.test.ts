import { describe, expect, it } from 'vitest';

import type { PromQLResponse } from '../../entity/synthetics';
import { DemoError, Router } from '../router';
import { NODES, PROJECT_ID } from '../world';
import { register } from './metrics';

const router = new Router();
register(router);

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const route = router.match(method, path);
  if (!route) throw new Error(`no route for ${method} ${path}`);
  return route.handler({
    method,
    path,
    params: route.params,
    query: new URLSearchParams(),
    body,
  });
}

async function status(method: string, path: string, body?: unknown): Promise<number> {
  try {
    await call(method, path, body);
    return 200;
  } catch (error) {
    if (error instanceof DemoError) return error.status;
    throw error;
  }
}

describe('metrics handlers', () => {
  it('covers every entity/metrics URL plus the PromQL endpoint', () => {
    for (const [method, path] of [
      ['GET', '/metrics/query/names/x'],
      ['POST', '/metrics/query/label-values/x'],
      ['GET', '/metrics/query/stats/x'],
      ['POST', '/metrics/query/promql/x'],
    ]) {
      expect(router.match(method, path), `${method} ${path}`).toBeDefined();
    }
  });

  it('lists metric names with gauge/counter types, sorted', async () => {
    const { metrics } = (await call('GET', `/metrics/query/names/${PROJECT_ID}`)) as {
      metrics: { name: string; type: string }[];
    };
    const names = metrics.map((m) => m.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const type = Object.fromEntries(metrics.map((m) => [m.name, m.type]));
    expect(type.http_server_request_duration_bucket).toBe('counter');
    expect(type.system_cpu_time).toBe('counter');
    expect(type.k8s_pod_memory_working_set).toBe('gauge');
    expect(type.postgresql_backends).toBe('gauge');
    expect(new Set(Object.values(type))).toEqual(new Set(['gauge', 'counter']));
  });

  it('lists label values across all metrics, for variables and the filter bar', async () => {
    const values = async (labelName: string) =>
      (
        (await call('POST', `/metrics/query/label-values/${PROJECT_ID}`, { labelName })) as {
          values: string[];
        }
      ).values;
    expect(await values('k8s_namespace_name')).toEqual(
      expect.arrayContaining(['data', 'identity', 'ingress-nginx', 'observability', 'shop']),
    );
    expect(await values('k8s_node_name')).toEqual([...NODES].sort());
    expect(await values('k8s.cluster.name')).toEqual(['harborline-prod']);
    const pods = await values('k8s_pod_name');
    expect(pods.length).toBeGreaterThan(30);
    expect(pods).toContain('postgres-0');
    expect(await values('model')).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-1',
      'claude-sonnet-4-5',
    ]);
    const filtered = (await call('POST', `/metrics/query/label-values/${PROJECT_ID}`, {
      labelName: 'service_name',
      matchers: [{ name: '__name__', type: '=', value: 'http_server_request_duration_count' }],
    })) as { values: string[] };
    expect(filtered.values).toEqual([
      'auth',
      'catalog',
      'checkout',
      'inventory',
      'payments',
      'search',
      'storefront',
    ]);
    expect(await status('POST', `/metrics/query/label-values/${PROJECT_ID}`, {})).toBe(400);
  });

  it('reports project stats', async () => {
    const stats = (await call('GET', `/metrics/query/stats/${PROJECT_ID}`)) as Record<
      string,
      unknown
    >;
    expect(stats.totalSamples).toBeGreaterThan(1e8);
    expect(stats.totalSizeMb).toBeGreaterThan(0);
    expect(stats.rawSizeMb as number).toBeGreaterThan(stats.totalSizeMb as number);
    expect(Date.parse(stats.oldestSampleTime as string)).toBeLessThan(
      Date.parse(stats.newestSampleTime as string),
    );
  });

  it('runs PromQL queries and rejects unknown projects', async () => {
    const now = Date.now();
    const response = (await call('POST', `/metrics/query/promql/${PROJECT_ID}`, {
      query: 'sum by (service_name) (rate(http_server_request_duration_count[5m]))',
      start: new Date(now - 3_600_000).toISOString(),
      end: new Date(now).toISOString(),
    })) as PromQLResponse;
    expect(response.resultType).toBe('matrix');
    expect(response.stepSeconds).toBe(60);
    expect(response.series).toHaveLength(7);
    expect(await status('POST', `/metrics/query/promql/${PROJECT_ID}`, { query: 'sum(' })).toBe(
      400,
    );
    expect(await status('POST', `/metrics/query/promql/${PROJECT_ID}`, {})).toBe(400);
    expect(await status('POST', '/metrics/query/promql/not-a-project', { query: 'up' })).toBe(404);
    expect(await status('GET', '/metrics/query/names/not-a-project')).toBe(404);
  });
});
