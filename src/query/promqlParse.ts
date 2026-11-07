// PromQL tokenizer and recursive-descent parser for the demo's evaluator
// (./promql.ts). Follows Prometheus 3's grammar for the supported subset,
// including quoted metric and label names ({"k8s.pod.name"="x"}), and
// normalizes names the way the backend does (dots become underscores).
import type { LabelMatcher } from '../gen/metricRegistry';
import { DemoError } from '../router';

export const SUBSET_NOTE = '(the demo supports a subset of PromQL)';

export class PromQLError extends DemoError {
  constructor(message: string) {
    super(400, `invalid PromQL: ${message}`);
  }
}

const unsupported = (what: string): never => {
  throw new PromQLError(`${what} isn't supported ${SUBSET_NOTE}`);
};

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type ValueType = 'scalar' | 'vector' | 'matrix' | 'string';

export interface AtModifier {
  /** Fixed evaluation time (ms), or the query's start/end. */
  time?: number;
  ref?: 'start' | 'end';
}

export interface SelectorNode {
  kind: 'selector';
  name?: string;
  matchers: LabelMatcher[];
  offset: number;
  at?: AtModifier;
}

export type Expr =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | SelectorNode
  | { kind: 'matrix'; selector: SelectorNode; range: number }
  | {
      kind: 'subquery';
      expr: Expr;
      range: number;
      step?: number;
      offset: number;
      at?: AtModifier;
    }
  | { kind: 'call'; func: string; args: Expr[] }
  | {
      kind: 'agg';
      op: string;
      expr: Expr;
      param?: Expr;
      grouping: string[];
      without: boolean;
    }
  | {
      kind: 'binary';
      op: string;
      lhs: Expr;
      rhs: Expr;
      bool: boolean;
      matching?: VectorMatching;
    }
  | { kind: 'unary'; op: '-' | '+'; expr: Expr }
  | { kind: 'paren'; expr: Expr };

export interface VectorMatching {
  card: 'one-to-one' | 'many-to-one' | 'one-to-many';
  on: boolean;
  labels: string[];
  include: string[];
}

// ---------------------------------------------------------------------------
// Functions: argument types (a trailing ? is optional, ... repeats) and result.
// ---------------------------------------------------------------------------

interface FuncSig {
  args: string[];
  ret: ValueType;
}

const V = 'vector';
const M = 'matrix';
const S = 'scalar';
const STR = 'string';

const sig = (ret: ValueType, ...args: string[]): FuncSig => ({ args, ret });

export const FUNCTIONS: Record<string, FuncSig> = {
  rate: sig(V, M),
  irate: sig(V, M),
  increase: sig(V, M),
  delta: sig(V, M),
  idelta: sig(V, M),
  deriv: sig(V, M),
  predict_linear: sig(V, M, S),
  changes: sig(V, M),
  resets: sig(V, M),
  avg_over_time: sig(V, M),
  min_over_time: sig(V, M),
  max_over_time: sig(V, M),
  sum_over_time: sig(V, M),
  count_over_time: sig(V, M),
  last_over_time: sig(V, M),
  first_over_time: sig(V, M),
  present_over_time: sig(V, M),
  stddev_over_time: sig(V, M),
  stdvar_over_time: sig(V, M),
  mad_over_time: sig(V, M),
  quantile_over_time: sig(V, S, M),
  absent_over_time: sig(V, M),
  abs: sig(V, V),
  ceil: sig(V, V),
  floor: sig(V, V),
  round: sig(V, V, `${S}?`),
  sqrt: sig(V, V),
  exp: sig(V, V),
  ln: sig(V, V),
  log2: sig(V, V),
  log10: sig(V, V),
  sgn: sig(V, V),
  sin: sig(V, V),
  cos: sig(V, V),
  tan: sig(V, V),
  asin: sig(V, V),
  acos: sig(V, V),
  atan: sig(V, V),
  sinh: sig(V, V),
  cosh: sig(V, V),
  tanh: sig(V, V),
  asinh: sig(V, V),
  acosh: sig(V, V),
  atanh: sig(V, V),
  deg: sig(V, V),
  rad: sig(V, V),
  pi: sig(S),
  clamp: sig(V, V, S, S),
  clamp_min: sig(V, V, S),
  clamp_max: sig(V, V, S),
  absent: sig(V, V),
  vector: sig(V, S),
  scalar: sig(S, V),
  time: sig(S),
  timestamp: sig(V, V),
  label_replace: sig(V, V, STR, STR, STR, STR),
  label_join: sig(V, V, STR, STR, `${STR}...`),
  histogram_quantile: sig(V, S, V),
  sort: sig(V, V),
  sort_desc: sig(V, V),
  minute: sig(V, `${V}?`),
  hour: sig(V, `${V}?`),
  day_of_week: sig(V, `${V}?`),
  day_of_month: sig(V, `${V}?`),
  day_of_year: sig(V, `${V}?`),
  days_in_month: sig(V, `${V}?`),
  month: sig(V, `${V}?`),
  year: sig(V, `${V}?`),
};

