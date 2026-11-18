// A small Go text/template interpreter for the message template editor's
// previews: actions with trim markers, comments, if / else if / else, range
// (with $i, $v :=), with, pipelines, field paths, variables, literals,
// parentheses and the functions Obzly gives templates. Enough for the
// built-in templates and what people write in the editor; errors carry the
// line, like Go's "template: body:3: ...".

export class TemplateError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

type Arg =
  | { t: 'field'; base: string; path: string[] }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'nil' }
  | { t: 'ident'; name: string }
  | { t: 'pipe'; pipe: Pipe };
type Pipe = { decl: string[]; cmds: Arg[][] };
type Node =
  | { kind: 'text'; text: string }
  | { kind: 'out'; pipe: Pipe; line: number }
  | { kind: 'if'; branches: { cond: Pipe | null; body: Node[] }[]; line: number }
  | { kind: 'range'; pipe: Pipe; body: Node[]; otherwise: Node[]; line: number }
  | { kind: 'with'; pipe: Pipe; body: Node[]; otherwise: Node[]; line: number };

export type Funcs = Record<string, (...args: unknown[]) => unknown>;

const BUILTINS: Funcs = {
  not: (v) => !truthy(v),
  and: (...vs) => vs.find((v) => !truthy(v)) ?? vs[vs.length - 1],
  or: (...vs) => vs.find((v) => truthy(v)) ?? vs[vs.length - 1],
  eq: (a, ...bs) => bs.some((b) => a === b),
  ne: (a, b) => a !== b,
  lt: (a, b) => (a as number) < (b as number),
  le: (a, b) => (a as number) <= (b as number),
  gt: (a, b) => (a as number) > (b as number),
  ge: (a, b) => (a as number) >= (b as number),
  len: (v) =>
    v instanceof Map ? v.size : Array.isArray(v) || typeof v === 'string' ? v.length : 0,
  index: (v, ...keys) =>
    keys.reduce<unknown>(
      (acc, key) =>
        acc instanceof Map ? acc.get(key) : (acc as Record<string, unknown>)?.[String(key)],
      v,
    ),
  print: (...vs) => vs.map(format).join(''),
  println: (...vs) => vs.map(format).join(' ') + '\n',
  printf: (fmt, ...vs) => {
    let i = 0;
    return String(fmt).replace(/%[-+ #0-9.]*([sdvqf%])/g, (_m, verb: string) =>
      verb === '%' ? '%' : verb === 'q' ? JSON.stringify(format(vs[i++])) : format(vs[i++]),
    );
  },
};

export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return true;
}

function format(v: unknown): string {
  if (v === null || v === undefined) return '<no value>';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(format).join(' ')}]`;
  if (v instanceof Map)
    return `map[${[...v.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([k, x]) => `${String(k)}:${format(x)}`)
      .join(' ')}]`;
  return `{${Object.values(v as object)
    .map(format)
    .join(' ')}}`;
}

// --- lexing and parsing ------------------------------------------------------------

interface Action {
  text: string;
  line: number;
}

function tokenize(src: string, line: number): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) throw new TemplateError(line, 'unterminated quoted string');
      tokens.push(src.slice(i, j + 1));
      i = j + 1;
    } else if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new TemplateError(line, 'unterminated raw quoted string');
      tokens.push(src.slice(i, j + 1));
      i = j + 1;
    } else if (c === '(' || c === ')' || c === '|' || c === ',') {
      tokens.push(c);
      i++;
    } else if (src.startsWith(':=', i) || (c === '=' && src[i + 1] !== '=')) {
      tokens.push(c === ':' ? ':=' : '=');
      i += c === ':' ? 2 : 1;
    } else {
      let j = i;
      while (j < src.length && !/[\s()|,]/.test(src[j]) && !src.startsWith(':=', j)) j++;
      tokens.push(src.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

function parseArg(tokens: string[], pos: { i: number }, line: number): Arg {
  const tok = tokens[pos.i++];
  if (tok === undefined) throw new TemplateError(line, 'missing value');
  if (tok === '(') {
    const pipe = parsePipe(tokens, pos, line, ')');
    if (tokens[pos.i++] !== ')') throw new TemplateError(line, 'unclosed left paren');
    return { t: 'pipe', pipe };
  }
  if (tok.startsWith('"')) return { t: 'str', v: JSON.parse(tok) as string };
  if (tok.startsWith('`')) return { t: 'str', v: tok.slice(1, -1) };
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { t: 'num', v: Number(tok) };
  if (tok === 'true' || tok === 'false') return { t: 'bool', v: tok === 'true' };
  if (tok === 'nil') return { t: 'nil' };
  if (tok === '.') return { t: 'field', base: '.', path: [] };
  if (tok.startsWith('.')) return { t: 'field', base: '.', path: tok.slice(1).split('.') };
  if (tok.startsWith('$')) {
    const [base, ...path] = tok.split('.');
    return { t: 'field', base, path };
  }
  if (/^[A-Za-z_]\w*$/.test(tok)) return { t: 'ident', name: tok };
  throw new TemplateError(line, `unexpected "${tok}" in command`);
}

