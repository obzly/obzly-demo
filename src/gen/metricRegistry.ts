// Where the demo's metric series come from. Each area registers a provider
// for its metric names (host/k8s/http metrics, synthetics_*, inventory...);
// the PromQL evaluator (../query/promql.ts) reads raw samples through here.

export type Labels = Record<string, string>;

/** A label matcher from a selector: {job="api"}, {code=~"5.."}... */
export interface LabelMatcher {
  name: string;
  op: '=' | '!=' | '=~' | '!~';
  value: string;
}

export interface RawSeries {
  /** Includes __name__. */
  labels: Labels;
  /** Sample timestamps (ms) and values, oldest first, inside [from, to]. */
  timestamps: number[];
  values: number[];
}

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

export interface MetricInfo {
  name: string;
  type: MetricType;
  help: string;
  unit?: string;
}

export interface SeriesProvider {
  /** The metric names this provider owns (histograms list their _bucket/_sum/_count). */
  metrics(projectId: string): MetricInfo[];
  /**
   * Every series of `name` matching the matchers, sampled every `scrapeMs`
   * between from and to. Must be deterministic for the same inputs.
   */
  series(
    projectId: string,
    name: string,
    matchers: LabelMatcher[],
    from: number,
    to: number,
    scrapeMs: number,
  ): RawSeries[];
}

const providers: SeriesProvider[] = [];

export function registerSeriesProvider(provider: SeriesProvider) {
  providers.push(provider);
}

export function allMetrics(projectId: string): MetricInfo[] {
  return providers.flatMap((provider) => provider.metrics(projectId));
}

export function selectSeries(
  projectId: string,
  name: string,
  matchers: LabelMatcher[],
  from: number,
  to: number,
  scrapeMs: number,
): RawSeries[] {
  for (const provider of providers) {
    if (provider.metrics(projectId).some((metric) => metric.name === name)) {
      return provider.series(projectId, name, matchers, from, to, scrapeMs);
    }
  }
  return [];
}

export function matchLabel(labels: Labels, matcher: LabelMatcher): boolean {
  const actual = labels[matcher.name] ?? '';
  switch (matcher.op) {
    case '=':
      return actual === matcher.value;
    case '!=':
      return actual !== matcher.value;
    case '=~':
      return new RegExp(`^(?:${matcher.value})$`).test(actual);
    case '!~':
      return !new RegExp(`^(?:${matcher.value})$`).test(actual);
  }
}

export const matchAll = (labels: Labels, matchers: LabelMatcher[]) =>
  matchers.every((matcher) => matchLabel(labels, matcher));