/** Real PromQL functions the demo leaves out. */
const KNOWN_UNSUPPORTED = new Set([
  'holt_winters',
  'double_exponential_smoothing',
  'histogram_count',
  'histogram_sum',
  'histogram_avg',
  'histogram_fraction',
  'histogram_stddev',
  'histogram_stdvar',
  'info',
  'sort_by_label',
  'sort_by_label_desc',
  'ts_of_max_over_time',
  'ts_of_min_over_time',
  'ts_of_last_over_time',
]);

const AGGREGATIONS = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'group',
  'stddev',
  'stdvar',
  'topk',
  'bottomk',
  'quantile',
  'count_values',
  'limitk',
  'limit_ratio',
]);
const PARAM_AGGREGATIONS = new Set([
  'topk',
  'bottomk',
  'quantile',
  'count_values',
  'limitk',
  'limit_ratio',
]);

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokType = 'num' | 'dur' | 'str' | 'ident' | 'op' | 'punct' | 'eof';

interface Tok {
  type: TokType;
  text: string;
  pos: number;
  num?: number;
  str?: string;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
// Recording-rule names may contain ":" but not start with it (it is the subquery separator).
const isIdentStart = (c: string) => /[a-zA-Z_]/.test(c);
const isIdentChar = (c: string) => /[a-zA-Z0-9_:]/.test(c);
/** A letter, digit or underscore: what may not directly follow a number or duration. */
const isWordChar = (c: string) => /[a-zA-Z0-9_]/.test(c);

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};
const DURATION = /^(?:\d+(?:ms|s|m|h|d|w|y))+/;

export function parseDuration(text: string): number | undefined {
  if (!DURATION.test(text) || DURATION.exec(text)![0] !== text) return undefined;
  let total = 0;
  for (const [, n, u] of text.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) total += Number(n) * UNIT_MS[u];
  return total;
}

const fail = (pos: number, message: string): never => {
  throw new PromQLError(`parse error at char ${pos + 1}: ${message}`);
};

function unquote(src: string, start: number): { value: string; end: number } {
  const quote = src[start];
  let i = start + 1;
  let out = '';
  if (quote === '`') {
    const close = src.indexOf('`', i);
    if (close < 0) fail(start, 'unterminated raw string');
    return { value: src.slice(i, close), end: close + 1 };
  }
  while (i < src.length) {
    const c = src[i];
    if (c === quote) return { value: out, end: i + 1 };
    if (c === '\n') fail(i, 'unterminated quoted string');
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    const e = src[i + 1];
    i += 2;
    switch (e) {
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'v':
        out += '\v';
        break;
      case '\\':
        out += '\\';
        break;
      case '"':
      case "'":
        if (e !== quote) fail(i - 2, 'unknown escape sequence');
        out += e;
        break;
      case 'x':
      case 'u':
      case 'U': {
        const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
        const hexText = src.slice(i, i + len);
        if (!/^[0-9a-fA-F]+$/.test(hexText) || hexText.length !== len)
          fail(i, 'invalid escape sequence');
        out += String.fromCodePoint(parseInt(hexText, 16));
        i += len;
        break;
      }
      default:
        if (e !== undefined && /[0-7]/.test(e)) {
          const oct = src.slice(i - 1, i + 2);
          if (!/^[0-7]{3}$/.test(oct)) fail(i, 'invalid escape sequence');
          out += String.fromCharCode(parseInt(oct, 8));
          i += 2;
          break;
        }
        fail(i - 2, 'unknown escape sequence');
    }
  }
  return fail(start, 'unterminated quoted string');
}

