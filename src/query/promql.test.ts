import { describe, expect, it } from 'vitest';

import type { Panel } from '../../entity/dashboards';
import type { SiteAsset } from '../../entity/inventory';
import type { PromQLRequest, PromQLResponse } from '../../entity/synthetics';
import { applyFiltersToPanel } from '../../features/dashboards/lib/dashboardFilters';
import { dashboardTemplates } from '../../features/dashboards/lib/dashboardTemplates';
import { applyVariablesToPanel } from '../../features/dashboards/lib/dashboardVariables';
import { chartQueries } from '../../features/infrastructure/lib/charts';
import {
  idsMatcher,
  mean,
  mergedQuantile,
  passRatio,
  quantileResolution,
  selector,
  statusWindow,
} from '../../features/synthetics/lib/queries';
import {
  type Labels,
  type RawSeries,
  allMetrics,
  registerSeriesProvider,
} from '../gen/metricRegistry';
import { compileMatchers } from '../gen/metricShapes';
import { isGeneratedMetric } from '../gen/metrics';
import { DemoError } from '../router';
import { BATCH_HOST, CLUSTER, NODES, PROJECT_ID, podsFor, workloadByService } from '../world';
import { evaluatePromQL } from './promql';
import { SUBSET_NOTE } from './promqlParse';

// ---------------------------------------------------------------------------
// A tiny fake project with known series, to check semantics exactly.
// ---------------------------------------------------------------------------

const TEST_PROJECT = 'promql-test-project';
const T = Date.UTC(2026, 10, 1, 12, 0, 0);
const T0 = T - 6 * 3_600_000;
const RESET_B = T - 120_000;
const STEP = 15_000;

interface Fake {
  labels: Labels;
  value: (t: number) => number;
}

const HIST_RATES: [string, number][] = [
  ['0.1', 1],
  ['0.5', 3],
  ['1', 4],
  ['+Inf', 4],
];

const FAKE: Record<string, Fake[]> = {
  t_counter_total: [
    { labels: { job: 'api', instance: 'a' }, value: (t) => (2 * (t - T0)) / 1000 },
    {
      labels: { job: 'api', instance: 'b' },
      value: (t) => (3 * (t - (t >= RESET_B ? RESET_B : T0))) / 1000,
    },
  ],
  t_gauge: [
    { labels: { job: 'api', instance: 'a' }, value: () => 10 },
    { labels: { job: 'api', instance: 'b' }, value: () => 20 },
    { labels: { job: 'db', instance: 'c' }, value: () => 5 },
  ],
  t_limit: [
    { labels: { job: 'api', instance: 'a' }, value: () => 40 },
    { labels: { job: 'api', instance: 'b' }, value: () => 40 },
  ],
  t_info: [{ labels: { job: 'api', version: '1.2.3' }, value: () => 1 }],
  t_hist_bucket: HIST_RATES.map(([le, rate]) => ({
    labels: { job: 'api', le },
    value: (t: number) => (rate * (t - T0)) / 1000,
  })),
  'dotted.gauge': [{ labels: { k8s_pod_name: 'p-1' }, value: () => 7 }],
};

registerSeriesProvider({
  metrics: (projectId) =>
    projectId === TEST_PROJECT
      ? Object.keys(FAKE).map((name) => ({
          name: name.replace(/\./g, '_'),
          type: name.endsWith('_total') || name.endsWith('_bucket') ? 'counter' : 'gauge',
          help: '',
        }))
      : [],
  series: (projectId, name, matchers, from, to) => {
    if (projectId !== TEST_PROJECT) return [];
    const fakes = FAKE[name] ?? FAKE[name.replace(/_/g, '.')] ?? [];
    const match = compileMatchers(matchers);
    const out: RawSeries[] = [];
    for (const fake of fakes) {
      const labels = { __name__: name, ...fake.labels };
      if (!match(labels)) continue;
      const timestamps: number[] = [];
      for (let t = Math.ceil(Math.max(from, T0) / STEP) * STEP; t <= Math.min(to, T); t += STEP) {
        timestamps.push(t);
      }
      out.push({ labels, timestamps, values: timestamps.map(fake.value) });
    }
    return out;
  },
});

const instant = (query: string, at = T) =>
  evaluatePromQL(TEST_PROJECT, { query, end: new Date(at).toISOString(), instant: true });

