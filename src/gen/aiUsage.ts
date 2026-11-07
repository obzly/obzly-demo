// AI observability sample data, deterministic over the demo's 14 days:
// Claude Code OpenTelemetry events from five Harborline engineers (sessions,
// prompts, API requests, tool calls) and LLM call spans from the fictional
// support-assistant service (plus a nightly catalog enrichment job).
import { hashString, hex, int, mix, pick, poisson, rng, uuidFrom, weighted } from '../lib/rng';
import { CLAUDE_CODE_USERS, type ClaudeCodeUser } from '../seed/people';
import { DAY, HOUR, MINUTE } from '../seed/people';
import { PROJECT_ID, dataStart, traceIdAt, traffic } from '../world';

// ---------------------------------------------------------------------------
// Models and the prices Claude Code's own cost estimate uses.
// ---------------------------------------------------------------------------

export const SONNET = 'claude-sonnet-4-5-20250929';
export const OPUS = 'claude-opus-4-1-20250805';
export const HAIKU = 'claude-haiku-4-5-20251001';
export const GPT_MINI = 'gpt-4.1-mini-2025-04-14';
export const EMBEDDING = 'text-embedding-3-small';

/** USD per million tokens: input, output, cache read, cache write. */
const CC_PRICES: Record<string, [number, number, number, number]> = {
  [SONNET]: [3, 15, 0.3, 3.75],
  [OPUS]: [15, 75, 1.5, 18.75],
  [HAIKU]: [1, 5, 0.1, 1.25],
};

const CLAUDE_CODE_VERSION = '2.1.12';

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export interface CcEvent {
  ts: number;
  /** Without the "claude_code." prefix. */
  event: string;
  fields: Record<string, string>;
}

export interface CcSession {
  id: string;
  user: string;
  terminal: string;
  start: number;
  mainModel: string;
}

const sessionCache = new Map<number, CcSession[]>();

