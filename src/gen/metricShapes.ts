// Building blocks for the generated metrics (./metrics.ts): the day's load
// curve as closed-form running totals, so a counter's value at any instant
// is an O(1) lookup (rate() over [30d] costs the same as over [5m]), smooth
// deterministic noise, and a per-series time warp that makes counters wobble
// like real traffic while staying monotonic.
import { hashString, mix } from '../lib/rng';
import { incidentLevel, traffic } from '../world';
import type { LabelMatcher, Labels } from './metricRegistry';

export const SCRAPE_MS = 30_000;
export const SECOND = 1000;
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** [0, 1) from a seed and an integer. */
export const unit = (seed: number, i: number): number => mix(seed, i) / 4294967296;

/** Smooth value noise in [-1, 1] with knots every 1 unit of x (cosine-interpolated). */
export function vnoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = unit(seed, i) * 2 - 1;
  const b = unit(seed, i + 1) * 2 - 1;
  return a + (b - a) * ((1 - Math.cos(f * Math.PI)) / 2);
}

/** Relative wobble for gauges: a slow drift plus a faster flutter. */
export const wobble = (seed: number, t: number, amount = 1): number =>
  amount * (0.06 * vnoise(seed, t / (7 * MINUTE)) + 0.035 * vnoise(seed ^ 0x5bd1, t / 50_000));

// ---------------------------------------------------------------------------
// Day profiles at 30 s resolution, for weekdays and weekends.
// ---------------------------------------------------------------------------

const RES = 30_000;
const SLOTS = DAY / RES;

export type Profile = 'tr' | 'inc' | 'pk' | 'work' | 'batch';

interface Table {
  rate: Float64Array;
  /** Running total (rate x seconds) at each slot boundary. */
  cum: Float64Array;
  total: number;
}

/** Workday activity (people at keyboards, UTC): 08-18 with a lunch dip. */
function workAt(t: number, weekend: boolean): number {
  const h = (t % DAY) / HOUR;
  if (weekend) return 0.05 + 0.05 * Math.max(0, Math.sin(((h - 10) / 12) * Math.PI));
  const ramp = (x: number) => Math.min(1, Math.max(0, x));
  const on = ramp((h - 7.5) / 1.5) * ramp((18.5 - h) / 1.5);
  const lunch = h > 11.8 && h < 13.2 ? 0.55 : 1;
  return 0.04 + 0.96 * on * lunch;
}

/** The nightly export on the batch host, 01:00-02:15 UTC. */
function batchAt(t: number): number {
  const m = (t % DAY) / MINUTE;
  if (m < 60 || m > 135) return 0;
  return Math.min(1, (m - 60) / 4, (135 - m) / 6);
}

function rateOf(profile: Profile, t: number, weekend: boolean): number {
  const tr = traffic(t);
  switch (profile) {
    case 'tr':
      return tr;
    case 'inc':
      return tr * incidentLevel(t);
    case 'pk':
      return tr * Math.max(0, tr - 1.1);
    case 'work':
      return workAt(t, weekend);
    case 'batch':
      return batchAt(t);
  }
}

// 2026-01-05 is a Monday, 2026-01-03 a Saturday (UTC).
const MONDAY = Date.UTC(2026, 0, 5);
const SATURDAY = Date.UTC(2026, 0, 3);

const tables = new Map<string, Table>();
function table(profile: Profile, weekend: boolean): Table {
  const key = `${profile}:${weekend}`;
  let found = tables.get(key);
  if (found) return found;
  const day = weekend ? SATURDAY : MONDAY;
  const rate = new Float64Array(SLOTS);
  const cum = new Float64Array(SLOTS + 1);
  for (let s = 0; s < SLOTS; s++) {
    rate[s] = rateOf(profile, day + s * RES + RES / 2, weekend);
    cum[s + 1] = cum[s] + (rate[s] * RES) / SECOND;
  }
  found = { rate, cum, total: cum[SLOTS] };
  tables.set(key, found);
  return found;
}

/** Day 0 (1970-01-01) was a Thursday; days 2 and 3 of each week are the weekend. */
const isWeekendDay = (d: number) => {
  const w = ((d % 7) + 7) % 7;
  return w === 2 || w === 3;
};

