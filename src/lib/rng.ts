// Deterministic randomness: the same seed always yields the same sample data,
// so a time range shows the same logs, traces and metrics on every request.

/** FNV-1a 32-bit hash of a string. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mixes numbers into one 32-bit seed. */
export function mix(...values: number[]): number {
  let hash = 0x9e3779b9;
  for (const value of values) {
    // Split so values above 2^32 (millisecond timestamps) keep their high bits.
    const low = value >>> 0;
    const high = Math.floor(value / 4294967296) >>> 0;
    hash = Math.imul(hash ^ low, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13) ^ high, 0xc2b2ae35);
    hash ^= hash >>> 16;
  }
  return hash >>> 0;
}

export type Rng = () => number;

/** mulberry32: a small, fast PRNG returning [0, 1). */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: Rng, min: number, max: number): number =>
  min + Math.floor(r() * (max - min + 1));

export const pick = <T>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)];

/** Picks by weight; items are [value, weight]. */
export function weighted<T>(r: Rng, items: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, weight] of items) total += weight;
  let roll = r() * total;
  for (const [value, weight] of items) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return items[items.length - 1][0];
}

/** Poisson-distributed count (Knuth for small means, normal approximation above). */
export function poisson(r: Rng, mean: number): number {
  if (mean <= 0) return 0;
  if (mean > 30) {
    const u = Math.max(r(), 1e-9);
    const v = r();
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(0, Math.round(mean + normal * Math.sqrt(mean)));
  }
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > limit);
  return k - 1;
}

/** Hex string of `length` characters from a seed. */
export function hex(seed: number, length: number): string {
  const r = rng(seed);
  let out = '';
  while (out.length < length) {
    out += Math.floor(r() * 4294967296)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, length);
}

/** A stable UUID-shaped id from a string. */
export function uuidFrom(value: string): string {
  const h = hex(hashString(value), 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