function parsePipe(tokens: string[], pos: { i: number }, line: number, stop?: string): Pipe {
  const decl: string[] = [];
  // $x := ... or $i, $v := ...
  const assign = tokens.indexOf(':=', pos.i);
  if (assign > 0 && tokens.slice(pos.i, assign).every((t) => t.startsWith('$') || t === ',')) {
    for (const t of tokens.slice(pos.i, assign)) if (t !== ',') decl.push(t);
    pos.i = assign + 1;
  }
  const cmds: Arg[][] = [[]];
  while (pos.i < tokens.length && tokens[pos.i] !== stop) {
    if (tokens[pos.i] === '|') {
      pos.i++;
      cmds.push([]);
      continue;
    }
    cmds[cmds.length - 1].push(parseArg(tokens, pos, line));
  }
  if (cmds.some((cmd) => cmd.length === 0))
    throw new TemplateError(line, 'missing value for command');
  return { decl, cmds };
}

function checkFuncs(pipe: Pipe, funcs: Funcs, line: number) {
  for (const cmd of pipe.cmds) {
    for (const arg of cmd) {
      if (arg.t === 'ident' && !(arg.name in funcs))
        throw new TemplateError(line, `function "${arg.name}" not defined`);
      if (arg.t === 'pipe') checkFuncs(arg.pipe, funcs, line);
    }
  }
}

export function parseTemplate(source: string, funcs: Funcs = {}): Node[] {
  const all = { ...BUILTINS, ...funcs };
  // Split into text and actions, applying the trim markers.
  const parts: (string | Action)[] = [];
  let i = 0;
  let line = 1;
  while (i < source.length) {
    const open = source.indexOf('{{', i);
    if (open < 0) {
      parts.push(source.slice(i));
      break;
    }
    let text = source.slice(i, open);
    line += (source.slice(i, open).match(/\n/g) ?? []).length;
    const close = source.indexOf('}}', open + 2);
    if (close < 0) throw new TemplateError(line, 'unclosed action');
    let inner = source.slice(open + 2, close);
    if (/^-\s/.test(inner)) {
      text = text.replace(/\s+$/, '');
      inner = inner.slice(1);
    }
    let trimAfter = false;
    if (/\s-$/.test(inner)) {
      trimAfter = true;
      inner = inner.slice(0, -1);
    }
    parts.push(text, { text: inner.trim(), line });
    line += (inner.match(/\n/g) ?? []).length;
    i = close + 2;
    if (trimAfter) {
      const rest = source.slice(i);
      const trimmed = rest.replace(/^\s+/, '');
      line += (rest.slice(0, rest.length - trimmed.length).match(/\n/g) ?? []).length;
      i += rest.length - trimmed.length;
    }
  }

  let k = 0;
  const block = (enders: string[]): { nodes: Node[]; end: string; action?: Action } => {
    const nodes: Node[] = [];
    while (k < parts.length) {
      const part = parts[k++];
      if (typeof part === 'string') {
        if (part) nodes.push({ kind: 'text', text: part });
        continue;
      }
      if (part.text.startsWith('/*')) {
        if (!part.text.endsWith('*/')) throw new TemplateError(part.line, 'unclosed comment');
        continue;
      }
      const tokens = tokenize(part.text, part.line);
      const word = tokens[0];
      if (word === 'end' || word === 'else') {
        if (!enders.includes(word)) throw new TemplateError(part.line, `unexpected {{${word}}}`);
        return { nodes, end: word, action: { ...part, text: tokens.slice(1).join(' ') } };
      }
      const pos = { i: 1 };
      if (word === 'if') {
        const branches: { cond: Pipe | null; body: Node[] }[] = [];
        let cond: Pipe | null = parsePipe(tokens, pos, part.line);
        checkFuncs(cond, all, part.line);
        for (;;) {
          const inner = block(['end', 'else']);
          branches.push({ cond, body: inner.nodes });
          if (inner.end === 'end') break;
          const rest = tokenize(inner.action!.text, part.line);
          if (rest[0] === 'if') {
            cond = parsePipe(rest, { i: 1 }, inner.action!.line);
            checkFuncs(cond, all, inner.action!.line);
          } else {
            const tail = block(['end']);
            branches.push({ cond: null, body: tail.nodes });
            break;
          }
        }
        nodes.push({ kind: 'if', branches, line: part.line });
      } else if (word === 'range' || word === 'with') {
        const pipe = parsePipe(tokens, pos, part.line);
        checkFuncs(pipe, all, part.line);
        const body = block(['end', 'else']);
        const otherwise = body.end === 'else' ? block(['end']).nodes : [];
        nodes.push({ kind: word, pipe, body: body.nodes, otherwise, line: part.line });
      } else if (['define', 'template', 'block', 'break', 'continue'].includes(word)) {
        throw new TemplateError(part.line, `{{${word}}} isn't available in message templates`);
      } else {
        const pipe = parsePipe(tokens, { i: 0 }, part.line);
        checkFuncs(pipe, all, part.line);
        nodes.push({ kind: 'out', pipe, line: part.line });
      }
    }
    if (enders.length) throw new TemplateError(line, 'unexpected EOF');
    return { nodes, end: '' };
  };
  return block([]).nodes;
}