function weekendDaysBefore(d: number): number {
  const q = Math.floor(d / 7);
  const r = d - 7 * q;
  return 2 * q + (r > 2 ? 1 : 0) + (r > 3 ? 1 : 0);
}

/** A profile's instantaneous rate at t (table lookup). */
export function rateAt(profile: Profile, t: number): number {
  const d = Math.floor(t / DAY);
  const tab = table(profile, isWeekendDay(d));
  const s = Math.min(SLOTS - 1, Math.floor((t - d * DAY) / RES));
  return tab.rate[s];
}

/** ∫ rate dt (in rate x seconds) from 1970 to t. */
export function cumAt(profile: Profile, t: number): number {
  const d = Math.floor(t / DAY);
  const we = weekendDaysBefore(d);
  const base =
    (d - we) * table(profile, false).total + (we === 0 ? 0 : we * table(profile, true).total);
  const tab = table(profile, isWeekendDay(d));
  const x = (t - d * DAY) / RES;
  const s = Math.min(SLOTS - 1, Math.floor(x));
  return base + tab.cum[s] + ((x - s) * tab.rate[s] * RES) / SECOND;
}

// ---------------------------------------------------------------------------
// Promotions: one extra-traffic bump a day, each of the same area but its own
// height, width and time, so no two days look alike.
// ---------------------------------------------------------------------------

const BUMP_SEED = hashString('harborline-promotions');
const BUMP_AREA = 0.22 * 3600; // traffic-units x seconds per day

function bumpOf(d: number) {
  const height = 0.06 + 0.3 * unit(BUMP_SEED, d);
  const width = (2 * BUMP_AREA) / height; // seconds
  const center = d * DAY + (10 + 9 * unit(BUMP_SEED ^ 0x77, d)) * HOUR;
  return { height, width, start: center - (width * SECOND) / 2 };
}

export function bumpAt(t: number): number {
  const b = bumpOf(Math.floor(t / DAY));
  const x = (t - b.start) / SECOND;
  if (x <= 0 || x >= b.width) return 0;
  return (b.height * (1 - Math.cos((2 * Math.PI * x) / b.width))) / 2;
}

export function bumpCumAt(t: number): number {
  const d = Math.floor(t / DAY);
  const b = bumpOf(d);
  const x = (t - b.start) / SECOND;
  const within =
    x <= 0
      ? 0
      : x >= b.width
        ? BUMP_AREA
        : (b.height / 2) * (x - (b.width / (2 * Math.PI)) * Math.sin((2 * Math.PI * x) / b.width));
  return d * BUMP_AREA + within;
}

/** Shop load right now: the daily curve plus the day's promotion (~0.3..1.7). */
export const loadAt = (t: number): number => rateAt('tr', t) + bumpAt(t);

/** Incident intensity (0..1) at t. */
export const incAt = (t: number): number => incidentLevel(t);

// ---------------------------------------------------------------------------
// Counters: linear combinations of running totals, read at warped times.
// ---------------------------------------------------------------------------

/**
 * A counter's rate coefficients: rate(t) = a·load + i·traffic·incident +
 * p·traffic·peak + w·work + b·batch + c (per second).
 */
export interface Coef {
  a?: number;
  i?: number;
  p?: number;
  w?: number;
  b?: number;
  c?: number;
}

/**
 * A slightly irregular clock: t plus a smooth drift (|drift'| < 0.35, so it
 * never runs backwards) and up to 8 s of per-sample jitter (samples are at
 * least 30 s apart). Counters read at warped times wobble like real traffic.
 */
export function warp(seed: number, t: number): number {
  const slow = 17 * MINUTE;
  const fast = 210_000;
  return (
    t +
    0.06 * slow * vnoise(seed, t / slow) +
    0.05 * fast * vnoise(seed ^ 0x9e37, t / fast) +
    8000 * unit(seed ^ 0x2545, Math.floor(t / SECOND))
  );
}

/** The running totals at one warped instant. */
export interface Basis {
  A: number;
  I: number;
  P: number;
  W: number;
  B: number;
  T: number;
}

export function basisAt(wt: number): Basis {
  return {
    A: cumAt('tr', wt) + bumpCumAt(wt),
    I: cumAt('inc', wt),
    P: cumAt('pk', wt),
    W: cumAt('work', wt),
    B: cumAt('batch', wt),
    T: wt / SECOND,
  };
}

