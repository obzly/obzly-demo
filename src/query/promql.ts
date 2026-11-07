// A PromQL evaluator over the demo's metric registry (../gen/metricRegistry),
// answering POST /metrics/query/promql/:pid the way the backend does
// (metrics/querying/promql.go): range or instant queries, auto step of ~60
// points, the 100-series default limit with `truncated`, NaN/Inf as 0.
//
// Values are evaluated for every step at once: an instant vector is a list of
// series, each a Float64Array over the steps with NaN where it has no sample.
// Raw samples come from the providers, fetched only around the steps a
// selector needs. A NaN result (0/0) therefore reads as "no sample", which the
// backend would show as 0; everything else follows Prometheus 3 semantics.
import type {
  PromQLPoint,
  PromQLRequest,
  PromQLResponse,
  PromQLSeries,
} from '../../entity/synthetics';
import { type LabelMatcher, type Labels, allMetrics, selectSeries } from '../gen/metricRegistry';
import { SCRAPE_MS, anchored, compileMatchers } from '../gen/metricShapes';
import { isGeneratedMetric } from '../gen/metrics';
import { DemoError } from '../router';
import {
  type AtModifier,
  COMPARISON,
  type Expr,
  PromQLError,
  SET_OPS,
  SUBSET_NOTE,
  type SelectorNode,
  type VectorMatching,
  parsePromQL,
  scalarOp,
  typeOf,
} from './promqlParse';

export { PromQLError, parsePromQL } from './promqlParse';

const LOOKBACK = 5 * 60_000;
const DEFAULT_SUBQUERY_STEP = 60_000;
const DEFAULT_POINTS = 60;
const MAX_POINTS = 11_000;
const DEFAULT_SERIES = 100;
const HARD_MAX_SERIES = 10_000;
const MAX_INNER_STEPS = 250_000;

/** Prometheus-exporter names (unit suffix) other stacks use for the same series. */
const ALIASES: Record<string, string> = {
  http_server_request_duration_seconds_bucket: 'http_server_request_duration_bucket',
  http_server_request_duration_seconds_sum: 'http_server_request_duration_sum',
  http_server_request_duration_seconds_count: 'http_server_request_duration_count',
  db_client_connection_wait_time_seconds_bucket: 'db_client_connection_wait_time_bucket',
  db_client_connection_wait_time_seconds_sum: 'db_client_connection_wait_time_sum',
  db_client_connection_wait_time_seconds_count: 'db_client_connection_wait_time_count',
  jvm_gc_duration_seconds_bucket: 'jvm_gc_duration_bucket',
  jvm_gc_duration_seconds_sum: 'jvm_gc_duration_sum',
  jvm_gc_duration_seconds_count: 'jvm_gc_duration_count',
};

interface Series {
  labels: Labels;
  v: Float64Array;
  /** __name__ is dropped from the output (kept until then, like Prometheus 3's delayed removal). */
  dropName?: boolean;
}

interface Raw {
  labels: Labels;
  ts: number[];
  vs: number[];
  dropName?: boolean;
}

type Value =
  | { t: 'scalar'; v: Float64Array }
  | { t: 'vector'; s: Series[] }
  | { t: 'string'; s: string }
  | { t: 'matrix'; s: Raw[] };

const labelsKey = (labels: Labels): string => {
  const keys = Object.keys(labels).sort();
  let out = '';
  for (const k of keys) out += `${k}\u0000${labels[k]}\u0001`;
  return out;
};

const withoutName = (labels: Labels): Labels => {
  if (!('__name__' in labels)) return labels;
  const copy = { ...labels };
  delete copy.__name__;
  return copy;
};

const nan = (n: number) => new Float64Array(n).fill(NaN);

/** Raw scrape interval to ask generated metrics for: ~120 samples per window, 30 s minimum. */
const NICE_SCRAPES = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400].map(
  (s) => s * 1000,
);
function scrapeFor(windowMs: number): number {
  if (windowMs <= 3_600_000) return SCRAPE_MS;
  const want = windowMs / 120;
  return NICE_SCRAPES.find((s) => s >= want) ?? 86_400_000;
}

// ---------------------------------------------------------------------------
// Range-vector functions over one series' samples in (te - window, te].
// ---------------------------------------------------------------------------

type RangeFn = (
  ts: number[],
  vs: number[],
  lo: number,
  hi: number,
  te: number,
  window: number,
  i: number,
) => number;

function extrapolatedRate(isCounter: boolean, isRate: boolean): RangeFn {
  return (ts, vs, lo, hi, te, window) => {
    const n = hi - lo;
    if (n < 2) return NaN;
    const first = vs[lo];
    const last = vs[hi - 1];
    let result = last - first;
    if (isCounter) {
      let prev = first;
      for (let j = lo + 1; j < hi; j++) {
        if (vs[j] < prev) result += prev;
        prev = vs[j];
      }
    }
    const rangeStart = te - window;
    let toStart = (ts[lo] - rangeStart) / 1000;
    const toEnd = (te - ts[hi - 1]) / 1000;
    const sampled = (ts[hi - 1] - ts[lo]) / 1000;
    if (sampled <= 0) return NaN;
    const avg = sampled / (n - 1);
    if (isCounter && result > 0 && first >= 0) {
      const toZero = sampled * (first / result);
      if (toZero < toStart) toStart = toZero;
    }
    const threshold = avg * 1.1;
    let interval = sampled;
    interval += toStart >= threshold ? avg / 2 : toStart;
    interval += toEnd >= threshold ? avg / 2 : toEnd;
    let factor = interval / sampled;
    if (isRate) factor /= window / 1000;
    return result * factor;
  };
}