const OPERATORS = ['==', '!=', '=~', '!~', '>=', '<=', '>', '<', '=', '+', '-', '*', '/', '%', '^'];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const hexMatch = /^0[xX][0-9a-fA-F]+/.exec(src.slice(i));
      if (hexMatch) {
        toks.push({ type: 'num', text: hexMatch[0], pos: start, num: parseInt(hexMatch[0], 16) });
        i += hexMatch[0].length;
        continue;
      }
      const rest = src.slice(i);
      const dur = DURATION.exec(rest);
      if (dur && !isWordChar(rest[dur[0].length] ?? '') && rest[dur[0].length] !== '.') {
        toks.push({ type: 'dur', text: dur[0], pos: start, num: parseDuration(dur[0]) });
        i += dur[0].length;
        continue;
      }
      const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)!;
      if (isWordChar(rest[num[0].length] ?? ''))
        fail(start, `bad number or duration syntax "${rest.slice(0, num[0].length + 1)}"`);
      toks.push({ type: 'num', text: num[0], pos: start, num: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdentChar(src[j])) j++;
      const text = src.slice(i, j);
      const lower = text.toLowerCase();
      if (lower === 'inf' || lower === 'nan') {
        toks.push({ type: 'num', text, pos: start, num: lower === 'inf' ? Infinity : NaN });
      } else {
        toks.push({ type: 'ident', text, pos: start });
      }
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const { value, end } = unquote(src, i);
      toks.push({ type: 'str', text: src.slice(i, end), pos: start, str: value });
      i = end;
      continue;
    }
    const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
    if (op) {
      toks.push({ type: 'op', text: op, pos: start });
      i += op.length;
      continue;
    }
    if ('(){}[],:@'.includes(c)) {
      toks.push({ type: 'punct', text: c, pos: start });
      i++;
      continue;
    }
    fail(start, `unexpected character "${c}"`);
  }
  toks.push({ type: 'eof', text: '', pos: src.length });
  return toks;
}

// ---------------------------------------------------------------------------
// Name normalization (mirrors backend attrnames / NormalizePromQL).
// ---------------------------------------------------------------------------

const sanitize = (name: string) => {
  const s = name.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[0-9]/.test(s) ? `_${s}` : s;
};
export const normalizeLabelName = (name: string): string =>
  name === '__name__'
    ? name
    : sanitize(name.startsWith('resource.') ? name.slice('resource.'.length) : name);
export const normalizeMetricName = sanitize;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  unless: 2,
  '==': 3,
  '!=': 3,
  '<=': 3,
  '<': 3,
  '>=': 3,
  '>': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
  atan2: 5,
  '^': 6,
};
export const COMPARISON = new Set(['==', '!=', '<=', '<', '>=', '>']);
export const SET_OPS = new Set(['and', 'or', 'unless']);