// --- execution ---------------------------------------------------------------------

interface Scope {
  dot: unknown;
  vars: Map<string, unknown>;
}

function fieldOf(value: unknown, name: string, line: number): unknown {
  if (value instanceof Map) return value.get(name) ?? '';
  if (value === null || value === undefined)
    throw new TemplateError(line, `nil pointer evaluating .${name}`);
  if (typeof value !== 'object' || !(name in (value as object)))
    throw new TemplateError(line, `can't evaluate field ${name}`);
  return (value as Record<string, unknown>)[name];
}

export function executeTemplate(nodes: Node[], data: unknown, funcs: Funcs = {}): string {
  const all = { ...BUILTINS, ...funcs };
  let out = '';
  const evalArg = (arg: Arg, scope: Scope, line: number, final?: unknown): unknown => {
    switch (arg.t) {
      case 'str':
      case 'num':
      case 'bool':
        return arg.v;
      case 'nil':
        return null;
      case 'pipe':
        return evalPipe(arg.pipe, scope, line);
      case 'ident':
        return call(arg.name, [], line, final);
      case 'field': {
        let value: unknown;
        if (arg.base === '.') value = scope.dot;
        else {
          if (!scope.vars.has(arg.base))
            throw new TemplateError(line, `undefined variable "${arg.base}"`);
          value = scope.vars.get(arg.base);
        }
        for (const name of arg.path) value = fieldOf(value, name, line);
        return value;
      }
    }
  };
  const call = (name: string, args: unknown[], line: number, final?: unknown) => {
    const fn = all[name];
    if (!fn) throw new TemplateError(line, `function "${name}" not defined`);
    try {
      return fn(...args, ...(final === undefined ? [] : [final]));
    } catch {
      throw new TemplateError(line, `error calling ${name}`);
    }
  };
  const evalPipe = (pipe: Pipe, scope: Scope, line: number): unknown => {
    let value: unknown = undefined;
    pipe.cmds.forEach((cmd, i) => {
      const final = i > 0 ? value : undefined;
      const [head, ...rest] = cmd;
      if (head.t === 'ident') {
        value = call(
          head.name,
          rest.map((a) => evalArg(a, scope, line)),
          line,
          final,
        );
      } else {
        if (rest.length) throw new TemplateError(line, "can't give argument to non-function");
        value = evalArg(head, scope, line);
      }
    });
    if (pipe.decl.length === 1) scope.vars.set(pipe.decl[0], value);
    return value;
  };
  const run = (list: Node[], scope: Scope) => {
    for (const node of list) {
      switch (node.kind) {
        case 'text':
          out += node.text;
          break;
        case 'out': {
          const value = evalPipe(node.pipe, scope, node.line);
          if (!node.pipe.decl.length) out += format(value);
          break;
        }
        case 'if': {
          const branch = node.branches.find(
            (b) => b.cond === null || truthy(evalPipe(b.cond, scope, node.line)),
          );
          if (branch) run(branch.body, { dot: scope.dot, vars: new Map(scope.vars) });
          break;
        }
        case 'with': {
          const value = evalPipe(node.pipe, scope, node.line);
          if (truthy(value)) run(node.body, { dot: value, vars: new Map(scope.vars) });
          else run(node.otherwise, scope);
          break;
        }
        case 'range': {
          const decl = node.pipe.decl;
          const value = evalPipe({ ...node.pipe, decl: [] }, scope, node.line);
          const entries: [unknown, unknown][] = Array.isArray(value)
            ? value.map((v, i) => [i, v])
            : value instanceof Map
              ? [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))
              : [];
          if (!entries.length) {
            run(node.otherwise, scope);
            break;
          }
          for (const [key, item] of entries) {
            const vars = new Map(scope.vars);
            if (decl.length === 1) vars.set(decl[0], item);
            if (decl.length === 2) {
              vars.set(decl[0], key);
              vars.set(decl[1], item);
            }
            run(node.body, { dot: item, vars });
          }
          break;
        }
      }
    }
  };
  run(nodes, { dot: data, vars: new Map([['$', data]]) });
  return out;
}