function linearRegression(
  ts: number[],
  vs: number[],
  lo: number,
  hi: number,
  interceptTime: number,
) {
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let constY = true;
  for (let j = lo; j < hi; j++) {
    if (vs[j] !== vs[lo]) constY = false;
    const x = (ts[j] - interceptTime) / 1000;
    n++;
    sumX += x;
    sumY += vs[j];
    sumXY += x * vs[j];
    sumX2 += x * x;
  }
  if (constY) return { slope: 0, intercept: vs[lo] };
  const covXY = sumXY - (sumX * sumY) / n;
  const varX = sumX2 - (sumX * sumX) / n;
  const slope = covXY / varX;
  return { slope, intercept: sumY / n - (slope * sumX) / n };
}

function quantile(q: number, values: number[]): number {
  if (!values.length || Number.isNaN(q)) return NaN;
  if (q < 0) return -Infinity;
  if (q > 1) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = q * (sorted.length - 1);
  const lower = Math.max(0, Math.floor(rank));
  const upper = Math.min(sorted.length - 1, lower + 1);
  const weight = rank - Math.floor(rank);
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

const variance = (vs: number[], lo: number, hi: number) => {
  let mean = 0;
  let m2 = 0;
  let count = 0;
  for (let j = lo; j < hi; j++) {
    count++;
    const delta = vs[j] - mean;
    mean += delta / count;
    m2 += delta * (vs[j] - mean);
  }
  return m2 / count;
};

const RANGE_FNS: Record<string, RangeFn> = {
  rate: extrapolatedRate(true, true),
  increase: extrapolatedRate(true, false),
  delta: extrapolatedRate(false, false),
  irate: (ts, vs, lo, hi) => {
    if (hi - lo < 2) return NaN;
    const last = vs[hi - 1];
    const prev = vs[hi - 2];
    const dt = (ts[hi - 1] - ts[hi - 2]) / 1000;
    if (dt <= 0) return NaN;
    return (last < prev ? last : last - prev) / dt;
  },
  idelta: (_ts, vs, lo, hi) => (hi - lo < 2 ? NaN : vs[hi - 1] - vs[hi - 2]),
  deriv: (ts, vs, lo, hi) => (hi - lo < 2 ? NaN : linearRegression(ts, vs, lo, hi, ts[lo]).slope),
  changes: (_ts, vs, lo, hi) => {
    let n = 0;
    for (let j = lo + 1; j < hi; j++) if (vs[j] !== vs[j - 1]) n++;
    return n;
  },
  resets: (_ts, vs, lo, hi) => {
    let n = 0;
    for (let j = lo + 1; j < hi; j++) if (vs[j] < vs[j - 1]) n++;
    return n;
  },
  avg_over_time: (_ts, vs, lo, hi) => {
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += vs[j];
    return sum / (hi - lo);
  },
  sum_over_time: (_ts, vs, lo, hi) => {
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += vs[j];
    return sum;
  },
  min_over_time: (_ts, vs, lo, hi) => {
    let min = vs[lo];
    for (let j = lo + 1; j < hi; j++) if (vs[j] < min || Number.isNaN(min)) min = vs[j];
    return min;
  },
  max_over_time: (_ts, vs, lo, hi) => {
    let max = vs[lo];
    for (let j = lo + 1; j < hi; j++) if (vs[j] > max || Number.isNaN(max)) max = vs[j];
    return max;
  },
  count_over_time: (_ts, _vs, lo, hi) => hi - lo,
  last_over_time: (_ts, vs, _lo, hi) => vs[hi - 1],
  first_over_time: (_ts, vs, lo) => vs[lo],
  present_over_time: () => 1,
  stddev_over_time: (_ts, vs, lo, hi) => Math.sqrt(variance(vs, lo, hi)),
  stdvar_over_time: (_ts, vs, lo, hi) => variance(vs, lo, hi),
  mad_over_time: (_ts, vs, lo, hi) => {
    const window = vs.slice(lo, hi);
    const median = quantile(0.5, window);
    return quantile(
      0.5,
      window.map((v) => Math.abs(v - median)),
    );
  },
};

/** Functions that keep the metric name. */
const KEEPS_NAME = new Set(['last_over_time', 'first_over_time']);

const MATH: Record<string, (x: number) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sgn: Math.sign,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  deg: (x) => (x * 180) / Math.PI,
  rad: (x) => (x * Math.PI) / 180,
};

const DATE_FNS: Record<string, (d: Date) => number> = {
  minute: (d) => d.getUTCMinutes(),
  hour: (d) => d.getUTCHours(),
  day_of_week: (d) => d.getUTCDay(),
  day_of_month: (d) => d.getUTCDate(),
  day_of_year: (d) =>
    Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1,
  days_in_month: (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(),
  month: (d) => d.getUTCMonth() + 1,
  year: (d) => d.getUTCFullYear(),
};

/** Go regexp.Expand: $1, ${1}, $name, ${name}, $$. */
function expand(template: string, match: RegExpExecArray): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c !== '$' || i === template.length - 1) {
      out += c;
      continue;
    }
    if (template[i + 1] === '$') {
      out += '$';
      i++;
      continue;
    }
    let name: string;
    if (template[i + 1] === '{') {
      const close = template.indexOf('}', i + 2);
      if (close < 0) {
        out += c;
        continue;
      }
      name = template.slice(i + 2, close);
      i = close;
    } else {
      const m = /^[a-zA-Z0-9_]+/.exec(template.slice(i + 1));
      if (!m) {
        out += c;
        continue;
      }
      name = m[0];
      i += m[0].length;
    }
    if (/^\d+$/.test(name)) out += match[Number(name)] ?? '';
    else out += match.groups?.[name] ?? '';
  }
  return out;
}