const regexOk = (pattern: string, pos: number) => {
  try {
    new RegExp(`^(?:${pattern})$`);
  } catch {
    fail(pos, `invalid regular expression "${pattern}"`);
  }
};

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.i + offset, this.toks.length - 1)];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private is(text: string, type?: TokType): boolean {
    const t = this.peek();
    return t.text === text && (type === undefined || t.type === type) && t.type !== 'str';
  }
  private expect(text: string): Tok {
    const t = this.next();
    if (t.text !== text || t.type === 'str')
      fail(t.pos, `unexpected ${describe(t)}, expected "${text}"`);
    return t;
  }

  parse(): Expr {
    const expr = this.expr(0);
    const t = this.peek();
    if (t.type !== 'eof') fail(t.pos, `unexpected ${describe(t)}`);
    return expr;
  }

  private binaryOp(): string | undefined {
    const t = this.peek();
    if (t.type === 'op' && t.text in PRECEDENCE) return t.text;
    if (t.type === 'ident' && (SET_OPS.has(t.text) || t.text === 'atan2')) return t.text;
    return undefined;
  }

  private expr(minPrec: number): Expr {
    let lhs = this.unary();
    for (;;) {
      const op = this.binaryOp();
      if (!op || PRECEDENCE[op] < minPrec) break;
      const opTok = this.next();
      let bool = false;
      if (this.is('bool', 'ident')) {
        this.next();
        bool = true;
      }
      let matching: VectorMatching | undefined;
      if (this.is('on', 'ident') || this.is('ignoring', 'ident')) {
        const on = this.next().text === 'on';
        matching = { card: 'one-to-one', on, labels: this.labelList(), include: [] };
      }
      if (this.is('group_left', 'ident') || this.is('group_right', 'ident')) {
        const left = this.next().text === 'group_left';
        matching ??= { card: 'one-to-one', on: false, labels: [], include: [] };
        matching.card = left ? 'many-to-one' : 'one-to-many';
        matching.include = this.is('(') ? this.labelList() : [];
      }
      const rhs = this.expr(op === '^' ? PRECEDENCE[op] : PRECEDENCE[op] + 1);
      lhs = this.checkBinary({ kind: 'binary', op, lhs, rhs, bool, matching }, opTok.pos);
    }
    return lhs;
  }

  private checkBinary(node: Extract<Expr, { kind: 'binary' }>, pos: number): Expr {
    const lt = typeOf(node.lhs);
    const rt = typeOf(node.rhs);
    if ((lt !== 'scalar' && lt !== 'vector') || (rt !== 'scalar' && rt !== 'vector')) {
      fail(pos, 'binary expression must contain only scalar and instant vector types');
    }
    if (node.bool && !COMPARISON.has(node.op))
      fail(pos, 'bool modifier can only be used on comparison operators');
    if (SET_OPS.has(node.op)) {
      if (lt === 'scalar' || rt === 'scalar')
        fail(pos, `set operator "${node.op}" not allowed in binary scalar expression`);
      if (node.matching && node.matching.card !== 'one-to-one')
        fail(pos, `no grouping allowed for "${node.op}" operation`);
    }
    if (COMPARISON.has(node.op) && lt === 'scalar' && rt === 'scalar' && !node.bool) {
      fail(pos, 'comparisons between scalars must use BOOL modifier');
    }
    if (node.matching && (lt === 'scalar' || rt === 'scalar')) {
      fail(pos, 'vector matching only allowed between instant vectors');
    }
    // Fold constant arithmetic like 1e6 or 1024 * 1024.
    if (node.lhs.kind === 'number' && node.rhs.kind === 'number' && !COMPARISON.has(node.op)) {
      const value = scalarOp(node.op, node.lhs.value, node.rhs.value);
      if (value !== undefined) return { kind: 'number', value };
    }
    return node;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.type === 'op' && (t.text === '-' || t.text === '+')) {
      this.next();
      const operand = this.expr(PRECEDENCE['^']);
      const type = typeOf(operand);
      if (type !== 'scalar' && type !== 'vector')
        fail(
          t.pos,
          'unary expression only allowed on expressions of type scalar or instant vector',
        );
      if (t.text === '+') return operand;
      if (operand.kind === 'number') return { kind: 'number', value: -operand.value };
      return { kind: 'unary', op: '-', expr: operand };
    }
    return this.postfix(this.primary());
  }

  private postfix(expr: Expr): Expr {
    for (;;) {
      const t = this.peek();
      if (t.text === '[' && t.type === 'punct') {
        this.next();
        const range = this.duration();
        if (this.is(':', 'punct')) {
          this.next();
          const step = this.is(']', 'punct') ? undefined : this.duration();
          this.expect(']');
          if (typeOf(expr) !== 'vector')
            fail(t.pos, `subquery is only allowed on instant vector, got ${typeOf(expr)}`);
          expr = { kind: 'subquery', expr, range, step, offset: 0 };
          continue;
        }
        this.expect(']');
        if (expr.kind !== 'selector') fail(t.pos, 'ranges only allowed for vector selectors');
        const selector = expr as SelectorNode;
        if (selector.offset || selector.at)
          fail(t.pos, 'no offset or @ modifiers allowed before range');
        expr = { kind: 'matrix', selector, range };
        continue;
      }
      if (t.type === 'ident' && t.text === 'offset') {
        this.next();
        let sign = 1;
        if (this.is('-', 'op')) {
          this.next();
          sign = -1;
        }
        const offset = sign * this.duration();
        const target = expr.kind === 'matrix' ? expr.selector : expr;
        if (target.kind !== 'selector' && target.kind !== 'subquery') {
          fail(
            t.pos,
            'offset modifier must be preceded by an instant vector selector or range vector selector or a subquery',
          );
        }
        const node = target as SelectorNode | Extract<Expr, { kind: 'subquery' }>;
        if (node.offset) fail(t.pos, 'offset may not be set multiple times');
        node.offset = offset;
        continue;
      }
      if (t.type === 'punct' && t.text === '@') {
        this.next();
        const at = this.atModifier();
        const target = expr.kind === 'matrix' ? expr.selector : expr;
        if (target.kind !== 'selector' && target.kind !== 'subquery') {
          fail(
            t.pos,
            '@ modifier must be preceded by an instant vector selector or range vector selector or a subquery',
          );
        }
        const node = target as SelectorNode | Extract<Expr, { kind: 'subquery' }>;
        if (node.at) fail(t.pos, '@ may not be set multiple times');
        node.at = at;
        continue;
      }
      return expr;
    }
  }

  private atModifier(): AtModifier {
    const t = this.next();
    if (t.type === 'num') return { time: t.num! * 1000 };
    if (t.type === 'op' && t.text === '-' && this.peek().type === 'num')
      return { time: -this.next().num! * 1000 };
    if (t.type === 'ident' && (t.text === 'start' || t.text === 'end')) {
      this.expect('(');
      this.expect(')');
      return { ref: t.text };
    }
    return fail(
      t.pos,
      `unexpected ${describe(t)} in @ modifier, expected a timestamp, start() or end()`,
    );
  }

  private duration(): number {
    const t = this.next();
    if (t.type === 'dur') return t.num!;
    // Prometheus 3 accepts plain numbers of seconds as durations.
    if (t.type === 'num' && Number.isFinite(t.num)) return t.num! * 1000;
    return fail(t.pos, `unexpected ${describe(t)}, expected duration`);
  }

  private labelList(): string[] {
    this.expect('(');
    const labels: string[] = [];
    while (!this.is(')', 'punct')) {
      const t = this.next();
      if (t.type !== 'ident' && t.type !== 'str')
        fail(t.pos, `unexpected ${describe(t)} in grouping opts, expected label`);
      labels.push(normalizeLabelName(t.type === 'str' ? t.str! : t.text));
      if (this.is(',', 'punct')) this.next();
      else if (!this.is(')', 'punct'))
        fail(
          this.peek().pos,
          `unexpected ${describe(this.peek())} in grouping opts, expected "," or ")"`,
        );
    }
    this.expect(')');
    return labels;
  }

  private primary(): Expr {
    const t = this.peek();
    switch (t.type) {
      case 'num':
        this.next();
        return { kind: 'number', value: t.num! };
      case 'str':
        this.next();
        return { kind: 'string', value: t.str! };
      case 'dur':
        return fail(t.pos, `unexpected duration "${t.text}"`);
      case 'punct':
        if (t.text === '(') {
          this.next();
          const inner = this.expr(0);
          this.expect(')');
          return { kind: 'paren', expr: inner };
        }
        if (t.text === '{') return this.selector(undefined, t.pos);
        return fail(t.pos, `unexpected ${describe(t)}`);
      case 'ident':
        return this.identifier();
      default:
        return fail(t.pos, `unexpected ${describe(t)}`);
    }
  }

  private identifier(): Expr {
    const t = this.next();
    const after = this.peek();
    if (
      AGGREGATIONS.has(t.text) &&
      (after.text === '(' || after.text === 'by' || after.text === 'without') &&
      after.type !== 'str'
    ) {
      return this.aggregation(t);
    }
    if (after.type === 'punct' && after.text === '(') {
      return this.call(t);
    }
    if (
      ['by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'offset'].includes(
        t.text,
      )
    ) {
      fail(t.pos, `unexpected "${t.text}"`);
    }
    if (SET_OPS.has(t.text)) fail(t.pos, `unexpected "${t.text}"`);
    return this.selector(normalizeMetricName(t.text), t.pos);
  }

  private aggregation(opTok: Tok): Expr {
    const op = opTok.text;
    if (op === 'count_values' || op === 'limitk' || op === 'limit_ratio')
      unsupported(`The ${op} aggregation`);
    let grouping: string[] | undefined;
    let without = false;
    const readGrouping = () => {
      without = this.next().text === 'without';
      grouping = this.labelList();
    };
    if (this.is('by', 'ident') || this.is('without', 'ident')) readGrouping();
    this.expect('(');
    const args: Expr[] = [];
    while (!this.is(')', 'punct')) {
      args.push(this.expr(0));
      if (this.is(',', 'punct')) this.next();
      else if (!this.is(')', 'punct'))
        fail(
          this.peek().pos,
          `unexpected ${describe(this.peek())} in aggregation, expected "," or ")"`,
        );
    }
    this.expect(')');
    if (grouping === undefined && (this.is('by', 'ident') || this.is('without', 'ident')))
      readGrouping();
    const wantsParam = PARAM_AGGREGATIONS.has(op);
    if (args.length !== (wantsParam ? 2 : 1)) {
      fail(
        opTok.pos,
        `wrong number of arguments for aggregate expression provided, expected ${wantsParam ? 2 : 1}, got ${args.length}`,
      );
    }
    const expr = args[args.length - 1];
    const param = wantsParam ? args[0] : undefined;
    if (typeOf(expr) !== 'vector')
      fail(
        opTok.pos,
        `expected type instant vector in aggregation expression, got ${typeOf(expr)}`,
      );
    if (param && typeOf(param) !== 'scalar')
      fail(opTok.pos, `expected type scalar in aggregation parameter, got ${typeOf(param)}`);
    return { kind: 'agg', op, expr, param, grouping: grouping ?? [], without };
  }

  private call(nameTok: Tok): Expr {
    const func = nameTok.text;
    const signature = FUNCTIONS[func];
    if (!signature) {
      if (KNOWN_UNSUPPORTED.has(func)) unsupported(`The function ${func}()`);
      fail(nameTok.pos, `unknown function with name "${func}"`);
    }
    this.expect('(');
    const args: Expr[] = [];
    while (!this.is(')', 'punct')) {
      args.push(this.expr(0));
      if (this.is(',', 'punct')) this.next();
      else if (!this.is(')', 'punct'))
        fail(
          this.peek().pos,
          `unexpected ${describe(this.peek())} in function call, expected "," or ")"`,
        );
    }
    this.expect(')');
    const required = signature.args.filter((a) => !a.endsWith('?') && !a.endsWith('...')).length;
    const variadic = signature.args.some((a) => a.endsWith('...'));
    if (args.length < required || (!variadic && args.length > signature.args.length)) {
      fail(
        nameTok.pos,
        `expected ${required === signature.args.length ? required : `${required} to ${signature.args.length}`} argument(s) in call to "${func}", got ${args.length}`,
      );
    }
    args.forEach((arg, k) => {
      const want = (signature.args[Math.min(k, signature.args.length - 1)] ?? '').replace(
        /[?.]+$/,
        '',
      );
      const got = typeOf(arg);
      if (want && got !== want) {
        fail(
          nameTok.pos,
          `expected type ${typeName(want)} in call to function "${func}", got ${typeName(got)}`,
        );
      }
    });
    if (func === 'label_replace' || func === 'label_join') {
      // Label-name arguments take dotted names too, like selectors.
      const names =
        func === 'label_replace' ? [1, 3] : args.map((_, k) => k).filter((k) => k === 1 || k >= 3);
      for (const k of names) {
        const arg = args[k];
        if (arg?.kind === 'string')
          args[k] = { kind: 'string', value: normalizeLabelName(arg.value) };
      }
      if (func === 'label_replace' && args[4]?.kind === 'string')
        regexOk(args[4].value, nameTok.pos);
    }
    return { kind: 'call', func, args };
  }

  private selector(name: string | undefined, pos: number): Expr {
    const matchers: LabelMatcher[] = [];
    if (this.is('{', 'punct')) {
      this.next();
      while (!this.is('}', 'punct')) {
        const t = this.next();
        if (t.type !== 'ident' && t.type !== 'str')
          fail(t.pos, `unexpected ${describe(t)} in label matching, expected label name`);
        const raw = t.type === 'str' ? t.str! : t.text;
        const op = this.peek();
        if (t.type === 'str' && (op.text === ',' || op.text === '}') && op.type === 'punct') {
          // {"metric.name"}: a bare string is the metric name.
          if (name !== undefined) fail(t.pos, 'metric name must not be set twice');
          name = normalizeMetricName(raw);
        } else {
          if (op.type !== 'op' || !['=', '!=', '=~', '!~'].includes(op.text)) {
            fail(
              op.pos,
              `unexpected ${describe(op)} in label matching, expected one of "=", "!=", "=~" or "!~"`,
            );
          }
          this.next();
          const value = this.next();
          if (value.type !== 'str')
            fail(value.pos, `unexpected ${describe(value)} in label matching, expected string`);
          const label = normalizeLabelName(raw);
          let v = value.str!;
          const mop = op.text as LabelMatcher['op'];
          if (label === '__name__') {
            v = mop === '=' || mop === '!=' ? normalizeMetricName(v) : v.replace(/\\\./g, '_');
          }
          if (mop === '=~' || mop === '!~') regexOk(v, value.pos);
          matchers.push({ name: label, op: mop, value: v });
        }
        if (this.is(',', 'punct')) this.next();
        else if (!this.is('}', 'punct'))
          fail(
            this.peek().pos,
            `unexpected ${describe(this.peek())} in label matching, expected "," or "}"`,
          );
      }
      this.expect('}');
    }
    const nameMatcher = matchers.findIndex((mm) => mm.name === '__name__' && mm.op === '=');
    if (nameMatcher >= 0) {
      if (name !== undefined)
        fail(
          pos,
          `metric name must not be set twice: "${name}" or "${matchers[nameMatcher].value}"`,
        );
      name = matchers[nameMatcher].value;
      matchers.splice(nameMatcher, 1);
    }
    const nonEmpty =
      name !== undefined ||
      matchers.some((mm) => {
        switch (mm.op) {
          case '=':
            return mm.value !== '';
          case '!=':
            return mm.value === '';
          case '=~':
            return !new RegExp(`^(?:${mm.value})$`).test('');
          case '!~':
            return new RegExp(`^(?:${mm.value})$`).test('');
        }
      });
    if (!nonEmpty) fail(pos, 'vector selector must contain at least one non-empty matcher');
    return { kind: 'selector', name, matchers, offset: 0 };
  }
}

