import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Dashboard, Panel } from '../../entity/dashboards';
import { Router } from '../router';
import { CHECKOUT_DASHBOARD_ID, INFRA_FOLDER_ID, OVERVIEW_DASHBOARD_ID } from '../seed/dashboards';
import { resetDemo } from '../store';
import { HOUR, PROJECT_ID, STAGING_PROJECT_ID } from '../world';
import { register } from './dashboards';

// The traces and metrics areas are built in parallel; pin their seams here.
vi.mock('../gen/traces', () => ({
  aggregateSpanPanel: vi.fn((_pid: string, panel: Panel) => [{ groupKey: panel.metric, value: 7 }]),
}));
vi.mock('../query/promql', () => ({
  evaluatePromQL: vi.fn(() => ({
    resultType: 'matrix',
    series: [
      {
        labels: { __name__: 'x', service_name: 'checkout', le: '0.5' },
        points: [
          { timestamp: '2026-11-07T10:00:00.000Z', value: 1 },
          { timestamp: '2026-11-07T10:01:00.000Z', value: 2 },
        ],
      },
      {
        labels: { __name__: 'only_name' },
        points: [{ timestamp: '2026-11-07T10:00:00.000Z', value: 3 }],
      },
    ],
  })),
}));

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
  if (result instanceof Response) return result;
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