const byLabel = (response: PromQLResponse, label: string) =>
  Object.fromEntries(response.series.map((s) => [s.labels[label] ?? '', s.points[0].value]));

const errorOf = (fn: () => unknown): DemoError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DemoError) return error;
    throw error;
  }
  throw new Error('expected a DemoError');
};

describe('evaluatePromQL semantics', () => {
  it('selects instant vectors with all four matcher operators', () => {
    expect(instant('t_gauge').series).toHaveLength(3);
    expect(instant('t_gauge{job="api"}').series).toHaveLength(2);
    expect(instant('t_gauge{job!="api"}').series).toHaveLength(1);
    expect(instant('t_gauge{instance=~"a|c"}').series).toHaveLength(2);
    expect(instant('t_gauge{instance!~"a|c"}').series).toHaveLength(1);
    expect(instant('{__name__=~"t_gauge|t_limit", job="api"}').series).toHaveLength(4);
    const series = instant('t_gauge{instance="a"}').series[0];
    expect(series.labels).toEqual({ __name__: 't_gauge', job: 'api', instance: 'a' });
    expect(series.points[0]).toEqual({ timestamp: '2026-11-01T12:00:00Z', value: 10 });
  });

  it('accepts quoted and dotted names, normalized like the backend', () => {
    expect(instant('{"dotted.gauge"}').series[0].points[0].value).toBe(7);
    expect(instant('{"__name__"="dotted.gauge", "k8s.pod.name"="p-1"}').series).toHaveLength(1);
    expect(byLabel(instant('sum by ("job") (t_gauge)'), 'job')).toEqual({ api: 30, db: 5 });
  });

  it('computes rate, increase, irate, delta and deriv like Prometheus', () => {
    const rate = byLabel(instant('rate(t_counter_total[5m])'), 'instance');
    expect(rate.a).toBeCloseTo(2, 6);
    // Across the reset: the increment just before it is lost, as in Prometheus.
    expect(rate.b).toBeCloseTo(810 / 285, 6);
    expect(byLabel(instant('increase(t_counter_total[10m])'), 'instance').a).toBeCloseTo(1200, 6);
    expect(byLabel(instant('irate(t_counter_total[1m])'), 'instance').a).toBeCloseTo(2, 6);
    expect(byLabel(instant('delta(t_gauge[5m])'), 'instance').a).toBe(0);
    expect(byLabel(instant('deriv(t_counter_total{instance="a"}[5m])'), 'instance').a).toBeCloseTo(
      2,
      6,
    );
    // Functions drop the metric name.
    expect(instant('rate(t_counter_total[5m])').series[0].labels.__name__).toBeUndefined();
    expect(instant('last_over_time(t_gauge[5m])').series[0].labels.__name__).toBe('t_gauge');
  });

  it('supports the *_over_time family', () => {
    const at = (fn: string) =>
      byLabel(instant(`${fn}(t_counter_total{instance="a"}[1m])`), 'instance').a;
    const last = (2 * (T - T0)) / 1000;
    expect(at('max_over_time')).toBe(last);
    expect(at('min_over_time')).toBe(last - 90);
    expect(at('count_over_time')).toBe(4);
    expect(at('last_over_time')).toBe(last);
    expect(at('sum_over_time')).toBe(4 * last - 180);
    expect(at('avg_over_time')).toBe(last - 45);
    expect(at('stddev_over_time')).toBeCloseTo(Math.sqrt(1125), 6);
    expect(byLabel(instant('quantile_over_time(0.5, t_gauge[5m])'), 'instance').b).toBe(20);
  });

  it('aggregates with by/without, topk/bottomk and quantile', () => {
    expect(byLabel(instant('sum by (job) (t_gauge)'), 'job')).toEqual({ api: 30, db: 5 });
    expect(byLabel(instant('sum without (instance) (t_gauge)'), 'job')).toEqual({ api: 30, db: 5 });
    expect(instant('avg(t_gauge)').series[0].points[0].value).toBeCloseTo(35 / 3);
    expect(instant('min(t_gauge)').series[0].points[0].value).toBe(5);
    expect(instant('max(t_gauge) by (job)').series).toHaveLength(2);
    expect(instant('count(t_gauge)').series[0].points[0].value).toBe(3);
    expect(instant('quantile(0.5, t_gauge)').series[0].points[0].value).toBe(10);
    expect(instant('stddev(t_gauge)').series[0].points[0].value).toBeCloseTo(6.2361, 3);
    expect(instant('topk(1, t_gauge)').series.map((s) => s.labels.instance)).toEqual(['b']);
    expect(
      instant('bottomk(2, t_gauge)')
        .series.map((s) => s.labels.instance)
        .sort(),
    ).toEqual(['a', 'c']);
    expect(instant('topk(1, t_gauge) by (job)').series).toHaveLength(2);
    expect(instant('count(count by (job) (t_gauge))').series[0].points[0].value).toBe(2);
  });

  it('computes histogram_quantile from classic buckets', () => {
    const p50 = instant('histogram_quantile(0.5, sum by (le) (rate(t_hist_bucket[5m])))');
    expect(p50.series[0].labels).toEqual({});
    expect(p50.series[0].points[0].value).toBeCloseTo(0.3, 6);
    const p99 = instant('histogram_quantile(0.99, rate(t_hist_bucket[5m]))');
    expect(p99.series[0].labels).toEqual({ job: 'api' });
    expect(p99.series[0].points[0].value).toBeCloseTo(0.98, 6);
  });

  it('does arithmetic, comparisons and bool between vectors and scalars', () => {
    expect(byLabel(instant('t_gauge * 2'), 'instance')).toEqual({ a: 20, b: 40, c: 10 });
    expect(byLabel(instant('100 - t_gauge'), 'instance')).toEqual({ a: 90, b: 80, c: 95 });
    expect(byLabel(instant('t_gauge > 15'), 'instance')).toEqual({ b: 20 });
    expect(byLabel(instant('15 < t_gauge'), 'instance')).toEqual({ b: 20 });
    expect(byLabel(instant('t_gauge > bool 15'), 'instance')).toEqual({ a: 0, b: 1, c: 0 });
    expect(instant('t_gauge > 15').series[0].labels.__name__).toBe('t_gauge');
    expect(instant('t_gauge * 2').series[0].labels.__name__).toBeUndefined();
    expect(instant('2 ^ 3 ^ 2').scalar).toBe(512);
    expect(instant('-2 ^ 2').scalar).toBe(-4);
    expect(instant('1 + 2 * 3').scalar).toBe(7);
    expect(instant('(1 + 2) * 3').scalar).toBe(9);
    expect(instant('1 < bool 2').scalar).toBe(1);
    expect(instant('1e6 / 1024').scalar).toBeCloseTo(976.5625);
  });

  it('matches vectors one-to-one, with on/ignoring and group_left', () => {
    expect(byLabel(instant('t_gauge / t_limit'), 'instance')).toEqual({ a: 0.25, b: 0.5 });
    expect(byLabel(instant('t_gauge / on (instance) t_limit'), 'instance')).toEqual({
      a: 0.25,
      b: 0.5,
    });
    expect(instant('t_gauge / on (instance) t_limit').series[0].labels).toEqual({ instance: 'a' });
    expect(byLabel(instant('t_gauge / ignoring (job) t_limit'), 'instance')).toEqual({
      a: 0.25,
      b: 0.5,
    });
    const joined = instant('t_gauge * on (job) group_left (version) t_info');
    expect(joined.series).toHaveLength(2);
    expect(joined.series[0].labels.version).toBe('1.2.3');
    expect(byLabel(instant('sum by (job) (t_gauge) / sum by (job) (t_limit)'), 'job')).toEqual({
      api: 30 / 80,
    });
    const err = errorOf(() => instant('t_gauge / on (job) t_limit'));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/many-to-many|multiple matches/);
  });

  it('supports and/or/unless, vector() and absent()', () => {
    expect(instant('sum(t_gauge{job="nope"}) or vector(0)').series[0].points[0].value).toBe(0);
    expect(instant('sum(t_gauge) or vector(0)').series[0].points[0].value).toBe(35);
    expect(byLabel(instant('t_gauge and t_limit'), 'instance')).toEqual({ a: 10, b: 20 });
    expect(byLabel(instant('t_gauge unless t_limit'), 'instance')).toEqual({ c: 5 });
    const absent = instant('absent(t_gauge{job="nope"})');
    expect(absent.series).toEqual([
      { labels: { job: 'nope' }, points: [{ timestamp: '2026-11-01T12:00:00Z', value: 1 }] },
    ]);
    expect(instant('absent(t_gauge)').series).toHaveLength(0);
    expect(instant('absent_over_time(t_gauge{job="nope"}[5m])').series).toHaveLength(1);
  });

  it('has label_replace, label_join, math, clamp, round and scalar functions', () => {
    const replaced = instant(
      'label_replace(t_gauge{instance="a"}, "host", "node-$1", "instance", "(.*)")',
    );
    expect(replaced.series[0].labels.host).toBe('node-a');
    expect(
      instant('label_replace(t_gauge{instance="a"}, "kind", "commits", "", "")').series[0].labels
        .kind,
    ).toBe('commits');
    expect(
      instant('label_join(t_gauge{instance="a"}, "both", "/", "job", "instance")').series[0].labels
        .both,
    ).toBe('api/a');
    expect(byLabel(instant('abs(t_gauge - 15)'), 'instance')).toEqual({ a: 5, b: 5, c: 10 });
    expect(byLabel(instant('clamp_max(t_gauge, 12)'), 'instance')).toEqual({ a: 10, b: 12, c: 5 });
    expect(byLabel(instant('clamp_min(t_gauge, 12)'), 'instance')).toEqual({ a: 12, b: 20, c: 12 });
    expect(byLabel(instant('clamp(t_gauge, 6, 12)'), 'instance')).toEqual({ a: 10, b: 12, c: 6 });
    expect(byLabel(instant('round(t_gauge / 3)'), 'instance')).toEqual({ a: 3, b: 7, c: 2 });
    expect(byLabel(instant('ceil(t_gauge / 3)'), 'instance').a).toBe(4);
    expect(byLabel(instant('floor(t_gauge / 3)'), 'instance').b).toBe(6);
    expect(instant('scalar(sum(t_gauge))').scalar).toBe(35);
    expect(instant('time()').scalar).toBe(T / 1000);
    expect(instant('vector(time())').series[0].points[0].value).toBe(T / 1000);
    expect(byLabel(instant('t_gauge / scalar(sum(t_gauge))'), 'instance').b).toBeCloseTo(20 / 35);
  });

  it('handles offset, @ and subqueries', () => {
    const now = byLabel(instant('t_counter_total'), 'instance').a;
    expect(byLabel(instant('t_counter_total offset 10m'), 'instance').a).toBe(now - 1200);
    expect(byLabel(instant('rate(t_counter_total[5m] offset 1h)'), 'instance').a).toBeCloseTo(2, 6);
    expect(byLabel(instant(`t_counter_total @ ${(T - 600_000) / 1000}`), 'instance').a).toBe(
      now - 1200,
    );
    const sub = instant('max_over_time(rate(t_counter_total{instance="a"}[1m])[10m:1m])');
    expect(sub.series[0].points[0].value).toBeCloseTo(2, 6);
    const merged = instant('quantile_over_time(0.5, (max by (job) (t_gauge))[30m:30s])');
    expect(byLabel(merged, 'job')).toEqual({ api: 20, db: 5 });
    expect(
      instant('count_over_time(t_gauge{instance="a"}[10m:1m])').series[0].points[0].value,
    ).toBe(10);
  });

  it('answers range queries with the backend step rules', () => {
    const range = (request: Partial<PromQLRequest>) =>
      evaluatePromQL(TEST_PROJECT, { query: 'sum(t_gauge)', ...request });
    const hour = range({
      start: new Date(T - 3_600_000).toISOString(),
      end: new Date(T).toISOString(),
    });
    expect(hour.resultType).toBe('matrix');
    expect(hour.stepSeconds).toBe(60);
    expect(hour.series[0].points).toHaveLength(61);
    expect(hour.series[0].points[0].timestamp).toBe('2026-11-01T11:00:00Z');
    const stepped = range({
      start: new Date(T - 3_600_000).toISOString(),
      end: new Date(T).toISOString(),
      stepSeconds: 300,
    });
    expect(stepped.stepSeconds).toBe(300);
    expect(stepped.series[0].points).toHaveLength(13);
    const scalar = evaluatePromQL(TEST_PROJECT, {
      query: '1 + 1',
      start: new Date(T - 600_000).toISOString(),
      end: new Date(T).toISOString(),
    });
    expect(scalar.series[0].labels).toEqual({});
    expect(scalar.series[0].points[0].value).toBe(2);
    const many = evaluatePromQL(TEST_PROJECT, {
      query: 't_gauge',
      end: new Date(T).toISOString(),
      instant: true,
      maxSeries: 2,
    });
    expect(many.series).toHaveLength(2);
    expect(many.truncated).toBe(true);
    expect(
      errorOf(() => range({ start: new Date(T).toISOString(), end: new Date(T).toISOString() }))
        .message,
    ).toMatch(/start must be before end/);
    expect(
      errorOf(() =>
        range({
          start: new Date(T - 86_400_000).toISOString(),
          end: new Date(T).toISOString(),
          stepSeconds: 1,
        }),
      ).message,
    ).toMatch(/exceeds the maximum of 11000 points/);
    expect(errorOf(() => evaluatePromQL(TEST_PROJECT, { query: 't_gauge[5m]' })).message).toMatch(
      /range vector/,
    );
    const matrix = evaluatePromQL(TEST_PROJECT, {
      query: 't_gauge{instance="a"}[1m]',
      end: new Date(T).toISOString(),
      instant: true,
    });
    expect(matrix.resultType).toBe('matrix');
    expect(matrix.series[0].points).toHaveLength(4);
  });

  it('rejects invalid PromQL with 400 and names unsupported syntax', () => {
    for (const bad of [
      'sum(',
      'rate(t_gauge)',
      '{}',
      't_gauge{job=1}',
      'nope_fn(t_gauge)',
      '1 > 2',
      't_gauge[5m',
      'sum by (job t_gauge',
    ]) {
      const err = errorOf(() => instant(bad));
      expect(err.status, bad).toBe(400);
      expect(err.message, bad).toMatch(/^invalid PromQL: /);
    }
    for (const unsupported of [
      'count_values("v", t_gauge)',
      'holt_winters(t_gauge[5m], 0.5, 0.5)',
      'limitk(2, t_gauge)',
    ]) {
      const err = errorOf(() => instant(unsupported));
      expect(err.status).toBe(400);
      expect(err.message).toContain(SUBSET_NOTE);
    }
    expect(errorOf(() => evaluatePromQL(TEST_PROJECT, { query: '  ' })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Every PromQL string the UI builds parses and returns data.
// ---------------------------------------------------------------------------

const NOW = Date.now();
const H = 3_600_000;

const ranged = (projectId: string, query: string, hours = 6, stepSeconds?: number) =>
  evaluatePromQL(projectId, {
    query,
    start: new Date(NOW - hours * H).toISOString(),
    end: new Date(NOW).toISOString(),
    stepSeconds,
  });

const promPanels = (panels: Panel[]) =>
  panels.filter((panel) => panel.source === 'metrics' && panel.promQuery);

describe('UI query catalogue against the generated metrics', () => {
  it('serves every generated metric (the backend Overview dashboard queries)', () => {
    const metrics = allMetrics(PROJECT_ID).filter((info) => isGeneratedMetric(info.name));
    expect(metrics.length).toBeGreaterThan(140);
    const empty: string[] = [];
    for (const info of metrics) {
      const query = info.type === 'gauge' ? `avg(${info.name})` : `sum(rate(${info.name}[5m]))`;
      const response = ranged(PROJECT_ID, query, 1);
      if (!response.series.length || !response.series[0].points.length) empty.push(info.name);
    }
    expect(empty).toEqual([]);
  });

  it('fills every dashboard template panel', () => {
    const empty: string[] = [];
    let count = 0;
    for (const template of dashboardTemplates) {
      for (const tab of template.buildTabs()) {
        for (const panel of promPanels(tab.panels)) {
          count++;
          const query = applyVariablesToPanel(panel, {}).promQuery!;
          const response =
            panel.type === 'stat' || panel.type === 'table'
              ? evaluatePromQL(PROJECT_ID, { query, instant: true })
              : ranged(PROJECT_ID, query, 24);
          if (!response.series.length) empty.push(`${template.key}: ${panel.title}: ${query}`);
        }
      }
    }
    expect(count).toBeGreaterThan(50);
    expect(empty).toEqual([]);
  });

  it('applies dashboard variables and the filter bar', () => {
    const pod = podsFor(workloadByService.get('checkout')!, NOW)[0];
    const values = {
      cluster: CLUSTER,
      node: pod.node,
      namespace: 'shop',
      pod: pod.name,
      container: 'checkout',
    };
    for (const template of dashboardTemplates.filter(
      (t) => t.key === 'k8s-cluster-grafana-15661',
    )) {
      for (const tab of template.buildTabs()) {
        for (const panel of promPanels(tab.panels)) {
          const query = applyVariablesToPanel(panel, values).promQuery!;
          expect(ranged(PROJECT_ID, query, 1).series.length, query).toBeGreaterThan(0);
        }
      }
    }
    const filters = { namespace: 'shop', pod: pod.name, node: pod.node };
    for (const template of dashboardTemplates) {
      for (const tab of template.buildTabs()) {
        for (const panel of promPanels(tab.panels)) {
          const query = applyFiltersToPanel(applyVariablesToPanel(panel, {}), filters).promQuery!;
          expect(() => ranged(PROJECT_ID, query, 1), query).not.toThrow();
        }
      }
    }
  });

  it('fills every Infrastructure chart', () => {
    const payments = podsFor(workloadByService.get('payments')!, NOW)[0];
    const base = {
      cluster: CLUSTER,
      namespace: '',
      node: '',
      attributes: {} as Record<string, string>,
    };
    const assets = [
      { ...base, kind: 'node', name: NODES[0], node: NODES[0] },
      { ...base, kind: 'cluster', name: CLUSTER },
      { ...base, cluster: '', kind: 'host', name: BATCH_HOST, node: BATCH_HOST },
      { ...base, kind: 'pod', name: payments.name, namespace: 'shop', node: payments.node },
      {
        ...base,
        kind: 'container',
        name: 'payments',
        namespace: 'shop',
        attributes: { k8s_pod_name: payments.name },
      },
      { ...base, kind: 'workload', name: 'checkout', namespace: 'shop' },
      { ...base, kind: 'namespace', name: 'data', namespace: 'data' },
      { ...base, cluster: '', kind: 'docker_container', name: 'export-worker', node: BATCH_HOST },
    ] as unknown as SiteAsset[];
    for (const asset of assets) {
      const charts = chartQueries(asset);
      expect(charts.length, asset.kind).toBeGreaterThan(0);
      for (const chart of charts) {
        for (const line of chart.lines) {
          const response = ranged(PROJECT_ID, line.query, 6, 180);
          expect(response.series.length, `${asset.kind}: ${line.query}`).toBeGreaterThan(0);
          for (const point of response.series[0].points)
            expect(Number.isFinite(point.value)).toBe(true);
        }
      }
    }
  });

  it('answers typical alert rules and explore queries', () => {
    const queries = [
      'sum(rate(http_server_request_duration_count{http_response_status_code=~"5.."}[5m])) / sum(rate(http_server_request_duration_count[5m])) > 0.01',
      'histogram_quantile(0.95, sum by (le, service_name) (rate(http_server_request_duration_bucket[5m])))',
      'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="payments"}[5m])))',
      'sum by (postgresql_database_name) (postgresql_backends) / on() group_left() max(postgresql_connection_max)',
      'sum(postgresql_backends) / max(postgresql_connection_max) > 0.9',
      'max by (k8s_pod_name) (increase(k8s_container_restarts[1h])) > 0',
      'sum by (service_name) (db_client_connection_count{db_client_connection_state="used"}) / sum by (service_name) (db_client_connection_max)',
      'sum(rate(db_client_connection_timeouts[5m])) by (service_name)',
      'avg by (jvm_memory_pool_name) (jvm_memory_used{jvm_memory_type="heap"})',
      'rate(jvm_gc_duration_sum[5m]) / rate(jvm_gc_duration_count[5m])',
      'sum(rate(redis_keyspace_hits[5m])) / (sum(rate(redis_keyspace_hits[5m])) + sum(rate(redis_keyspace_misses[5m])))',
      'topk(5, sum by (k8s_pod_name) (rate(container_cpu_time[5m])))',
      'predict_linear(k8s_node_filesystem_available[6h], 4 * 3600) < 0 or vector(0)',
      'sum(rate(otelcol_exporter_send_failed_spans[5m])) or vector(0)',
      '1 - avg(rate(system_cpu_time{state="idle"}[5m]))',
      'deriv(postgresql_db_size[1h])',
      'sum by (k8s_namespace_name) (k8s_pod_memory_working_set) / 1024 / 1024',
      'count by (k8s_node_name) (k8s_node_condition_ready == 1)',
      'avg_over_time(k8s_node_cpu_usage[1h:5m])',
      'label_replace(sum by (service_name) (rate(http_server_request_duration_count[5m])), "svc", "$1", "service_name", "(.*)")',
    ];
    for (const query of queries) {
      expect(() => ranged(PROJECT_ID, query, 6), query).not.toThrow();
      expect(evaluatePromQL(PROJECT_ID, { query, instant: true }).resultType, query).toMatch(
        /vector|scalar/,
      );
    }
    expect(ranged(PROJECT_ID, queries[1], 6).series.length).toBe(7);
    expect(ranged(PROJECT_ID, queries[2], 6).series.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Synthetics queries, against a stand-in synthetics provider (the real one
// lives with the synthetics area and needs its monitors).
// ---------------------------------------------------------------------------

const SYN_PROJECT = 'synthetics-promql-test';
const CHECKS = ['c-1', 'c-2'];
const LOCATIONS = ['eu-west', 'us-east'];
const SYN_METRICS = [
  'synthetics_up',
  'synthetics_warn',
  'synthetics_duration_seconds',
  'synthetics_cert_expiry_seconds',
  'synthetics_response_bytes',
  'synthetics_redirects',
  'synthetics_icmp_rtt_seconds',
  'synthetics_icmp_loss_ratio',
  'synthetics_step_up',
  'synthetics_step_duration_seconds',
];

registerSeriesProvider({
  metrics: (projectId) =>
    projectId === SYN_PROJECT
      ? SYN_METRICS.map((name) => ({ name, type: 'gauge' as const, help: '' }))
      : [],
  series: (projectId, name, matchers, from, to) => {
    if (projectId !== SYN_PROJECT) return [];
    const match = compileMatchers(matchers);
    const out: RawSeries[] = [];
    for (const check of CHECKS) {
      for (const location of LOCATIONS) {
        const extras: Labels[] =
          name === 'synthetics_duration_seconds'
            ? ['total', 'dns', 'connect', 'tls', 'ttfb'].map((phase) => ({ phase }))
            : name.startsWith('synthetics_step_')
              ? [0, 1].map((i) => ({ step_index: String(i), step: `step ${i}` }))
              : [{}];
        for (const extra of extras) {
          const labels = { __name__: name, check_id: check, location, ...extra };
          if (!match(labels)) continue;
          const timestamps: number[] = [];
          for (let t = Math.ceil(from / 60_000) * 60_000; t <= to; t += 60_000) timestamps.push(t);
          const values = timestamps.map((t) =>
            name.endsWith('_up')
              ? (t / 60_000) % 37 === 0
                ? 0
                : 1
              : name.endsWith('_warn')
                ? 0
                : 0.1 + ((t / 60_000) % 7) / 50,
          );
          out.push({ labels, timestamps, values });
        }
      }
    }
    return out;
  },
});

describe('synthetics PromQL', () => {
  it('parses and answers the monitor queries', () => {
    const only = idsMatcher(['c-1'], CHECKS.length);
    const step = 300;
    const seconds = 86_400;
    const resolution = quantileResolution(60);
    const duration = selector('synthetics_duration_seconds', only, 'phase="total"');
    const perLocation = `min by (check_id, location) (min_over_time(${selector('synthetics_up', only)}[${step}s]))`;
    const queries: [string, boolean][] = [
      [`sum by (check_id) (${perLocation} == bool 0)`, false],
      [`count by (check_id) (${perLocation})`, false],
      [`max by (check_id) (max_over_time(${selector('synthetics_warn', only)}[${step}s]))`, false],
      [
        `min by (check_id, location) (last_over_time(${selector('synthetics_up', only)}[${statusWindow(60)}s]))`,
        true,
      ],
      [
        `max by (check_id, location) (last_over_time(${selector('synthetics_warn', only)}[${statusWindow(60)}s]))`,
        true,
      ],
      [passRatio('check_id', only, seconds), true],
      [
        `max by (check_id) (${mergedQuantile(0.95, 'check_id, location', duration, seconds, resolution)})`,
        true,
      ],
      [
        `min by (check_id) (last_over_time(${selector('synthetics_cert_expiry_seconds', only)}[2h]))`,
        true,
      ],
      [`sum by (check_id) (sum_over_time(${selector('synthetics_up', only)}[3600s]))`, false],
      [`sum by (check_id) (count_over_time(${selector('synthetics_up', only)}[3600s]))`, false],
      [`sum by (location) (sum_over_time(synthetics_up{check_id="c-1"}[${step}s]))`, false],
      [
        `sum by (step_index, step, location) (sum_over_time(${selector('synthetics_step_up', only)}[${seconds}s]))`,
        true,
      ],
      [
        mergedQuantile(
          0.5,
          'step_index, step, location',
          selector('synthetics_step_duration_seconds', only),
          seconds,
          resolution,
        ),
        true,
      ],
      [
        mergedQuantile(
          0.95,
          'step_index, step, location',
          selector('synthetics_step_duration_seconds', only),
          720,
          resolution,
        ),
        false,
      ],
      [mergedQuantile(0.95, 'location', duration, seconds, resolution), true],
      [passRatio('location', only, 3600), false],
      [`min by (location) (min_over_time(${selector('synthetics_up', only)}[${step}s]))`, false],
      [mean('location', duration, step), false],
      [mean('phase', selector('synthetics_duration_seconds', only, 'phase!="total"'), step), false],
      [mean('', selector('synthetics_response_bytes', only), step), false],
      [`max(max_over_time(${selector('synthetics_redirects', only)}[${step}s]))`, false],
      [mean('location', selector('synthetics_icmp_rtt_seconds', only), step), false],
      [
        `max by (location) (max_over_time(${selector('synthetics_icmp_loss_ratio', only)}[${step}s]))`,
        false,
      ],
    ];
    for (const [query, isInstant] of queries) {
      const response = isInstant
        ? evaluatePromQL(SYN_PROJECT, { query, instant: true })
        : ranged(SYN_PROJECT, query, 24, step);
      expect(response.series.length, query).toBeGreaterThan(0);
    }
    const ratio = evaluatePromQL(SYN_PROJECT, {
      query: passRatio('location', only, 3600),
      instant: true,
    });
    for (const s of ratio.series) {
      expect(s.points[0].value).toBeGreaterThan(0.9);
      expect(s.points[0].value).toBeLessThanOrEqual(1);
    }
    const runs = evaluatePromQL(SYN_PROJECT, {
      query: `sum by (check_id) (count_over_time(${selector('synthetics_up', only)}[3600s]))`,
      instant: true,
    });
    expect(runs.series[0].points[0].value).toBe(120); // 60 runs x 2 locations: never resampled
  });
});

// ---------------------------------------------------------------------------
// Speed: dashboards fire a dozen of these at once.
// ---------------------------------------------------------------------------

describe('performance', () => {
  const timed = (query: string, stepSeconds?: number) => {
    const started = performance.now();
    const response = ranged(PROJECT_ID, query, 24, stepSeconds);
    return { response, ms: performance.now() - started };
  };

  it('answers 24 h range queries over ~50 series well under 150 ms', () => {
    const queries = [
      'sum by (k8s_pod_name) (rate(k8s_pod_network_io[5m]))',
      'histogram_quantile(0.99, sum by (le, service_name) (rate(http_server_request_duration_bucket[5m])))',
      'sum by (k8s_namespace_name, k8s_pod_name) (k8s_pod_memory_working_set)',
      'sum by (state) (rate(system_cpu_time[5m]))',
    ];
    timed(queries[0]); // warm-up (profile tables, JIT)
    for (const query of queries) {
      const { response, ms } = timed(query);
      expect(response.series.length, query).toBeGreaterThan(0);
      expect(ms, query).toBeLessThan(150);
    }
    const fine = timed('sum by (service_name) (rate(http_server_request_duration_count[5m]))', 60);
    expect(fine.response.series[0].points.length).toBe(1441);
    expect(fine.ms).toBeLessThan(300);
  });
});
