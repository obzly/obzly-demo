// The demo's saved state: collections seeded with sample records; whatever a
// visitor creates, edits or deletes is kept in this browser's localStorage
// (never sent anywhere). Bump STORAGE_KEY's version when seeds change shape.

export const STORAGE_KEY = 'obzly_demo_v1';

type Doc = { id: string } & Record<string, unknown>;

let state: Record<string, unknown> | undefined;
let storageWorks = true;

function load(): Record<string, unknown> {
  if (state) return state;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    storageWorks = false;
    state = {};
  }
  return state;
}

function save() {
  if (!storageWorks || !state) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageWorks = false; // full or blocked: keep going in memory
  }
}

/** Clears every change and reloads the page into a fresh demo. */
export function resetDemo() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* blocked storage: nothing saved anyway */
  }
  state = {};
}

export const hasChanges = () => Object.keys(load()).length > 0;

/** A single saved value (settings objects and the like). */
export function value<T>(name: string, seed: () => T) {
  return {
    get(): T {
      const s = load();
      if (!(name in s)) return seed();
      return s[name] as T;
    },
    set(next: T): T {
      load()[name] = next;
      save();
      return next;
    },
  };
}

export const newId = (): string => {
  const random = crypto.getRandomValues(new Uint8Array(16));
  random[6] = (random[6] & 0x0f) | 0x40;
  random[8] = (random[8] & 0x3f) | 0x80;
  const h = Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** A list of records keyed by id. */
export function collection<T extends { id: string }>(name: string, seed: () => T[]) {
  const all = (): T[] => {
    const s = load();
    if (!(name in s)) return seed();
    return s[name] as T[];
  };
  const write = (items: T[]) => {
    load()[name] = items;
    save();
  };
  return {
    all,
    find: (predicate: (item: T) => boolean) => all().filter(predicate),
    get: (id: string): T | undefined => all().find((item) => item.id === id),
    insert(item: T): T {
      write([...all(), item]);
      return item;
    },
    update(id: string, patch: Partial<T>): T | undefined {
      let updated: T | undefined;
      write(
        all().map((item) => {
          if (item.id !== id) return item;
          updated = { ...item, ...patch, id } as T;
          return updated;
        }),
      );
      return updated;
    },
    remove(id: string): boolean {
      const items = all();
      const next = items.filter((item) => item.id !== id);
      write(next);
      return next.length !== items.length;
    },
    replaceAll: write,
  };
}

export type Collection<T extends { id: string }> = ReturnType<typeof collection<T>>;
export type { Doc };