async function frames(response: Response): Promise<{ type: string; buckets?: unknown[] }[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const base = `/projects/dashboards/${PROJECT_ID}`;
const range = (hours: number) => ({
  from: new Date(Date.now() - hours * HOUR).toISOString(),
  to: new Date().toISOString(),
});

beforeEach(() => resetDemo());

describe('dashboards CRUD', () => {
  it('lists the seeded dashboards, pinned first, and folders by title', async () => {
    const { dashboards } = (await call('GET', base)) as { dashboards: Dashboard[] };
    expect(dashboards.map((d) => d.title)).toEqual([
      'Harborline overview',
      'Checkout & payments',
      'Kubernetes cluster',
      'Postgres',
    ]);
    expect(dashboards[0].isPinned).toBe(true);
    const { folders } = (await call('GET', `${base}/folders`)) as { folders: { title: string }[] };
    expect(folders.map((f) => f.title)).toEqual(['Infrastructure', 'Services']);
    const staging = (await call('GET', `/projects/dashboards/${STAGING_PROJECT_ID}`)) as {
      dashboards: Dashboard[];
    };
    expect(staging.dashboards).toEqual([]);
  });

  it('every seeded dashboard passes the same validation an update does', async () => {
    const { dashboards } = (await call('GET', base)) as { dashboards: Dashboard[] };
    for (const d of dashboards) {
      const updated = (await call('PUT', `${base}/${d.id}`, d)) as Dashboard;
      expect(updated.tabs.length).toBe(d.tabs.length);
    }
  });

  it('creates, edits, pins, files and deletes a dashboard', async () => {
    const created = (await call('POST', base, { title: 'New dashboard' })) as Dashboard;
    expect(created.tabs).toHaveLength(1);
    expect(created.tabs[0].title).toBe('Default');

    const updated = (await call('PUT', `${base}/${created.id}`, {
      title: 'Renamed',
      tabs: [
        {
          id: '',
          title: '',
          panels: [{ id: '', title: 'p', type: 'line', gridPos: { x: 0, y: 0, w: 6, h: 6 } }],
        },
      ],
    })) as Dashboard;
    expect(updated.title).toBe('Renamed');
    expect(updated.tabs[0].title).toBe('Untitled tab');
    expect(updated.tabs[0].panels[0].id).not.toBe('');

    expect(
      ((await call('PUT', `${base}/${created.id}/pin`, { pinned: true })) as Dashboard).isPinned,
    ).toBe(true);
    const filed = (await call('PUT', `${base}/${created.id}/folder`, {
      folderId: INFRA_FOLDER_ID,
    })) as Dashboard;
    expect(filed.folderId).toBe(INFRA_FOLDER_ID);
    expect(await status(call('PUT', `${base}/${created.id}/folder`, { folderId: 'nope' }))).toBe(
      404,
    );

    await call('DELETE', `${base}/${created.id}`);
    expect(await status(call('GET', `${base}/${created.id}`))).toBe(404);
  });

  it('rejects invalid panels and variables', async () => {
    const tabs = (panel: Partial<Panel>) => [
      {
        id: 't',
        title: 'T',
        panels: [
          { id: 'p', title: 'p', type: 'line', gridPos: { x: 0, y: 0, w: 1, h: 1 }, ...panel },
        ],
      },
    ];
    expect(
      await status(call('POST', base, { title: 'x', tabs: tabs({ type: 'radar' as never }) })),
    ).toBe(400);
    expect(
      await status(
        call('POST', base, { title: 'x', tabs: tabs({ source: 'spans', groupField: 'level' }) }),
      ),
    ).toBe(400);
    expect(
      await status(
        call('POST', base, {
          title: 'x',
          variables: [{ key: '1bad', label: '', source: 'static', staticValues: ['a'] }],
        }),
      ),
    ).toBe(400);
    expect(await status(call('POST', base, { title: '' }))).toBe(400);
  });

  it('deleting a folder un-files its dashboards', async () => {
    await call('DELETE', `${base}/folders/${INFRA_FOLDER_ID}`);
    const { dashboards } = (await call('GET', base)) as { dashboards: Dashboard[] };
    expect(dashboards.filter((d) => d.folderId === INFRA_FOLDER_ID)).toEqual([]);
    expect(dashboards).toHaveLength(4);
    const folder = (await call('POST', `${base}/folders`, { title: 'Teams' })) as { id: string };
    const renamed = (await call('PUT', `${base}/folders/${folder.id}`, { title: 'Squads' })) as {
      title: string;
    };
    expect(renamed.title).toBe('Squads');
  });

  it('keeps visitor changes across calls', async () => {
    await call('PUT', `${base}/${CHECKOUT_DASHBOARD_ID}/pin`, { pinned: false });
    const { dashboards } = (await call('GET', base)) as { dashboards: Dashboard[] };
    expect(dashboards.find((d) => d.id === CHECKOUT_DASHBOARD_ID)?.isPinned).toBe(false);
    expect(dashboards[0].id).toBe(OVERVIEW_DASHBOARD_ID);
  });
});

describe('panel queries', () => {
  const logsPanel: Panel = {
    id: 'h',
    title: '',
    type: 'bar',
    source: 'logs',
    groupField: 'level',
    gridPos: { x: 0, y: 0, w: 1, h: 1 },
  };

  it('answers a logs panel and requires a closed range', async () => {
    const { buckets } = (await call('POST', `${base}/query`, {
      panel: logsPanel,
      timeRange: range(1),
    })) as {
      buckets: { groupKey?: string; value: number; timestamp?: string }[];
    };
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.some((b) => b.groupKey === 'info')).toBe(true);
    expect(await status(call('POST', `${base}/query`, { panel: logsPanel }))).toBe(400);
  });

  it('streams the log histogram in several frames that add up to the one-shot answer', async () => {
    const panel = { ...logsPanel, bucketMs: 60_000 };
    const timeRange = range(3);
    const response = (await call('POST', `${base}/query/stream`, { panel, timeRange })) as Response;
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
    const list = await frames(response);
    expect(list[list.length - 1].type).toBe('done');
    const bucketFrames = list.filter((f) => f.type === 'buckets');
    expect(bucketFrames.length).toBeGreaterThan(1);
    const streamed = bucketFrames.flatMap((f) => f.buckets as { value: number }[]);
    const { buckets } = (await call('POST', `${base}/query`, { panel, timeRange })) as {
      buckets: { value: number }[];
    };
    const sum = (list: { value: number }[]) => list.reduce((acc, b) => acc + b.value, 0);
    expect(sum(streamed)).toBe(sum(buckets));
  });

  it('turns PromQL series into buckets with a label legend', async () => {
    const panel: Panel = { ...logsPanel, source: 'metrics', promQuery: 'rate(x[5m])' };
    const { buckets } = (await call('POST', `${base}/query`, { panel })) as {
      buckets: { groupKey?: string; value: number }[];
    };
    expect(buckets).toHaveLength(3);
    expect(buckets[0].groupKey).toBe('le=0.5, service_name=checkout');
    expect(buckets[2].groupKey).toBe('only_name');
    const empty = (await call('POST', `${base}/query`, {
      panel: { ...panel, promQuery: '  ' },
    })) as {
      buckets: unknown[];
    };
    expect(empty.buckets).toEqual([]);
  });

  it('sends spans panels to the traces area with count as the default metric', async () => {
    const panel: Panel = { ...logsPanel, source: 'spans', groupField: 'service_name' };
    const { buckets } = (await call('POST', `${base}/query`, { panel, timeRange: range(1) })) as {
      buckets: { groupKey?: string }[];
    };
    expect(buckets[0].groupKey).toBe('count');
    expect(
      await status(
        call('POST', `${base}/query`, { panel: { ...panel, metric: 'max' }, timeRange: range(1) }),
      ),
    ).toBe(400);
  });
});

describe('overview', () => {
  it('creates the auto-generated Overview, then replaces it in place', async () => {
    const first = (await call('POST', `${base}/overview`)) as Dashboard;
    expect(first.isAutoGenerated).toBe(true);
    expect(first.tabs[0].panels.some((p) => p.source === 'spans')).toBe(true);
    const second = (await call('POST', `${base}/overview`)) as Dashboard;
    expect(second.id).toBe(first.id);
    expect(second.tabs[0].id).toBe(first.tabs[0].id);
    const { dashboards } = (await call('GET', base)) as { dashboards: Dashboard[] };
    expect(dashboards.filter((d) => d.isAutoGenerated)).toHaveLength(1);
  });
});