/** A classic-histogram quantile from (upper bound, cumulative count) pairs sorted by bound. */
function bucketQuantile(q: number, les: number[], counts: number[]): number {
  if (Number.isNaN(q)) return NaN;
  if (q < 0) return -Infinity;
  if (q > 1) return Infinity;
  const n = les.length;
  if (n < 2 || les[n - 1] !== Infinity) return NaN;
  // Make the counts monotonic (buckets can be scraped at slightly different times).
  const c = counts.slice();
  for (let k = 1; k < n; k++) if (c[k] < c[k - 1]) c[k] = c[k - 1];
  const observations = c[n - 1];
  if (observations === 0) return NaN;
  let rank = q * observations;
  let b = 0;
  while (b < n - 1 && c[b] < rank) b++;
  if (b === n - 1) return les[n - 2];
  if (b === 0 && les[0] <= 0) return les[0];
  let start = 0;
  const end = les[b];
  let count = c[b];
  if (b > 0) {
    start = les[b - 1];
    count -= c[b - 1];
    rank -= c[b - 1];
  }
  return start + (end - start) * (rank / count);
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

class Evaluator {
  readonly n: number;
  private metricNames: string[] | undefined;

  constructor(
    readonly projectId: string,
    readonly steps: number[],
    readonly start: number,
    readonly end: number,
    readonly fetchCache: Map<string, Raw[]>,
  ) {
    this.n = steps.length;
  }

  private times(offset: number, at?: AtModifier): number[] {
    const fixed = at
      ? at.ref === 'start'
        ? this.start
        : at.ref === 'end'
          ? this.end
          : at.time!
      : undefined;
    return this.steps.map((t) => (fixed ?? t) - offset);
  }

  private names(sel: SelectorNode): string[] {
    this.metricNames ??= [...new Set(allMetrics(this.projectId).map((info) => info.name))];
    const known = this.metricNames;
    if (sel.name !== undefined) {
      if (known.includes(sel.name)) return [sel.name];
      const alias = ALIASES[sel.name];
      return alias && known.includes(alias) ? [alias] : [];
    }
    const match = compileMatchers(sel.matchers.filter((m) => m.name === '__name__'));
    return known.filter((name) => match({ __name__: name }));
  }

  /** Raw samples of a selector in (t - window, t] around each evaluation time. */
  private fetch(sel: SelectorNode, window: number, times: number[]): Raw[] {
    if (!times.length) return [];
    const sample =
      times.length <= 64
        ? times.join(',')
        : `${times[0]},${times[times.length >> 1]},${times[times.length - 1]},${times.length}`;
    const key = `${sel.name ?? ''}|${JSON.stringify(sel.matchers)}|${window}|${sample}`;
    const hit = this.fetchCache.get(key);
    if (hit) return hit;

    const intervals: [number, number][] = [];
    for (const t of times) {
      const lo = t - window;
      const last = intervals[intervals.length - 1];
      if (last && lo <= last[1]) last[1] = Math.max(last[1], t);
      else intervals.push([lo, t]);
    }
    const labelMatchers: LabelMatcher[] = sel.matchers.filter((m) => m.name !== '__name__');
    const match = compileMatchers(labelMatchers);
    const out: Raw[] = [];
    for (const name of this.names(sel)) {
      const scrape = isGeneratedMetric(name) ? scrapeFor(window) : SCRAPE_MS;
      let ranges = intervals;
      if (intervals.length > 1) {
        const dense = (intervals[intervals.length - 1][1] - intervals[0][0]) / scrape;
        const sparse = intervals.reduce((s, [lo, hi]) => s + (hi - lo) / scrape, 0);
        if (dense <= 4 * sparse || intervals.length > 300) {
          ranges = [[intervals[0][0], intervals[intervals.length - 1][1]]];
        }
      }
      if (ranges.length === 1) {
        const [lo, hi] = ranges[0];
        for (const raw of selectSeries(this.projectId, name, labelMatchers, lo + 1, hi, scrape)) {
          if (raw.timestamps.length && match(raw.labels)) {
            out.push({ labels: raw.labels, ts: raw.timestamps, vs: raw.values });
          }
        }
        continue;
      }
      const merged = new Map<string, { labels: Labels; ts: number[][]; vs: number[][] }>();
      for (const [lo, hi] of ranges) {
        for (const raw of selectSeries(this.projectId, name, labelMatchers, lo + 1, hi, scrape)) {
          if (!raw.timestamps.length || !match(raw.labels)) continue;
          const k = labelsKey(raw.labels);
          let entry = merged.get(k);
          if (!entry) {
            entry = { labels: raw.labels, ts: [], vs: [] };
            merged.set(k, entry);
          }
          entry.ts.push(raw.timestamps);
          entry.vs.push(raw.values);
        }
      }
      for (const entry of merged.values()) {
        out.push({ labels: entry.labels, ts: entry.ts.flat(), vs: entry.vs.flat() });
      }
    }
    if (this.fetchCache.size > 200) this.fetchCache.clear();
    this.fetchCache.set(key, out);
    return out;
  }

  eval(expr: Expr): Value {
    switch (expr.kind) {
      case 'number':
        return { t: 'scalar', v: new Float64Array(this.n).fill(expr.value) };
      case 'string':
        return { t: 'string', s: expr.value };
      case 'paren':
        return this.eval(expr.expr);
      case 'selector':
        return { t: 'vector', s: this.selector(expr) };
      case 'matrix':
      case 'subquery':
        return { t: 'matrix', s: this.rangeArg(expr).raws };
      case 'unary': {
        const value = this.eval(expr.expr);
        if (value.t === 'scalar') return { t: 'scalar', v: value.v.map((x) => -x) };
        if (value.t === 'vector') {
          return {
            t: 'vector',
            s: value.s.map((s) => ({ labels: s.labels, v: s.v.map((x) => -x), dropName: true })),
          };
        }
        throw new PromQLError('unary minus needs a scalar or an instant vector');
      }
      case 'call':
        return this.call(expr);
      case 'agg':
        return { t: 'vector', s: this.aggregate(expr) };
      case 'binary':
        return this.binary(expr);
    }
  }

  private vector(expr: Expr): Series[] {
    const value = this.eval(expr);
    if (value.t !== 'vector') throw new PromQLError(`expected an instant vector, got ${value.t}`);
    return value.s;
  }

  private scalar(expr: Expr): Float64Array {
    const value = this.eval(expr);
    if (value.t !== 'scalar') throw new PromQLError(`expected a scalar, got ${value.t}`);
    return value.v;
  }

  private string(expr: Expr): string {
    const value = this.eval(expr);
    if (value.t !== 'string') throw new PromQLError(`expected a string, got ${value.t}`);
    return value.s;
  }

  private selector(sel: SelectorNode): Series[] {
    const times = this.times(sel.offset, sel.at);
    const raws = this.fetch(sel, LOOKBACK, times);
    const out: Series[] = [];
    for (const raw of raws) {
      const v = nan(this.n);
      let j = 0;
      let any = false;
      for (let i = 0; i < this.n; i++) {
        const te = times[i];
        if (i > 0 && te < times[i - 1]) j = 0;
        while (j < raw.ts.length && raw.ts[j] <= te) j++;
        const last = j - 1;
        if (last >= 0 && raw.ts[last] > te - LOOKBACK) {
          v[i] = raw.vs[last];
          any = true;
        }
      }
      if (any) out.push({ labels: raw.labels, v });
    }
    return out;
  }

  private rangeArg(expr: Expr): { raws: Raw[]; times: number[]; window: number } {
    if (expr.kind === 'paren') return this.rangeArg(expr.expr);
    if (expr.kind === 'matrix') {
      const times = this.times(expr.selector.offset, expr.selector.at);
      return { raws: this.fetch(expr.selector, expr.range, times), times, window: expr.range };
    }
    if (expr.kind === 'subquery') {
      const times = this.times(expr.offset, expr.at);
      const step = expr.step ?? DEFAULT_SUBQUERY_STEP;
      if (step <= 0) throw new PromQLError('zero or negative subquery step');
      // Inner steps are multiples of the step (aligned to the epoch) inside each window.
      const inner: number[] = [];
      let last = -Infinity;
      for (const t of times) {
        let x = Math.floor((t - expr.range) / step) * step + step;
        if (x <= last) x = last + step;
        for (; x <= t; x += step) {
          inner.push(x);
          last = x;
          if (inner.length > MAX_INNER_STEPS) {
            throw new PromQLError(
              `subquery resolution too fine: over ${MAX_INNER_STEPS} steps ${SUBSET_NOTE}`,
            );
          }
        }
      }
      const sub = new Evaluator(this.projectId, inner, this.start, this.end, this.fetchCache);
      const value = sub.eval(expr.expr);
      const series: Series[] =
        value.t === 'vector' ? value.s : value.t === 'scalar' ? [{ labels: {}, v: value.v }] : [];
      const raws: Raw[] = [];
      for (const s of series) {
        const ts: number[] = [];
        const vs: number[] = [];
        for (let k = 0; k < inner.length; k++) {
          if (!Number.isNaN(s.v[k])) {
            ts.push(inner[k]);
            vs.push(s.v[k]);
          }
        }
        if (ts.length) raws.push({ labels: s.labels, ts, vs, dropName: s.dropName });
      }
      return { raws, times, window: expr.range };
    }
    throw new PromQLError(`expected a range vector, got ${typeOf(expr)}`);
  }

  /** Applies a range function per series and step (two moving pointers over its samples). */
  private overTime(arg: Expr, fn: RangeFn, keepName: boolean): Series[] {
    const { raws, times, window } = this.rangeArg(arg);
    const out: Series[] = [];
    for (const raw of raws) {
      const v = nan(this.n);
      let lo = 0;
      let hi = 0;
      let any = false;
      for (let i = 0; i < this.n; i++) {
        const te = times[i];
        if (i > 0 && te < times[i - 1]) {
          lo = 0;
          hi = 0;
        }
        while (hi < raw.ts.length && raw.ts[hi] <= te) hi++;
        while (lo < hi && raw.ts[lo] <= te - window) lo++;
        if (lo < hi) {
          const value = fn(raw.ts, raw.vs, lo, hi, te, window, i);
          if (!Number.isNaN(value)) {
            v[i] = value;
            any = true;
          }
        }
      }
      if (any) out.push({ labels: raw.labels, v, dropName: keepName ? raw.dropName : true });
    }
    return out;
  }

  private mapSeries(
    series: Series[],
    fn: (x: number, i: number) => number,
    keepName = false,
  ): Series[] {
    const out: Series[] = [];
    for (const s of series) {
      const v = new Float64Array(this.n);
      let any = false;
      for (let i = 0; i < this.n; i++) {
        const x = s.v[i];
        v[i] = Number.isNaN(x) ? NaN : fn(x, i);
        if (!Number.isNaN(v[i])) any = true;
      }
      if (any) out.push({ labels: s.labels, v, dropName: keepName ? s.dropName : true });
    }
    return out;
  }

  private call(expr: Extract<Expr, { kind: 'call' }>): Value {
    const { func, args } = expr;
    const range = RANGE_FNS[func];
    if (range) return { t: 'vector', s: this.overTime(args[0], range, KEEPS_NAME.has(func)) };
    const math = MATH[func];
    if (math) return { t: 'vector', s: this.mapSeries(this.vector(args[0]), math) };
    const date = DATE_FNS[func];
    if (date) {
      const input = args.length
        ? this.vector(args[0])
        : [{ labels: {}, v: Float64Array.from(this.steps, (t) => t / 1000) }];
      return { t: 'vector', s: this.mapSeries(input, (x) => date(new Date(x * 1000))) };
    }
    switch (func) {
      case 'time':
        return { t: 'scalar', v: Float64Array.from(this.steps, (t) => t / 1000) };
      case 'pi':
        return { t: 'scalar', v: new Float64Array(this.n).fill(Math.PI) };
      case 'vector':
        return { t: 'vector', s: [{ labels: {}, v: this.scalar(args[0]).slice() }] };
      case 'scalar': {
        const input = this.vector(args[0]);
        const v = nan(this.n);
        for (let i = 0; i < this.n; i++) {
          let count = 0;
          let value = NaN;
          for (const s of input) {
            if (!Number.isNaN(s.v[i])) {
              count++;
              value = s.v[i];
            }
          }
          v[i] = count === 1 ? value : NaN;
        }
        return { t: 'scalar', v };
      }
      case 'timestamp':
        return {
          t: 'vector',
          s: this.mapSeries(this.vector(args[0]), (_x, i) => this.steps[i] / 1000),
        };
      case 'quantile_over_time': {
        const q = this.scalar(args[0]);
        const fn: RangeFn = (_ts, vs, lo, hi, _te, _w, i) => quantile(q[i], vs.slice(lo, hi));
        return { t: 'vector', s: this.overTime(args[1], fn, false) };
      }
      case 'predict_linear': {
        const seconds = this.scalar(args[1]);
        const fn: RangeFn = (ts, vs, lo, hi, te, _w, i) => {
          if (hi - lo < 2) return NaN;
          const { slope, intercept } = linearRegression(ts, vs, lo, hi, te);
          return intercept + slope * seconds[i];
        };
        return { t: 'vector', s: this.overTime(args[0], fn, false) };
      }
      case 'absent_over_time': {
        const { raws, times, window } = this.rangeArg(args[0]);
        const present = new Uint8Array(this.n);
        for (const raw of raws) {
          let lo = 0;
          let hi = 0;
          for (let i = 0; i < this.n; i++) {
            const te = times[i];
            while (hi < raw.ts.length && raw.ts[hi] <= te) hi++;
            while (lo < hi && raw.ts[lo] <= te - window) lo++;
            if (lo < hi) present[i] = 1;
          }
        }
        return { t: 'vector', s: this.absentResult(present, args[0]) };
      }
      case 'absent': {
        const input = this.vector(args[0]);
        const present = new Uint8Array(this.n);
        for (const s of input) {
          for (let i = 0; i < this.n; i++) if (!Number.isNaN(s.v[i])) present[i] = 1;
        }
        return { t: 'vector', s: this.absentResult(present, args[0]) };
      }
      case 'round': {
        const nearest = args[1] ? this.scalar(args[1]) : undefined;
        return {
          t: 'vector',
          s: this.mapSeries(this.vector(args[0]), (x, i) => {
            const inverse = 1 / (nearest ? nearest[i] : 1);
            return Math.floor(x * inverse + 0.5) / inverse;
          }),
        };
      }
      case 'clamp': {
        const input = this.vector(args[0]);
        const min = this.scalar(args[1]);
        const max = this.scalar(args[2]);
        return {
          t: 'vector',
          s: this.mapSeries(input, (x, i) =>
            min[i] > max[i] ? NaN : Math.max(min[i], Math.min(max[i], x)),
          ),
        };
      }
      case 'clamp_min': {
        const min = this.scalar(args[1]);
        return {
          t: 'vector',
          s: this.mapSeries(this.vector(args[0]), (x, i) => Math.max(min[i], x)),
        };
      }
      case 'clamp_max': {
        const max = this.scalar(args[1]);
        return {
          t: 'vector',
          s: this.mapSeries(this.vector(args[0]), (x, i) => Math.min(max[i], x)),
        };
      }
      case 'sort':
      case 'sort_desc': {
        const input = this.vector(args[0]);
        const sign = func === 'sort' ? 1 : -1;
        const last = this.n - 1;
        const sorted = [...input].sort((a, b) => {
          const x = a.v[last];
          const y = b.v[last];
          if (Number.isNaN(x)) return 1;
          if (Number.isNaN(y)) return -1;
          return sign * (x - y);
        });
        return { t: 'vector', s: sorted };
      }
      case 'histogram_quantile':
        return {
          t: 'vector',
          s: this.histogramQuantile(this.scalar(args[0]), this.vector(args[1])),
        };
      case 'label_replace': {
        const input = this.vector(args[0]);
        const dst = this.string(args[1]);
        const replacement = this.string(args[2]);
        const src = this.string(args[3]);
        const re = anchored(this.string(args[4]));
        return {
          t: 'vector',
          s: input.map((s) => {
            const m = re.exec(s.labels[src] ?? '');
            if (!m) return s;
            const value = expand(replacement, m);
            const labels = { ...s.labels };
            if (value === '') delete labels[dst];
            else labels[dst] = value;
            return { labels, v: s.v, dropName: s.dropName && dst !== '__name__' };
          }),
        };
      }
      case 'label_join': {
        const input = this.vector(args[0]);
        const dst = this.string(args[1]);
        const sep = this.string(args[2]);
        const srcs = args.slice(3).map((arg) => this.string(arg));
        return {
          t: 'vector',
          s: input.map((s) => {
            const value = srcs.map((src) => s.labels[src] ?? '').join(sep);
            const labels = { ...s.labels };
            if (value === '') delete labels[dst];
            else labels[dst] = value;
            return { labels, v: s.v, dropName: s.dropName };
          }),
        };
      }
      default:
        throw new PromQLError(`The function ${func}() isn't supported ${SUBSET_NOTE}`);
    }
  }

  private absentResult(present: Uint8Array, arg: Expr): Series[] {
    const v = nan(this.n);
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (!present[i]) {
        v[i] = 1;
        any = true;
      }
    }
    if (!any) return [];
    let node = arg;
    while (node.kind === 'paren') node = node.expr;
    const sel =
      node.kind === 'selector' ? node : node.kind === 'matrix' ? node.selector : undefined;
    const labels: Labels = {};
    if (sel) {
      const seen = new Map<string, number>();
      for (const m of sel.matchers) seen.set(m.name, (seen.get(m.name) ?? 0) + 1);
      for (const m of sel.matchers) {
        if (m.op === '=' && m.name !== '__name__' && seen.get(m.name) === 1)
          labels[m.name] = m.value;
      }
    }
    return [{ labels, v }];
  }

  private histogramQuantile(q: Float64Array, input: Series[]): Series[] {
    const groups = new Map<
      string,
      { labels: Labels; buckets: { le: number; v: Float64Array }[] }
    >();
    for (const s of input) {
      const raw = s.labels.le;
      if (raw === undefined) continue;
      const le = /^\+?inf$/i.test(raw) ? Infinity : Number(raw);
      if (Number.isNaN(le)) continue;
      const rest = { ...withoutName(s.labels) };
      delete rest.le;
      const key = labelsKey(rest);
      let group = groups.get(key);
      if (!group) {
        group = { labels: rest, buckets: [] };
        groups.set(key, group);
      }
      group.buckets.push({ le, v: s.v });
    }
    const out: Series[] = [];
    const les: number[] = [];
    const counts: number[] = [];
    for (const group of groups.values()) {
      group.buckets.sort((a, b) => a.le - b.le);
      const v = nan(this.n);
      let any = false;
      for (let i = 0; i < this.n; i++) {
        les.length = 0;
        counts.length = 0;
        for (const bucket of group.buckets) {
          const c = bucket.v[i];
          if (Number.isNaN(c)) continue;
          if (les.length && les[les.length - 1] === bucket.le) counts[counts.length - 1] += c;
          else {
            les.push(bucket.le);
            counts.push(c);
          }
        }
        const value = bucketQuantile(q[i], les, counts);
        if (!Number.isNaN(value)) {
          v[i] = value;
          any = true;
        }
      }
      if (any) out.push({ labels: group.labels, v });
    }
    return out;
  }

  private aggregate(expr: Extract<Expr, { kind: 'agg' }>): Series[] {
    const input = this.vector(expr.expr);
    const param = expr.param ? this.scalar(expr.param) : undefined;
    const { op, grouping, without } = expr;
    const groupOf = (labels: Labels): Labels => {
      const out: Labels = {};
      if (without) {
        for (const [k, v] of Object.entries(labels)) {
          if (k !== '__name__' && !grouping.includes(k)) out[k] = v;
        }
      } else {
        for (const k of grouping)
          if (labels[k] !== undefined && labels[k] !== '') out[k] = labels[k];
      }
      return out;
    };
    const groups = new Map<string, { labels: Labels; members: Series[] }>();
    for (const s of input) {
      const labels = groupOf(s.labels);
      const key = labelsKey(labels);
      let group = groups.get(key);
      if (!group) {
        group = { labels, members: [] };
        groups.set(key, group);
      }
      group.members.push(s);
    }
    const n = this.n;
    const out: Series[] = [];

    if (op === 'topk' || op === 'bottomk') {
      for (const group of groups.values()) {
        const values = group.members.map(() => nan(n));
        const order: number[] = [];
        for (let i = 0; i < n; i++) {
          const k = Math.floor(param![i]);
          if (!(k >= 1)) continue;
          order.length = 0;
          group.members.forEach((s, idx) => {
            if (!Number.isNaN(s.v[i])) order.push(idx);
          });
          const sign = op === 'topk' ? -1 : 1;
          order.sort((a, b) => sign * (group.members[a].v[i] - group.members[b].v[i]));
          for (const idx of order.slice(0, k)) values[idx][i] = group.members[idx].v[i];
        }
        group.members.forEach((s, idx) => {
          if (values[idx].some((x) => !Number.isNaN(x))) {
            out.push({ labels: s.labels, v: values[idx], dropName: s.dropName });
          }
        });
      }
      return out;
    }

    const scratch: number[] = [];
    for (const group of groups.values()) {
      const v = nan(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        let count = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        let mean = 0;
        let m2 = 0;
        scratch.length = 0;
        for (const s of group.members) {
          const x = s.v[i];
          if (Number.isNaN(x)) continue;
          count++;
          sum += x;
          if (x < min) min = x;
          if (x > max) max = x;
          const delta = x - mean;
          mean += delta / count;
          m2 += delta * (x - mean);
          if (op === 'quantile') scratch.push(x);
        }
        if (!count) continue;
        let value: number;
        switch (op) {
          case 'sum':
            value = sum;
            break;
          case 'avg':
            value = sum / count;
            break;
          case 'min':
            value = min;
            break;
          case 'max':
            value = max;
            break;
          case 'count':
            value = count;
            break;
          case 'group':
            value = 1;
            break;
          case 'stddev':
            value = Math.sqrt(m2 / count);
            break;
          case 'stdvar':
            value = m2 / count;
            break;
          case 'quantile':
            value = quantile(param![i], scratch);
            break;
          default:
            throw new PromQLError(`The ${op} aggregation isn't supported ${SUBSET_NOTE}`);
        }
        v[i] = value;
        if (!Number.isNaN(value)) any = true;
      }
      if (any) out.push({ labels: group.labels, v });
    }
    return out;
  }

  private binary(expr: Extract<Expr, { kind: 'binary' }>): Value {
    const lhs = this.eval(expr.lhs);
    const rhs = this.eval(expr.rhs);
    const { op, bool } = expr;
    if (lhs.t === 'scalar' && rhs.t === 'scalar') {
      const v = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) v[i] = scalarOp(op, lhs.v[i], rhs.v[i]) ?? NaN;
      return { t: 'scalar', v };
    }
    if (lhs.t === 'vector' && rhs.t === 'scalar') {
      return { t: 'vector', s: this.vectorScalar(lhs.s, rhs.v, op, bool, false) };
    }
    if (lhs.t === 'scalar' && rhs.t === 'vector') {
      return { t: 'vector', s: this.vectorScalar(rhs.s, lhs.v, op, bool, true) };
    }
    if (lhs.t !== 'vector' || rhs.t !== 'vector') {
      throw new PromQLError('binary expression must contain only scalar and instant vector types');
    }
    if (SET_OPS.has(op)) return { t: 'vector', s: this.setOp(op, lhs.s, rhs.s, expr.matching) };
    return { t: 'vector', s: this.vectorVector(op, bool, lhs.s, rhs.s, expr.matching) };
  }

  private vectorScalar(
    series: Series[],
    scalar: Float64Array,
    op: string,
    bool: boolean,
    swap: boolean,
  ): Series[] {
    const comparison = COMPARISON.has(op);
    const out: Series[] = [];
    for (const s of series) {
      const v = nan(this.n);
      let any = false;
      for (let i = 0; i < this.n; i++) {
        const x = s.v[i];
        if (Number.isNaN(x)) continue;
        const r = swap ? scalarOp(op, scalar[i], x)! : scalarOp(op, x, scalar[i])!;
        // A comparison keeps the vector's own value (whichever side it is on).
        const value = comparison ? (bool ? r : r ? x : NaN) : r;
        v[i] = value;
        if (!Number.isNaN(value)) any = true;
      }
      if (any) out.push({ labels: s.labels, v, dropName: !comparison || bool ? true : s.dropName });
    }
    return out;
  }

  private signature(matching: VectorMatching | undefined): (labels: Labels) => string {
    if (matching?.on) {
      const names = matching.labels;
      return (labels) => names.map((k) => `${k}\u0000${labels[k] ?? ''}`).join('\u0001');
    }
    const ignored = new Set(['__name__', ...(matching?.labels ?? [])]);
    return (labels) => {
      let key = '';
      for (const k of Object.keys(labels).sort()) {
        if (!ignored.has(k) && labels[k] !== '') key += `${k}\u0000${labels[k]}\u0001`;
      }
      return key;
    };
  }

  private setOp(op: string, lhs: Series[], rhs: Series[], matching?: VectorMatching): Series[] {
    const sig = this.signature(matching);
    const n = this.n;
    const presence = (series: Series[]) => {
      const map = new Map<string, Uint8Array>();
      for (const s of series) {
        const k = sig(s.labels);
        let p = map.get(k);
        if (!p) {
          p = new Uint8Array(n);
          map.set(k, p);
        }
        for (let i = 0; i < n; i++) if (!Number.isNaN(s.v[i])) p[i] = 1;
      }
      return map;
    };
    const filter = (series: Series[], keep: (s: Series, i: number) => boolean) => {
      const out: Series[] = [];
      for (const s of series) {
        const v = nan(n);
        let any = false;
        for (let i = 0; i < n; i++) {
          if (!Number.isNaN(s.v[i]) && keep(s, i)) {
            v[i] = s.v[i];
            any = true;
          }
        }
        if (any) out.push({ labels: s.labels, v, dropName: s.dropName });
      }
      return out;
    };
    if (op === 'and') {
      const right = presence(rhs);
      return filter(lhs, (s, i) => !!right.get(sig(s.labels))?.[i]);
    }
    if (op === 'unless') {
      const right = presence(rhs);
      return filter(lhs, (s, i) => !right.get(sig(s.labels))?.[i]);
    }
    const left = presence(lhs);
    return [...lhs, ...filter(rhs, (s, i) => !left.get(sig(s.labels))?.[i])];
  }

  private vectorVector(
    op: string,
    bool: boolean,
    lhs: Series[],
    rhs: Series[],
    matching?: VectorMatching,
  ): Series[] {
    const n = this.n;
    const comparison = COMPARISON.has(op);
    const dropName = !comparison || bool;
    const card = matching?.card ?? 'one-to-one';
    const sig = this.signature(matching);
    // The "one" side is looked up by signature; the other side drives the result.
    const manySide = card === 'one-to-many' ? rhs : lhs;
    const oneSide = card === 'one-to-many' ? lhs : rhs;
    const oneBySig = new Map<string, Series[]>();
    for (const s of oneSide) {
      const k = sig(s.labels);
      const list = oneBySig.get(k);
      if (list) list.push(s);
      else oneBySig.set(k, [s]);
    }
    const resultLabels = (many: Series, one: Series): Labels => {
      let labels = dropName ? withoutName(many.labels) : { ...many.labels };
      if (card === 'one-to-one') {
        if (matching?.on) {
          const kept: Labels = {};
          for (const k of matching.labels) if (labels[k] !== undefined) kept[k] = labels[k];
          if (!dropName && many.labels.__name__ !== undefined) kept.__name__ = many.labels.__name__;
          labels = kept;
        } else if (matching) {
          labels = { ...labels };
          for (const k of matching.labels) delete labels[k];
        }
      } else if (matching) {
        labels = { ...labels };
        for (const k of matching.include) {
          const value = one.labels[k];
          if (value === undefined || value === '') delete labels[k];
          else labels[k] = value;
        }
      }
      return labels;
    };
    const describeGroup = (k: string) =>
      `{${k
        .split('\u0001')
        .filter(Boolean)
        .map((pair) => {
          const [name, value] = pair.split('\u0000');
          return `${name}="${value ?? ''}"`;
        })
        .join(', ')}}`;
    const results = new Map<string, Series>();
    const used = card === 'one-to-one' ? new Map<string, Uint8Array>() : undefined;
    for (const many of manySide) {
      const k = sig(many.labels);
      const candidates = oneBySig.get(k);
      if (!candidates) continue;
      let lastOne: Series | undefined;
      let labels: Labels | undefined;
      let result: Series | undefined;
      for (let i = 0; i < n; i++) {
        const x = many.v[i];
        if (Number.isNaN(x)) continue;
        let match: Series | undefined;
        for (const c of candidates) {
          if (Number.isNaN(c.v[i])) continue;
          if (match) {
            throw new PromQLError(
              `found duplicate series for the match group ${describeGroup(k)} on the ${card === 'one-to-many' ? 'left' : 'right'} hand-side of the operation; many-to-many matching not allowed: matching labels must be unique on one side`,
            );
          }
          match = c;
        }
        if (!match) continue;
        if (used) {
          let u = used.get(k);
          if (!u) {
            u = new Uint8Array(n);
            used.set(k, u);
          }
          if (u[i]) {
            throw new PromQLError(
              `multiple matches for labels ${describeGroup(k)}: many-to-one matching must be explicit (group_left/group_right)`,
            );
          }
          u[i] = 1;
        }
        const l = card === 'one-to-many' ? match.v[i] : x;
        const r = card === 'one-to-many' ? x : match.v[i];
        const raw = scalarOp(op, l, r)!;
        const value = comparison ? (bool ? raw : raw ? l : NaN) : raw;
        if (Number.isNaN(value)) continue;
        if (match !== lastOne || !labels) {
          labels = resultLabels(many, match);
          lastOne = match;
          const rk = labelsKey(labels);
          result = results.get(rk);
          if (!result) {
            result = { labels, v: nan(n), dropName: dropName ? undefined : many.dropName };
            results.set(rk, result);
          }
        }
        result!.v[i] = value;
      }
    }
    return [...results.values()];
  }
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

