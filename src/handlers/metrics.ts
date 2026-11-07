// Metrics: metric names (panel editor suggestions), label values (dashboard
// variables and filter bar), project stats, and PromQL queries (dashboards,
// alert previews, synthetics, Infrastructure). Series come from the metric
// registry: ../gen/metrics (imported here so it registers) and other areas'
// providers such as synthetics.
import type { PromQLRequest } from '../../entity/synthetics';
import { type LabelMatcher, allMetrics, selectSeries } from '../gen/metricRegistry';
import { compileMatchers } from '../gen/metricShapes';
import { generatedLabelValues, generatedSeriesCount, isGeneratedMetric } from '../gen/metrics';
import { evaluatePromQL } from '../query/promql';
import { normalizeLabelName, normalizeMetricName } from '../query/promqlParse';
import { DemoError, type Router } from '../router';
import { dataStart } from '../world';
import { requireProject } from './bootstrap';

const HOUR = 3_600_000;

interface LabelValuesBody {
  labelName?: string;
  matchers?: { name?: string; type?: string; value?: string }[];
  timeRange?: { from?: string; to?: string };
}

function metricNames(projectId: string) {
  const seen = new Map<string, 'gauge' | 'counter'>();
  for (const info of allMetrics(projectId)) {
    if (!seen.has(info.name)) seen.set(info.name, info.type === 'gauge' ? 'gauge' : 'counter');
  }
  return {
    metrics: [...seen]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, type]) => ({ name, type })),
  };
}

const valuesCache = new Map<string, { at: number; values: string[] }>();

function labelValues(projectId: string, body: LabelValuesBody): { values: string[] } {
  if (!body.labelName) throw new DemoError(400, 'labelName is required');
  const label = normalizeLabelName(body.labelName);
  const now = Date.now();
  const from = Math.max(
    body.timeRange?.from ? Date.parse(body.timeRange.from) : dataStart(now),
    dataStart(now),
  );
  const to = Math.min(body.timeRange?.to ? Date.parse(body.timeRange.to) : now, now);
  if (!Number.isFinite(from) || !Number.isFinite(to))
    throw new DemoError(400, 'Invalid time range');

  const matchers: LabelMatcher[] = (body.matchers ?? [])
    .filter((m) => m.name && ['=', '!=', '=~', '!~'].includes(m.type ?? ''))
    .map((m) => {
      const name = normalizeLabelName(m.name!);
      const op = m.type as LabelMatcher['op'];
      const value =
        name === '__name__' && (op === '=' || op === '!=')
          ? normalizeMetricName(m.value ?? '')
          : (m.value ?? '');
      return { name, op, value };
    });

  const key = `${projectId}|${label}|${JSON.stringify(matchers)}|${Math.floor(from / HOUR)}|${Math.floor(to / HOUR)}`;
  const hit = valuesCache.get(key);
  if (hit && now - hit.at < 60_000) return { values: hit.values };

  const nameMatch = compileMatchers(matchers.filter((m) => m.name === '__name__'));
  const labelMatchers = matchers.filter((m) => m.name !== '__name__');
  const names = [...new Set(allMetrics(projectId).map((info) => info.name))].filter((name) =>
    nameMatch({ __name__: name }),
  );
  const values = new Set<string>();
  if (label === '__name__' && !labelMatchers.length) {
    names.forEach((name) => values.add(name));
  } else {
    if (!matchers.length) {
      generatedLabelValues(projectId, label, from, to).forEach((v) => values.add(v));
    }
    for (const name of names) {
      if (!matchers.length && isGeneratedMetric(name)) continue;
      const scrape = isGeneratedMetric(name) ? 6 * HOUR : 30_000;
      for (const series of selectSeries(projectId, name, labelMatchers, from, to, scrape)) {
        const value = series.labels[label];
        if (value) values.add(value);
      }
    }
  }
  const sorted = [...values].sort();
  if (valuesCache.size > 200) valuesCache.clear();
  valuesCache.set(key, { at: now, values: sorted });
  return { values: sorted };
}

function stats(projectId: string) {
  const now = Date.now();
  const oldest = dataStart(now);
  const series = generatedSeriesCount(projectId, now);
  const samples = Math.round((series * (now - oldest)) / 30_000);
  const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  return {
    totalSamples: samples,
    totalSizeMb: mb(samples * 1.37),
    rawSizeMb: mb(samples * 16),
    oldestSampleTime: new Date(oldest).toISOString(),
    newestSampleTime: new Date(now - 12_000).toISOString(),
  };
}

export function register(r: Router) {
  r.get('/metrics/query/names/:pid', (req) => metricNames(requireProject(req.params.pid).id));
  r.post('/metrics/query/label-values/:pid', (req) =>
    labelValues(requireProject(req.params.pid).id, (req.body ?? {}) as LabelValuesBody),
  );
  r.get('/metrics/query/stats/:pid', (req) => stats(requireProject(req.params.pid).id));
  r.post('/metrics/query/promql/:pid', (req) =>
    evaluatePromQL(requireProject(req.params.pid).id, (req.body ?? {}) as PromQLRequest),
  );
}