describe('import', () => {
  const grafana = {
    dashboard: {
      title: 'Node exporter',
      templating: {
        list: [
          { name: 'job', type: 'query', query: 'label_values(up, job)' },
          { name: 'svc', type: 'query', query: { query: 'label_values(service_name)' } },
          { name: 'env', type: 'custom', query: 'prod,staging' },
          { name: 'ds', type: 'datasource' },
          { name: 'weird', type: 'adhocish' },
        ],
      },
      panels: [
        {
          type: 'timeseries',
          title: 'CPU',
          gridPos: { x: 0, y: 0, w: 12, h: 8 },
          fieldConfig: { defaults: { unit: 'percentunit' } },
          targets: [
            {
              expr: 'avg by (instance) (rate(node_cpu_seconds_total{job="$job"}[$__rate_interval]))',
            },
            { expr: 'up' },
          ],
        },
        { type: 'text', title: 'Notes', gridPos: { x: 12, y: 0, w: 12, h: 8 } },
        { type: 'row', title: 'Logs', gridPos: { x: 0, y: 8, w: 24, h: 1 }, panels: [] },
        {
          type: 'logs',
          title: 'Errors',
          gridPos: { x: 12, y: 9, w: 12, h: 8 },
          datasource: { type: 'loki' },
          targets: [{ expr: '{app="checkout", level=~"error|fatal"} |= "timeout" | json' }],
        },
      ],
    },
  };

  it('maps Grafana rows, targets and variables, with warnings', async () => {
    const { dashboard, warnings } = (await call('POST', `${base}/import`, {
      format: 'grafana',
      json: JSON.stringify(grafana),
    })) as { dashboard: Dashboard; warnings: string[] };
    expect(dashboard.title).toBe('Node exporter');
    expect(dashboard.tabs.map((t) => t.title)).toEqual(['Overview', 'Logs']);
    const cpu = dashboard.tabs[0].panels[0];
    expect(cpu.source).toBe('metrics');
    expect(cpu.unit).toBe('percent');
    expect(cpu.promQuery).toBe(
      'avg by (instance) (rate(node_cpu_seconds_total{job="${job}"}[5m]))',
    );
    expect(cpu.gridPos).toEqual({ x: 0, y: 0, w: 6, h: 8 });
    const errors = dashboard.tabs[1].panels[0];
    expect(errors.source).toBe('logs');
    expect(errors.type).toBe('table');
    expect(errors.gridPos.y).toBe(0);
    expect(errors.gridPos.x).toBe(6);
    expect(JSON.stringify(errors.query)).toContain('"service_name"');
    expect(JSON.stringify(errors.query)).toContain('"timeout"');
    expect(dashboard.variables).toEqual([
      { key: 'job', label: 'job', source: 'metricLabel', metricLabelName: 'job' },
      { key: 'svc', label: 'svc', source: 'services' },
      { key: 'env', label: 'env', source: 'static', staticValues: ['prod', 'staging'] },
    ]);
    expect(warnings.join('\n')).toMatch(/only the first of 2 queries/);
    expect(warnings.join('\n')).toMatch(/text panels aren't supported/);
    expect(warnings.join('\n')).toMatch(/LogQL/);
    expect(warnings.join('\n')).toMatch(/variable "weird"/);
  });

  it('maps OpenObserve tabs, PromQL and filters', async () => {
    const doc = {
      title: 'Shop',
      tabs: [
        {
          name: 'Main',
          panels: [
            {
              type: 'line',
              title: 'Requests',
              layout: { x: 0, y: 0, w: 96, h: 9 },
              queries: [{ queryType: 'promql', query: 'sum(rate(http_requests_total[5m]))' }],
            },
            {
              type: 'bar',
              title: 'Errors by service',
              layout: { x: 96, y: 0, w: 96, h: 9 },
              queries: [
                {
                  fields: {
                    stream_type: 'logs',
                    filter: [{ column: 'level', operator: '=', value: 'error' }],
                    breakdown: [{ column: 'service.name' }],
                  },
                },
              ],
            },
            { type: 'html', title: 'Readme', layout: { x: 0, y: 9, w: 48, h: 4 } },
          ],
        },
      ],
      variables: {
        list: [{ name: 'svc', type: 'custom', options: [{ value: 'a' }, { value: 'b' }] }],
      },
    };
    const { dashboard, warnings } = (await call('POST', `${base}/import`, {
      format: 'openobserve',
      json: JSON.stringify(doc),
    })) as { dashboard: Dashboard; warnings: string[] };
    const [requests, errors] = dashboard.tabs[0].panels;
    expect(requests.promQuery).toBe('sum(rate(http_requests_total[5m]))');
    expect(requests.gridPos).toEqual({ x: 0, y: 0, w: 6, h: 9 });
    expect(errors.source).toBe('logs');
    expect(errors.groupField).toBe('service_name');
    expect(errors.query?.condition).toEqual({ field: 'level', operator: 'equals', value: 'error' });
    expect(errors.gridPos.x).toBe(6);
    expect(dashboard.variables[0].staticValues).toEqual(['a', 'b']);
    expect(warnings.join('\n')).toMatch(/html panels aren't supported/);
  });

  it('refuses bad JSON and unknown formats', async () => {
    expect(await status(call('POST', `${base}/import`, { format: 'grafana', json: '{' }))).toBe(
      400,
    );
    expect(await status(call('POST', `${base}/import`, { format: 'kibana', json: '{}' }))).toBe(
      400,
    );
  });
});