/** Go's time.Time JSON: RFC 3339 with trailing zero fractions trimmed. */
const goTime = (ms: number): string => new Date(ms).toISOString().replace(/\.?0+Z$/, 'Z');
const finite = (x: number): number => (Number.isFinite(x) ? x : 0);

const outLabels = (s: { labels: Labels; dropName?: boolean }): Record<string, string> => ({
  ...(s.dropName ? withoutName(s.labels) : s.labels),
});

const compareLabels = (a: Record<string, string>, b: Record<string, string>): number => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    if (a[ka[i]] !== b[kb[i]]) return a[ka[i]] < b[kb[i]] ? -1 : 1;
  }
  return ka.length - kb.length;
};

function parseTime(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new DemoError(400, `Invalid ${field} time`);
  return ms;
}

/** Runs a range (or instant) query the way POST /metrics/query/promql/:pid answers it. */
export function evaluatePromQL(projectId: string, request: PromQLRequest): PromQLResponse {
  const query = request?.query?.trim();
  if (!query) throw new DemoError(400, 'A PromQL query is required');
  const end = parseTime(request.end, 'end') ?? Date.now();
  const start = parseTime(request.start, 'start') ?? end - 3_600_000;
  const instant = !!request.instant;
  if (!instant && !(start < end)) throw new PromQLError('start must be before end');

  const expr = parsePromQL(query);
  const type = typeOf(expr);
  let steps: number[];
  let stepMs = 0;
  if (instant) {
    steps = [end];
  } else {
    if (type !== 'scalar' && type !== 'vector') {
      throw new PromQLError(
        `invalid expression type "${type === 'matrix' ? 'range vector' : type}" for range query, must be Scalar or instant Vector`,
      );
    }
    const requested = Math.floor(request.stepSeconds ?? 0);
    stepMs =
      requested > 0
        ? requested * 1000
        : Math.max(Math.floor((end - start) / DEFAULT_POINTS / 1000) * 1000, 1000);
    const points = Math.floor((end - start) / stepMs) + 1;
    if (points > MAX_POINTS) {
      throw new PromQLError(
        `query resolution of ${points} points exceeds the maximum of ${MAX_POINTS} points per series (try a longer step or a narrower time range)`,
      );
    }
    steps = [];
    for (let t = start; t <= end; t += stepMs) steps.push(t);
  }

  const limit =
    request.maxSeries && request.maxSeries > 0
      ? Math.min(request.maxSeries, HARD_MAX_SERIES)
      : DEFAULT_SERIES;
  const value = new Evaluator(projectId, steps, start, end, new Map()).eval(expr);
  const response = toResponse(value, steps, instant, limit);
  if (stepMs) response.stepSeconds = stepMs / 1000;
  return response;
}

