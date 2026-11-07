// Every API URL the UI calls must have a demo handler (a real one or an
// explicit "not in the demo"), so new features can't silently break the
// live demo. URLs are read from the entity API modules' template literals.
import { describe, expect, it } from 'vitest';

import { buildRouter } from './handlers';

// Source text of every entity API module, plus live tail's direct fetch.
const SOURCES: Record<string, string> = {
  ...import.meta.glob<string>(['../entity/*/api/*.ts', '!../**/*.test.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>('../features/query/lib/pushLiveTail.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

const BASES = [
  /^\$\{getApiBase\(\)\}/,
  /^\$\{getApplicationServer\(\)\}\/sites\/\$\{[^}]+\}\/api\/v1/,
  /^\$\{getApplicationServer\(\)\}\/api\/v1/,
];

/** Expands a local base helper (`const baseUrl = (...) => \`${getApiBase()}/x\``). */
function expandHelpers(literal: string, source: string, depth = 0): string | undefined {
  for (const base of BASES) if (base.test(literal)) return literal.replace(base, '');
  const helper = /^\$\{(\w+)(?:\([^)]*\))?\}/.exec(literal);
  if (!helper || depth > 3) return undefined;
  const definition = new RegExp(
    `(?:const|function)\\s+${helper[1]}\\b[^\`]*?\`([^\`]*)\``,
    's',
  ).exec(source);
  if (!definition) return undefined;
  const expanded = expandHelpers(definition[1], source, depth + 1);
  if (expanded === undefined) {
    // e.g. a scope switch: base(scope) returns one of several bases; take the api one.
    return literal.replace(helper[0], '');
  }
  return expanded + literal.slice(helper[0].length);
}

interface Call {
  file: string;
  method: string;
  path: string;
}

function calls(): Call[] {
  const out: Call[] = [];
  for (const [file, source] of Object.entries(SOURCES)) {
    const literal = /`([^`]*)`/g;
    let match: RegExpExecArray | null;
    while ((match = literal.exec(source))) {
      const text = match[1];
      if (!text.startsWith('${')) continue;
      const expanded = expandHelpers(text, source);
      if (expanded === undefined || !expanded.startsWith('/')) continue;
      // `${base()}${path}`: a helper taking its path as a parameter; the
      // literals its callers pass are checked on their own.
      if (/^\$\{\w+\(\)\}\$\{\w+\}$/.test(text)) continue;
      // Skip the helper definitions themselves (the base alone).
      const before = source.slice(Math.max(0, match.index - 400), match.index);
      if (/(?:const|function)\s+\w+\s*=?\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*$/.test(before))
        continue;
      // The method: a `method: 'X'` right after the URL (plain fetch), else the
      // apiHelper call that takes it, searched back to the enclosing function.
      const statementStart = source.lastIndexOf('async ', match.index);
      const lead = source.slice(Math.max(0, statementStart), match.index);
      const tail = source.slice(match.index, match.index + match[0].length + 250);
      const explicit = /method:\s*'(\w+)'/.exec(tail)?.[1];
      const helper = [...lead.matchAll(/fetch(Get|Post|Put|Delete|Patch)|streamNdjson/g)].pop();
      const method = (explicit ?? (helper ? (helper[1] ?? 'POST') : 'GET')).toUpperCase();
      const path = expanded
        .replace(/\$\{[^}]*\}/g, (_interp, offset, whole) =>
          // An interpolated query string (`${qs}`) at the end isn't a segment.
          offset > 0 && whole[offset - 1] !== '/' ? '' : 'x',
        )
        .replace(/\?.*$/, '')
        .replace(/\/$/, '');
      if (path) out.push({ file: file.replace(/^\.\.\//, ''), method, path });
    }
  }
  return out;
}

describe('demo API coverage', () => {
  const router = buildRouter();
  const all = calls();

  it('finds the UI API calls', () => {
    expect(all.length).toBeGreaterThan(150);
  });

  it('has a handler for every UI API call', () => {
    const missing = all
      .filter((call) => !router.match(call.method, call.path))
      .map((call) => `${call.method} ${call.path}  (${call.file})`);
    // One per line, so a failure lists exactly what to add.
    expect([...new Set(missing)].join('\n')).toBe('');
  });
});