export const combine = (c: Coef, b: Basis): number =>
  (c.a ?? 0) * b.A +
  (c.i ?? 0) * b.I +
  (c.p ?? 0) * b.P +
  (c.w ?? 0) * b.W +
  (c.b ?? 0) * b.B +
  (c.c ?? 0) * b.T;

/** Per-sample bases for one clock (seed) and a set of reset times. */
export interface BasisSet {
  at: Basis[];
  /** The basis at each sample's last reset (counter start). */
  reset: Basis[];
}

const basisCache = new WeakMap<number[], Map<string, BasisSet>>();

/**
 * Bases for timestamps `ts` on clock `seed`, with counters restarting at
 * `resets` (sorted; the latest one at or before each sample applies).
 * Cached per timestamps array, so every series sharing a clock reuses them.
 */
export function basesFor(seed: number, ts: number[], resets: number[]): BasisSet {
  let bySeed = basisCache.get(ts);
  if (!bySeed) {
    bySeed = new Map();
    basisCache.set(ts, bySeed);
  }
  const key = `${seed}|${resets.length}|${resets[0] ?? ''}|${resets[resets.length - 1] ?? ''}`;
  const hit = bySeed.get(key);
  if (hit) return hit;
  const at: Basis[] = new Array(ts.length);
  const reset: Basis[] = new Array(ts.length);
  const resetBasis = new Map<number, Basis>();
  let r = 0;
  for (let j = 0; j < ts.length; j++) {
    const t = ts[j];
    at[j] = basisAt(warp(seed, t));
    while (r + 1 < resets.length && resets[r + 1] <= t) r++;
    const start = resets.length && resets[r] <= t ? resets[r] : -Infinity;
    if (start === -Infinity) {
      reset[j] = { A: 0, I: 0, P: 0, W: 0, B: 0, T: 0 };
      continue;
    }
    let base = resetBasis.get(start);
    if (!base) {
      // Exactly at the restart, without the per-sample jitter, so the first
      // samples after it are never below it.
      base = basisAt(start);
      resetBasis.set(start, base);
    }
    reset[j] = base;
  }
  const set = { at, reset };
  bySeed.set(key, set);
  return set;
}

/** Counter values: Σ coef·basis since the last reset, floored for integer counters. */
export function counterValues(set: BasisSet, coef: Coef, integer: boolean, scale = 1): number[] {
  const out = new Array<number>(set.at.length);
  for (let j = 0; j < out.length; j++) {
    const v = scale * combine(coef, set.at[j]);
    const r = scale * combine(coef, set.reset[j]);
    out[j] = integer ? Math.max(0, Math.floor(v) - Math.floor(r)) : Math.max(0, v - r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Latency distributions for histograms.
// ---------------------------------------------------------------------------

/** erf, Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** P(X <= le) for a log-normal with the given median and sigma. */
export const lognormalCdf = (le: number, median: number, sigma: number): number =>
  le === Infinity ? 1 : le <= 0 ? 0 : 0.5 * (1 + erf(Math.log(le / median) / (sigma * Math.SQRT2)));

export const lognormalMean = (median: number, sigma: number): number =>
  median * Math.exp((sigma * sigma) / 2);

// ---------------------------------------------------------------------------
// Label matchers, compiled once (regexes cached).
// ---------------------------------------------------------------------------

const regexCache = new Map<string, RegExp>();
export function anchored(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(`^(?:${pattern})$`, 's');
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(pattern, re);
  }
  return re;
}

export function compileMatchers(matchers: LabelMatcher[]): (labels: Labels) => boolean {
  if (!matchers.length) return () => true;
  const tests = matchers.map((m): ((labels: Labels) => boolean) => {
    switch (m.op) {
      case '=':
        return (l) => (l[m.name] ?? '') === m.value;
      case '!=':
        return (l) => (l[m.name] ?? '') !== m.value;
      case '=~': {
        const re = anchored(m.value);
        return (l) => re.test(l[m.name] ?? '');
      }
      case '!~': {
        const re = anchored(m.value);
        return (l) => !re.test(l[m.name] ?? '');
      }
    }
  });
  return (labels) => tests.every((test) => test(labels));
}