function limitMatrix(series: PromQLSeries[], limit: number): PromQLResponse {
  series.sort((a, b) => compareLabels(a.labels, b.labels));
  if (series.length <= limit) return { resultType: 'matrix', series };
  // Like the backend: keep the series with the most points.
  const kept = [...series].sort((a, b) => b.points.length - a.points.length).slice(0, limit);
  return { resultType: 'matrix', series: kept, truncated: true };
}

function toResponse(
  value: Value,
  steps: number[],
  instant: boolean,
  limit: number,
): PromQLResponse {
  if (value.t === 'string') return { resultType: 'unsupported', series: [] };
  if (value.t === 'scalar') {
    if (instant) return { resultType: 'scalar', series: [], scalar: finite(value.v[0]) };
    const points: PromQLPoint[] = [];
    steps.forEach((t, i) => {
      if (!Number.isNaN(value.v[i]))
        points.push({ timestamp: goTime(t), value: finite(value.v[i]) });
    });
    return { resultType: 'matrix', series: points.length ? [{ labels: {}, points }] : [] };
  }
  if (value.t === 'matrix') {
    return limitMatrix(
      value.s.map((raw) => ({
        labels: outLabels(raw),
        points: raw.ts.map((t, k) => ({ timestamp: goTime(t), value: finite(raw.vs[k]) })),
      })),
      limit,
    );
  }
  if (instant) {
    const series: PromQLSeries[] = [];
    for (const s of value.s) {
      if (Number.isNaN(s.v[0])) continue;
      series.push({
        labels: outLabels(s),
        points: [{ timestamp: goTime(steps[0]), value: finite(s.v[0]) }],
      });
    }
    if (series.length <= limit) return { resultType: 'vector', series };
    return { resultType: 'vector', series: series.slice(0, limit), truncated: true };
  }
  const series: PromQLSeries[] = [];
  for (const s of value.s) {
    const points: PromQLPoint[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (!Number.isNaN(s.v[i]))
        points.push({ timestamp: goTime(steps[i]), value: finite(s.v[i]) });
    }
    if (points.length) series.push({ labels: outLabels(s), points });
  }
  return limitMatrix(series, limit);
}