/** Sessions started on one UTC day (day = floor(ms / DAY)). */
export function sessionsOnDay(day: number): CcSession[] {
  const hit = sessionCache.get(day);
  if (hit) return hit;
  const weekday = new Date(day * DAY).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const out: CcSession[] = [];
  for (const user of CLAUDE_CODE_USERS) {
    const r = rng(mix(day, hashString(user.email), 7));
    const count = weekend ? (r() < 0.2 ? 1 : 0) : int(r, user.sessions[0], user.sessions[1]);
    for (let s = 0; s < count; s++) {
      const start = day * DAY + (user.startHour + r() * 8.5) * HOUR;
      out.push({
        id: uuidFrom(`cc:${user.email}:${day}:${s}`),
        user: user.email,
        terminal: user.terminal,
        start: Math.floor(start),
        mainModel: r() < user.opusShare ? OPUS : SONNET,
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  if (sessionCache.size > 400) sessionCache.clear();
  sessionCache.set(day, out);
  return out;
}

type ToolSpec = {
  name: string;
  weight: number;
  /** Needs a permission prompt (else allowed by config). */
  asks: boolean;
  failRate: number;
  ms: [number, number];
};

const TOOLS: ToolSpec[] = [
  { name: 'Read', weight: 30, asks: false, failRate: 0.02, ms: [8, 120] },
  { name: 'Grep', weight: 14, asks: false, failRate: 0.01, ms: [20, 400] },
  { name: 'Glob', weight: 6, asks: false, failRate: 0.0, ms: [10, 90] },
  { name: 'Edit', weight: 20, asks: true, failRate: 0.05, ms: [15, 160] },
  { name: 'Bash', weight: 16, asks: true, failRate: 0.14, ms: [300, 45_000] },
  { name: 'Write', weight: 4, asks: true, failRate: 0.02, ms: [10, 120] },
  { name: 'TodoWrite', weight: 5, asks: false, failRate: 0.0, ms: [3, 20] },
  { name: 'WebFetch', weight: 2, asks: true, failRate: 0.12, ms: [600, 6_000] },
  { name: 'Task', weight: 2, asks: false, failRate: 0.03, ms: [20_000, 180_000] },
  { name: 'mcp__obzly__search_logs', weight: 3, asks: true, failRate: 0.04, ms: [250, 2_500] },
];
const TOOL_WEIGHTS = TOOLS.map((t) => [t, t.weight] as const);

const eventCache = new Map<string, CcEvent[]>();

/** Every event of a session, oldest first (future ones included; callers clip at now). */
export function sessionEvents(session: CcSession): CcEvent[] {
  const hit = eventCache.get(session.id);
  if (hit) return hit;
  const r = rng(hashString(session.id));
  const base = {
    session_id: session.id,
    user_email: session.user,
    terminal_type: session.terminal,
    app_version: CLAUDE_CODE_VERSION,
  };
  const events: CcEvent[] = [];
  const push = (ts: number, event: string, fields: Record<string, string | number>) => {
    const strings: Record<string, string> = { ...base };
    for (const [k, v] of Object.entries(fields)) strings[k] = String(v);
    events.push({ ts: Math.floor(ts), event, fields: strings });
  };

  let t = session.start;
  push(t, 'mcp_server_connection', {
    status: 'connected',
    transport_type: 'http',
    server_scope: 'user',
    duration_ms: int(r, 180, 900),
  });
  t += int(r, 2_000, 15_000);

  const prompts = int(r, 3, 11);
  const opus = session.mainModel === OPUS;
  for (let p = 0; p < prompts; p++) {
    push(t, 'user_prompt', { prompt_length: int(r, 18, 1600) });
    t += int(r, 200, 1_500);
    const steps = int(r, 2, 10);
    for (let step = 0; step < steps; step++) {
      // A quick Haiku call now and then (titles, summaries, bash safety checks).
      if (r() < 0.25) {
        const fields = apiRequest(r, HAIKU, 4_000 + int(r, 0, 3_000), false);
        push(t, 'api_request', fields);
        t += Number(fields.duration_ms) * 0.3;
      }
      if (r() < 0.012) {
        const overloaded = r() < 0.6;
        push(t, 'api_error', {
          model: session.mainModel,
          status_code: overloaded ? '529' : '429',
          error: overloaded ? 'Overloaded' : 'Rate limited: too many requests',
          duration_ms: int(r, 300, 2_500),
          attempt: 1,
        });
        t += int(r, 1_000, 6_000);
      }
      const context = Math.min(160_000, 22_000 + p * 9_000 + step * 3_200 + int(r, 0, 6_000));
      const fields = apiRequest(r, session.mainModel, context, opus);
      push(t, 'api_request', fields);
      t += Number(fields.duration_ms);
      push(t, 'assistant_response', {
        model: session.mainModel,
        response_length: int(r, 40, 4_000),
      });
      if (step === steps - 1) break;

      const tool = weighted(r, TOOL_WEIGHTS);
      let decision = 'accept';
      let source = 'config';
      if (tool.asks) {
        const roll = r();
        if (roll < 0.06) {
          decision = 'reject';
          source = 'user_reject';
        } else {
          source = roll < 0.55 ? 'user_temporary' : roll < 0.8 ? 'user_permanent' : 'config';
        }
        t += source.startsWith('user') ? int(r, 1_500, 25_000) : 50;
      }
      push(t, 'tool_decision', { tool_name: tool.name, decision, source });
      if (decision === 'reject') {
        t += int(r, 5_000, 40_000);
        continue;
      }
      const duration = Math.round(tool.ms[0] + (tool.ms[1] - tool.ms[0]) * r() ** 2);
      t += duration;
      push(t, 'tool_result', {
        tool_name: tool.name,
        success: r() >= tool.failRate ? 'true' : 'false',
        duration_ms: duration,
        decision,
        decision_source: source,
      });
    }
    // The engineer reads, tests, thinks.
    t += int(r, 25_000, 6 * MINUTE);
  }
  if (eventCache.size > 600) eventCache.clear();
  eventCache.set(session.id, events);
  return events;
}

function apiRequest(
  r: () => number,
  model: string,
  context: number,
  slow: boolean,
): Record<string, string | number> {
  const small = model === HAIKU;
  const input = small ? int(r, 200, 3_000) : int(r, 4, 2_400);
  const output = small ? int(r, 20, 400) : int(r, 60, 2_600);
  const cacheRead = small ? 0 : Math.max(0, context - int(r, 2_000, 9_000));
  const cacheCreation = small ? 0 : int(r, 600, 12_000);
  const [pi, po, pr, pw] = CC_PRICES[model] ?? CC_PRICES[SONNET];
  const cost = (input * pi + output * po + cacheRead * pr + cacheCreation * pw) / 1e6;
  const ttft = Math.round((small ? 250 : slow ? 1_400 : 800) + r() * (small ? 500 : 1_800));
  const perToken = small ? 4 : slow ? 22 : 12;
  return {
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    cost_usd_micros: Math.round(cost * 1e6),
    duration_ms: Math.round(ttft + output * perToken * (0.7 + r() * 0.6)),
    ttft_ms: ttft,
  };
}

/** Claude Code events with from <= ts <= to (clipped to the demo's data and now), oldest first. */
export function ccEventsBetween(projectId: string, from: number, to: number, now = Date.now()) {
  if (projectId !== PROJECT_ID) return [];
  const lo = Math.max(from, dataStart(now));
  const hi = Math.min(to, now);
  const out: CcEvent[] = [];
  if (lo > hi) return out;
  for (let day = Math.floor(lo / DAY) - 1; day <= Math.floor(hi / DAY); day++) {
    for (const session of sessionsOnDay(day)) {
      if (session.start > hi) continue;
      for (const event of sessionEvents(session)) {
        if (event.ts >= lo && event.ts <= hi) out.push(event);
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** One session's events up to now; undefined when unknown. */
export function sessionById(projectId: string, sessionId: string, now = Date.now()) {
  if (projectId !== PROJECT_ID) return undefined;
  const today = Math.floor(now / DAY);
  for (let day = Math.floor(dataStart(now) / DAY) - 1; day <= today; day++) {
    const session = sessionsOnDay(day).find((s) => s.id === sessionId);
    if (session) return { session, events: sessionEvents(session).filter((e) => e.ts <= now) };
  }
  return undefined;
}

export type { ClaudeCodeUser };

// ---------------------------------------------------------------------------
// LLM apps (GenAI spans)
// ---------------------------------------------------------------------------

export interface LlmSpan {
  timestamp: number;
  service: string;
  operation: string;
  model: string;
  provider: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  isError: boolean;
  errorType: string;
  finishReasons: string[];
  traceId: string;
  spanId: string;
  serverAddress: string;
}

export const LLM_SLOT_MS = MINUTE;
export const LLM_GATEWAY = 'llm-gateway.harborline.example.com';
/** support-assistant calls per second at traffic 1. */
const SUPPORT_RATE = 0.025;

type CallKind = 'mini' | 'sonnet' | 'embed';
const KINDS: (readonly [CallKind, number])[] = [
  ['mini', 52],
  ['sonnet', 26],
  ['embed', 22],
];

const llmCache = new Map<number, LlmSpan[]>();

const isEnrichmentWindow = (t: number) => {
  const minute = (t % DAY) / MINUTE;
  return minute >= 60 && minute < 100; // 01:00-01:40 UTC
};

/** One minute's LLM spans, oldest first. */
export function llmSlot(slot: number, now = Date.now()): LlmSpan[] {
  const t0 = slot * LLM_SLOT_MS;
  if (t0 > now || t0 + LLM_SLOT_MS < dataStart(now)) return [];
  const hit = llmCache.get(slot);
  if (hit && t0 + LLM_SLOT_MS <= now) return hit;

  const r = rng(mix(slot, 31));
  const spans: LlmSpan[] = [];
  const count = poisson(r, SUPPORT_RATE * 60 * traffic(t0));
  for (let i = 0; i < count; i++) {
    const ts = t0 + Math.floor(r() * LLM_SLOT_MS);
    spans.push(supportCall(r, ts, mix(slot, i, 99), weighted(r, KINDS)));
  }
  if (isEnrichmentWindow(t0)) {
    const batch = poisson(r, 18);
    for (let i = 0; i < batch; i++) {
      const ts = t0 + Math.floor(r() * LLM_SLOT_MS);
      spans.push(enrichmentCall(r, ts, mix(slot, i, 77)));
    }
  }
  spans.sort((a, b) => a.timestamp - b.timestamp);
  const done = spans.filter((s) => s.timestamp + s.durationMs <= now || t0 + LLM_SLOT_MS <= now);
  if (t0 + LLM_SLOT_MS <= now) {
    if (llmCache.size > 30_000) llmCache.clear();
    llmCache.set(slot, done);
  }
  return done;
}

function span(
  seed: number,
  ts: number,
  fields: Omit<LlmSpan, 'timestamp' | 'traceId' | 'spanId' | 'serverAddress'>,
): LlmSpan {
  const traceId = traceIdAt(ts, seed);
  return {
    timestamp: ts,
    traceId,
    spanId: hex(mix(seed, 5), 16),
    serverAddress: LLM_GATEWAY,
    ...fields,
  };
}

function supportCall(r: () => number, ts: number, seed: number, kind: CallKind): LlmSpan {
  const errorRoll = r();
  const slowTail = r() < 0.03 ? 3 : 1;
  if (kind === 'embed') {
    const failed = errorRoll < 0.004;
    return span(seed, ts, {
      service: 'support-assistant',
      operation: 'embeddings',
      model: EMBEDDING,
      provider: 'openai',
      durationMs: failed ? int(r, 80, 200) : Math.round((40 + r() * 200) * slowTail),
      inputTokens: failed ? 0 : int(r, 40, 800),
      outputTokens: 0,
      cachedTokens: 0,
      isError: failed,
      errorType: failed ? 'RateLimitError' : '',
      finishReasons: [],
    });
  }
  const anthropic = kind === 'sonnet';
  const failed = errorRoll < (anthropic ? 0.018 : 0.01);
  const timeout = failed && r() < 0.35;
  const input = anthropic ? int(r, 2_000, 12_000) : int(r, 600, 4_200);
  const output = anthropic ? int(r, 120, 900) : int(r, 60, 500);
  const cached = anthropic
    ? r() < 0.7
      ? Math.floor(input * (0.4 + r() * 0.45))
      : 0
    : r() < 0.4
      ? Math.floor((input * (0.3 + r() * 0.5)) / 128) * 128
      : 0;
  const duration = Math.round(
    ((anthropic ? 1_200 : 450) + output * (anthropic ? 14 : 8) * (0.7 + r() * 0.6)) * slowTail,
  );
  const finish = anthropic
    ? weighted(r, [
        ['end_turn', 70],
        ['tool_use', 27],
        ['max_tokens', 3],
      ] as const)
    : weighted(r, [
        ['stop', 72],
        ['tool_calls', 26],
        ['length', 2],
      ] as const);
  return span(seed, ts, {
    service: 'support-assistant',
    operation: 'chat',
    model: anthropic ? SONNET : GPT_MINI,
    provider: anthropic ? 'anthropic' : 'openai',
    durationMs: failed ? (timeout ? 30_000 + int(r, 0, 400) : int(r, 90, 400)) : duration,
    inputTokens: failed ? 0 : input,
    outputTokens: failed ? 0 : output,
    cachedTokens: failed ? 0 : cached,
    isError: failed,
    errorType: failed
      ? anthropic
        ? timeout
          ? 'APITimeoutError'
          : pick(r, ['overloaded_error', 'rate_limit_error'])
        : timeout
          ? 'APITimeoutError'
          : 'RateLimitError'
      : '',
    finishReasons: failed ? [] : [finish],
  });
}

function enrichmentCall(r: () => number, ts: number, seed: number): LlmSpan {
  const output = int(r, 120, 420);
  return span(seed, ts, {
    service: 'catalog',
    operation: 'chat',
    model: HAIKU,
    provider: 'anthropic',
    durationMs: Math.round(380 + output * 6 * (0.7 + r() * 0.6)),
    inputTokens: int(r, 700, 2_600),
    outputTokens: output,
    cachedTokens: int(r, 0, 1) ? 512 : 0,
    isError: false,
    errorType: '',
    finishReasons: ['end_turn'],
  });
}

/** LLM spans with from <= timestamp < to, oldest first. */
export function llmSpansBetween(projectId: string, from: number, to: number, now = Date.now()) {
  const out: LlmSpan[] = [];
  if (projectId !== PROJECT_ID) return out;
  const lo = Math.max(from, dataStart(now));
  const hi = Math.min(to, now);
  for (let slot = Math.floor(lo / LLM_SLOT_MS); slot * LLM_SLOT_MS <= hi; slot++) {
    for (const s of llmSlot(slot, now)) {
      if (s.timestamp >= lo && s.timestamp < hi) out.push(s);
    }
  }
  return out;
}

/** Percentile (0..1) of numbers, interpolated like DuckDB's quantile_cont. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Rounds a bucket up to a clock-friendly size (the backend's niceBucketSeconds). */
export function niceBucketSeconds(seconds: number): number {
  for (const nice of [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]) {
    if (seconds <= nice) return nice;
  }
  return Math.ceil(seconds / 86400) * 86400;
}