const typeName = (type: string) =>
  type === 'vector' ? 'instant vector' : type === 'matrix' ? 'range vector' : type;

function describe(t: Tok): string {
  if (t.type === 'eof') return 'end of input';
  if (t.type === 'str') return `string ${t.text}`;
  if (t.type === 'num') return `number "${t.text}"`;
  if (t.type === 'dur') return `duration "${t.text}"`;
  if (t.type === 'ident') return `identifier "${t.text}"`;
  return `"${t.text}"`;
}

export function typeOf(expr: Expr): ValueType {
  switch (expr.kind) {
    case 'number':
      return 'scalar';
    case 'string':
      return 'string';
    case 'selector':
      return 'vector';
    case 'matrix':
    case 'subquery':
      return 'matrix';
    case 'call':
      return FUNCTIONS[expr.func].ret;
    case 'agg':
      return 'vector';
    case 'binary':
      return typeOf(expr.lhs) === 'scalar' && typeOf(expr.rhs) === 'scalar' ? 'scalar' : 'vector';
    case 'unary':
    case 'paren':
      return typeOf(expr.expr);
  }
}

/** Arithmetic and comparison on two numbers; comparisons return 1/0. */
export function scalarOp(op: string, a: number, b: number): number | undefined {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '%':
      return a % b;
    case '^':
      return a ** b;
    case 'atan2':
      return Math.atan2(a, b);
    case '==':
      return a === b ? 1 : 0;
    case '!=':
      return a !== b ? 1 : 0;
    case '>':
      return a > b ? 1 : 0;
    case '<':
      return a < b ? 1 : 0;
    case '>=':
      return a >= b ? 1 : 0;
    case '<=':
      return a <= b ? 1 : 0;
    default:
      return undefined;
  }
}

const parseCache = new Map<string, Expr>();

/** Parses a PromQL expression (cached; callers must not mutate the result). */
export function parsePromQL(query: string): Expr {
  const hit = parseCache.get(query);
  if (hit) return hit;
  const expr = new Parser(lex(query)).parse();
  if (parseCache.size > 500) parseCache.clear();
  parseCache.set(query, expr);
  return expr;
}
