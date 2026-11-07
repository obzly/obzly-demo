// AI observability: Claude Code usage (overview, sessions, events), LLM apps
// (overview, slowest/failed calls), budgets with live status, and model prices.
import type {
  AiBudget,
  AiBudgetRequest,
  AiBudgetStatus,
  AiModelPrice,
  AiModelPriceRequest,
  AiUsageBreakdownRow,
  AiUsageErrorRow,
  AiUsageOverview,
  AiUsageSession,
  AiUsageSessionEvent,
  AiUsageTimeseriesPoint,
  AiUsageToolRow,
  LlmBreakdownRow,
  LlmCall,
  LlmGroupBy,
  LlmOverview,
  LlmTimeseriesPoint,
} from '../../entity/aiUsage';
import {
  type CcEvent,
  type LlmSpan,
  OPUS,
  ccEventsBetween,
  llmSpansBetween,
  niceBucketSeconds,
  quantile,
  sessionById,
} from '../gen/aiUsage';
import { DemoError, type Router } from '../router';
import { recordAudit } from '../seed/audit';
import { DAY, HOUR, type When, ago, isoOf } from '../seed/people';
import { collection, newId } from '../store';
import { PROJECT_ID } from '../world';
import { requireProject } from './bootstrap';

const MAX_BUCKETS = 2000;
const TARGET_BUCKETS = 60;
const MAX_SESSION_EVENTS = 500;

function rangeOf(query: URLSearchParams) {
  const to = query.get('to') ? Date.parse(query.get('to') as string) : Date.now();
  const from = query.get('from') ? Date.parse(query.get('from') as string) : to - DAY;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
    throw new DemoError(400, 'from and to must be RFC 3339 times with from before to');
  return { from, to };
}

function bucketSecondsOf(query: URLSearchParams, from: number, to: number) {
  const span = Math.max(1, Math.floor((to - from) / 1000));
  const asked = Number(query.get('bucketSeconds'));
  const bucket = asked > 0 ? asked : niceBucketSeconds(Math.ceil(span / TARGET_BUCKETS));
  if (span / bucket > MAX_BUCKETS)
    throw new DemoError(400, `bucketSeconds gives more than ${MAX_BUCKETS} buckets`);
  return bucket;
}

function intParam(query: URLSearchParams, name: string, fallback: number, max: number) {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  const min = name === 'offset' ? 0 : 1;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new DemoError(400, `Invalid ${name}`);
  return value;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const num = (event: CcEvent, key: string) => Number(event.fields[key] ?? 0) || 0;
const tokensOf = (e: CcEvent) =>
  num(e, 'input_tokens') +
  num(e, 'output_tokens') +
  num(e, 'cache_read_tokens') +
  num(e, 'cache_creation_tokens');
const costOf = (e: CcEvent) => num(e, 'cost_usd_micros') / 1e6;

/** The filtered events (user, model, terminal) in the range, like the backend's eventsCTE. */
function filteredEvents(projectId: string, query: URLSearchParams) {
  requireProject(projectId);
  const { from, to } = rangeOf(query);
  const user = query.get('user') || '';
  const model = query.get('model') || '';
  const terminal = query.get('terminal') || '';
  const all = ccEventsBetween(projectId, from, to);
  const events = all.filter(
    (e) =>
      (!user || e.fields.user_email === user) &&
      (!model || e.fields.model === model) &&
      (!terminal || e.fields.terminal_type === terminal),
  );
  return { from, to, all, events };
}

function breakdown(events: CcEvent[], field: string): AiUsageBreakdownRow[] {
  const rows = new Map<string, AiUsageBreakdownRow & { sessionSet: Set<string> }>();
  for (const e of events) {
    if (e.event !== 'api_request') continue;
    const key = e.fields[field];
    if (!key) continue;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        requests: 0,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        sessions: 0,
        lastSeen: 0,
        sessionSet: new Set(),
      };
      rows.set(key, row);
    }
    row.requests++;
    row.costUsd += costOf(e);
    row.inputTokens += num(e, 'input_tokens');
    row.outputTokens += num(e, 'output_tokens');
    row.cacheReadTokens += num(e, 'cache_read_tokens');
    row.cacheCreationTokens += num(e, 'cache_creation_tokens');
    row.sessionSet.add(e.fields.session_id);
    row.lastSeen = Math.max(row.lastSeen, e.ts);
  }
  return [...rows.values()]
    .map(({ sessionSet, ...row }) => ({ ...row, sessions: sessionSet.size }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 100);
}

function toolRows(events: CcEvent[]): AiUsageToolRow[] {
  const stats = new Map<string, { durations: number[]; failures: number; rejections: number }>();
  for (const e of events) {
    if (e.event !== 'tool_result' && e.event !== 'tool_decision') continue;
    const tool = e.fields.tool_name;
    if (!tool) continue;
    const stat = stats.get(tool) ?? { durations: [], failures: 0, rejections: 0 };
    if (e.event === 'tool_result') {
      stat.durations.push(num(e, 'duration_ms'));
      if (e.fields.success === 'false') stat.failures++;
    } else if (e.fields.decision === 'reject') stat.rejections++;
    stats.set(tool, stat);
  }
  return [...stats.entries()]
    .map(([tool, s]) => ({
      tool,
      calls: s.durations.length,
      failures: s.failures,
      rejections: s.rejections,
      avgDurationMs: s.durations.length
        ? s.durations.reduce((a, b) => a + b, 0) / s.durations.length
        : 0,
      p95DurationMs: quantile(s.durations, 0.95),
    }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 100);
}

function errorRows(events: CcEvent[]): AiUsageErrorRow[] {
  const rows = new Map<string, AiUsageErrorRow>();
  for (const e of events) {
    if (e.event !== 'api_error') continue;
    const statusCode = e.fields.status_code ?? '';
    const error = (e.fields.error ?? '').slice(0, 500);
    const model = e.fields.model ?? '';
    const id = `${statusCode}|${error}|${model}`;
    const row = rows.get(id) ?? { statusCode, error, model, count: 0, lastSeen: 0 };
    row.count++;
    row.lastSeen = Math.max(row.lastSeen, e.ts);
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count).slice(0, 50);
}

function overview(projectId: string, query: URLSearchParams): AiUsageOverview {
  const { from, to, all, events } = filteredEvents(projectId, query);
  const bucketSeconds = bucketSecondsOf(query, from, to);
  const bucketMs = bucketSeconds * 1000;
  const groupField = query.get('groupBy') === 'user' ? 'user_email' : 'model';

  const requests = events.filter((e) => e.event === 'api_request');
  const sessions = new Set<string>();
  const users = new Set<string>();
  let latest = 0;
  for (const e of events) {
    if (e.fields.session_id) sessions.add(e.fields.session_id);
    if (e.fields.user_email) users.add(e.fields.user_email);
    latest = Math.max(latest, e.ts);
  }
  const sum = (key: string) => requests.reduce((total, e) => total + num(e, key), 0);
  const count = (event: string) => events.filter((e) => e.event === event).length;

  const series = new Map<string, AiUsageTimeseriesPoint>();
  for (const e of requests) {
    const bucket = Math.floor(e.ts / bucketMs) * bucketMs;
    const key = e.fields[groupField] ?? '';
    const id = `${bucket}|${key}`;
    let point = series.get(id);
    if (!point) {
      point = { bucket, key, costUsd: 0, tokens: 0, requests: 0 };
      series.set(id, point);
    }
    point.costUsd += costOf(e);
    point.tokens += tokensOf(e);
    point.requests++;
  }

  const distinct = (key: string) =>
    [...new Set(all.map((e) => e.fields[key]).filter((v): v is string => !!v))].sort();

  return {
    summary: {
      requests: requests.length,
      costUsd: sum('cost_usd_micros') / 1e6,
      inputTokens: sum('input_tokens'),
      outputTokens: sum('output_tokens'),
      cacheReadTokens: sum('cache_read_tokens'),
      cacheCreationTokens: sum('cache_creation_tokens'),
      sessions: sessions.size,
      users: users.size,
      prompts: count('user_prompt'),
      apiErrors: count('api_error'),
      toolCalls: count('tool_result'),
      avgDurationMs: requests.length ? sum('duration_ms') / requests.length : 0,
      p50TtftMs: quantile(
        requests.map((e) => num(e, 'ttft_ms')),
        0.5,
      ),
    },
    latestEventAt: latest,
    timeseries: [...series.values()].sort(
      (a, b) => a.bucket - b.bucket || a.key.localeCompare(b.key),
    ),
    bucketSeconds,
    users: breakdown(events, 'user_email'),
    models: breakdown(events, 'model'),
    tools: toolRows(events),
    errors: errorRows(events),
    filterOptions: {
      users: distinct('user_email'),
      models: distinct('model'),
      terminals: distinct('terminal_type'),
    },
  };
}

const SESSION_SORT = {
  lastSeen: 'lastSeen',
  cost: 'costUsd',
  requests: 'requests',
  tokens: 'tokens',
} as const;

function sessionsPage(projectId: string, query: URLSearchParams) {
  const { events } = filteredEvents(projectId, query);
  const limit = intParam(query, 'limit', 20, 200);
  const offset = intParam(query, 'offset', 0, 1_000_000);
  const search = (query.get('search') ?? '').trim().toLowerCase();
  const sessions = new Map<string, AiUsageSession & { modelSet: Set<string> }>();
  for (const e of events) {
    const id = e.fields.session_id;
    if (!id) continue;
    let s = sessions.get(id);
    if (!s) {
      s = {
        sessionId: id,
        user: e.fields.user_email ?? '',
        terminal: e.fields.terminal_type ?? '',
        firstSeen: e.ts,
        lastSeen: e.ts,
        requests: 0,
        costUsd: 0,
        tokens: 0,
        prompts: 0,
        toolCalls: 0,
        errors: 0,
        models: [],
        modelSet: new Set(),
      };
      sessions.set(id, s);
    }
    s.firstSeen = Math.min(s.firstSeen, e.ts);
    s.lastSeen = Math.max(s.lastSeen, e.ts);
    if (e.fields.model) s.modelSet.add(e.fields.model);
    if (e.event === 'api_request') {
      s.requests++;
      s.costUsd += costOf(e);
      s.tokens += tokensOf(e);
    } else if (e.event === 'user_prompt') s.prompts++;
    else if (e.event === 'tool_result') s.toolCalls++;
    else if (e.event === 'api_error') s.errors++;
  }
  let rows: AiUsageSession[] = [...sessions.values()].map(({ modelSet, ...s }) => ({
    ...s,
    models: [...modelSet].sort(),
  }));
  if (search)
    rows = rows.filter(
      (s) => s.sessionId.toLowerCase().includes(search) || s.user.toLowerCase().includes(search),
    );
  const sortKey = SESSION_SORT[query.get('sortBy') as keyof typeof SESSION_SORT] ?? 'lastSeen';
  rows.sort((a, b) => b[sortKey] - a[sortKey] || a.sessionId.localeCompare(b.sessionId));
  return { sessions: rows.slice(offset, offset + limit), total: rows.length };
}

const toEvent = (e: CcEvent): AiUsageSessionEvent => ({
  timestamp: e.ts,
  event: e.event,
  fields: e.fields,
});

function eventsPage(projectId: string, query: URLSearchParams) {
  const { events } = filteredEvents(projectId, query);
  const limit = intParam(query, 'limit', 50, 200);
  const offset = intParam(query, 'offset', 0, 1_000_000);
  const type = query.get('event') ?? '';
  const sessionId = query.get('sessionId') ?? '';
  const search = (query.get('search') ?? '').trim().toLowerCase();
  const matching = events.filter(
    (e) =>
      (!type || e.event === type) &&
      (!sessionId || e.fields.session_id === sessionId) &&
      (!search || JSON.stringify(e.fields).toLowerCase().includes(search)),
  );
  matching.reverse();
  return {
    events: matching.slice(offset, offset + limit).map(toEvent),
    total: matching.length,
    eventTypes: [...new Set(events.map((e) => e.event))].sort(),
  };
}

// ---------------------------------------------------------------------------
// Model prices
// ---------------------------------------------------------------------------

type PriceRecord = Omit<AiModelPrice, 'seenCalls'> & { createdAt: When; updatedAt: When };

const COMMON_PRICES_AS_OF = '2026-10-27';
const common = (
  model: string,
  inputPerMillion: number,
  outputPerMillion: number,
  cachedInputPerMillion: number,
): AiModelPriceRequest => ({ model, inputPerMillion, outputPerMillion, cachedInputPerMillion });
const COMMON_PRICES: AiModelPriceRequest[] = [
  common('claude-opus-4-1*', 15, 75, 1.5),
  common('claude-sonnet-4-5*', 3, 15, 0.3),
  common('claude-haiku-4-5*', 1, 5, 0.1),
  common('gpt-4.1*', 2, 8, 0.5),
  common('gpt-4.1-mini*', 0.4, 1.6, 0.1),
  common('gpt-4o-mini*', 0.15, 0.6, 0.075),
  common('gemini-2.5-pro*', 1.25, 10, 0.125),
  common('gemini-2.5-flash*', 0.3, 2.5, 0.03),
];

const priceSeed = (index: number, at: When): PriceRecord => ({
  ...COMMON_PRICES[index],
  id: `price-${PROJECT_ID.slice(0, 8)}-${index}`,
  projectId: PROJECT_ID,
  createdAt: at,
  updatedAt: at,
});

// The models support-assistant and Claude Code use are priced; the embedding
// model is left unpriced so the "unpriced models" hint shows.
export const prices = collection<PriceRecord>('aiModelPrices', () => [
  priceSeed(0, ago(10 * DAY)),
  priceSeed(1, ago(10 * DAY)),
  priceSeed(2, ago(10 * DAY)),
  priceSeed(4, ago(9 * DAY)),
]);

const projectPrices = (projectId: string) => prices.find((p) => p.projectId === projectId);

/** Exact name first, else the longest "prefix*" match (the backend's matchPrice). */
function matchPrice(list: PriceRecord[], model: string): PriceRecord | undefined {
  const name = model.toLowerCase();
  let best: PriceRecord | undefined;
  let bestLength = -1;
  for (const price of list) {
    const candidate = price.model.toLowerCase();
    if (candidate === name) return price;
    if (candidate.endsWith('*')) {
      const prefix = candidate.slice(0, -1);
      if (name.startsWith(prefix) && prefix.length > bestLength) {
        best = price;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** Cached tokens are part of the input, billed at the cached price. */
function priceCost(price: PriceRecord, input: number, output: number, cached: number) {
  const cachedPrice = price.cachedInputPerMillion ?? price.inputPerMillion;
  const c = Math.min(cached, input);
  return (
    ((input - c) * price.inputPerMillion + c * cachedPrice + output * price.outputPerMillion) / 1e6
  );
}

function pricer(projectId: string) {
  const list = projectPrices(projectId);
  const cache = new Map<string, PriceRecord | undefined>();
  return (model: string) => {
    if (!cache.has(model)) cache.set(model, matchPrice(list, model));
    return cache.get(model);
  };
}

const toPrice = (p: PriceRecord, seenCalls: number): AiModelPrice => ({
  id: p.id,
  projectId: p.projectId,
  model: p.model,
  inputPerMillion: p.inputPerMillion,
  outputPerMillion: p.outputPerMillion,
  cachedInputPerMillion: p.cachedInputPerMillion,
  seenCalls,
});

function listPrices(projectId: string) {
  requireProject(projectId);
  const list = projectPrices(projectId);
  const now = Date.now();
  const seen = new Map<string, number>();
  for (const s of llmSpansBetween(projectId, now - DAY, now)) {
    if (s.inputTokens + s.outputTokens > 0) seen.set(s.model, (seen.get(s.model) ?? 0) + 1);
  }
  const calls = new Map<string, number>();
  const unpriced: { model: string; calls: number }[] = [];
  for (const [model, count] of seen) {
    const price = matchPrice(list, model);
    if (price) calls.set(price.id, (calls.get(price.id) ?? 0) + count);
    else unpriced.push({ model, calls: count });
  }
  return {
    prices: list
      .map((p) => toPrice(p, calls.get(p.id) ?? 0))
      .sort((a, b) => a.model.localeCompare(b.model)),
    unpricedModels: unpriced.sort((a, b) => b.calls - a.calls),
  };
}

function validatePrice(body: unknown): AiModelPriceRequest {
  const b = (body ?? {}) as Partial<AiModelPriceRequest>;
  const model = (b.model ?? '').trim();
  if (!model) throw new DemoError(400, 'model is required');
  const check = (value: unknown, name: string) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000)
      throw new DemoError(400, `${name} must be between 0 and 100000`);
    return value;
  };
  return {
    model,
    inputPerMillion: check(b.inputPerMillion, 'inputPerMillion'),
    outputPerMillion: check(b.outputPerMillion, 'outputPerMillion'),
    cachedInputPerMillion:
      b.cachedInputPerMillion === null || b.cachedInputPerMillion === undefined
        ? null
        : check(b.cachedInputPerMillion, 'cachedInputPerMillion'),
  };
}

function requirePrice(projectId: string, id: string) {
  const price = prices.get(id);
  if (!price || price.projectId !== projectId) throw new DemoError(404, 'Model price not found');
  return price;
}

// ---------------------------------------------------------------------------
// LLM apps
// ---------------------------------------------------------------------------

const LLM_GROUPS: Record<LlmGroupBy, (s: LlmSpan) => string> = {
  service: (s) => s.service,
  model: (s) => s.model,
  provider: (s) => s.provider,
  operation: (s) => s.operation,
};

type GroupAcc = LlmBreakdownRow & { durations: number[] };

function llmOverview(projectId: string, query: URLSearchParams): LlmOverview {
  requireProject(projectId);
  const { from, to } = rangeOf(query);
  const groupBy = (query.get('groupBy') || 'service') as LlmGroupBy;
  const groupOf = LLM_GROUPS[groupBy];
  if (!groupOf) throw new DemoError(400, 'groupBy must be service, model, provider or operation');
  const bucketSeconds = bucketSecondsOf(query, from, to);
  const bucketMs = bucketSeconds * 1000;
  const spans = llmSpansBetween(projectId, from, to);
  const priceOf = pricer(projectId);

  const durations: number[] = [];
  const services = new Set<string>();
  const unpriced = new Set<string>();
  const series = new Map<string, LlmTimeseriesPoint>();
  const groups = new Map<string, GroupAcc>();
  let input = 0;
  let output = 0;
  let cached = 0;
  let errors = 0;
  let cost = 0;
  let latest = 0;

  for (const s of spans) {
    durations.push(s.durationMs);
    services.add(s.service);
    input += s.inputTokens;
    output += s.outputTokens;
    cached += s.cachedTokens;
    if (s.isError) errors++;
    latest = Math.max(latest, s.timestamp);
    const hasTokens = s.inputTokens + s.outputTokens > 0;
    const price = hasTokens ? priceOf(s.model) : undefined;
    const callCost = price ? priceCost(price, s.inputTokens, s.outputTokens, s.cachedTokens) : 0;
    if (hasTokens && !price) unpriced.add(s.model);
    cost += callCost;

    const bucket = Math.floor(s.timestamp / bucketMs) * bucketMs;
    const id = `${bucket}|${s.model}`;
    let point = series.get(id);
    if (!point) {
      point = { bucket, model: s.model, calls: 0, inputTokens: 0, outputTokens: 0 };
      series.set(id, point);
    }
    point.calls++;
    point.inputTokens += s.inputTokens;
    point.outputTokens += s.outputTokens;

    const key = groupOf(s);
    let row = groups.get(key);
    if (!row) {
      row = {
        key,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        errors: 0,
        p95Ms: 0,
        costUsd: null,
        hasTokens: false,
        unpriced: false,
        durations: [],
      };
      groups.set(key, row);
    }
    row.calls++;
    row.inputTokens += s.inputTokens;
    row.outputTokens += s.outputTokens;
    if (s.isError) row.errors++;
    row.durations.push(s.durationMs);
    if (hasTokens) {
      row.hasTokens = true;
      if (price) row.costUsd = (row.costUsd ?? 0) + callCost;
      else row.unpriced = true;
    }
  }

  return {
    summary: {
      calls: spans.length,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      errors,
      p50Ms: quantile(durations, 0.5),
      p95Ms: quantile(durations, 0.95),
      services: services.size,
      costUsd: cost,
      unpricedModels: [...unpriced].sort(),
    },
    timeseries: [...series.values()].sort(
      (a, b) => a.bucket - b.bucket || a.model.localeCompare(b.model),
    ),
    bucketSeconds,
    groupBy,
    breakdown: [...groups.values()]
      .map(({ durations: d, ...row }) => ({ ...row, p95Ms: quantile(d, 0.95) }))
      .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key))
      .slice(0, 100),
    latestCallAt: latest,
  };
}

function llmCalls(projectId: string, query: URLSearchParams) {
  requireProject(projectId);
  const { from, to } = rangeOf(query);
  const limit = intParam(query, 'limit', 20, 100);
  const spans = llmSpansBetween(projectId, from, to);
  const toCall = (s: LlmSpan, kind: LlmCall['kind']): LlmCall => ({ kind, ...s });
  return {
    slowest: spans
      .filter((s) => !s.isError)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, limit)
      .map((s) => toCall(s, 'slow')),
    failed: spans
      .filter((s) => s.isError)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map((s) => toCall(s, 'failed')),
  };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

type BudgetRecord = Omit<AiBudget, 'createdAt' | 'updatedAt'> & {
  createdAt: When;
  updatedAt: When;
};

type BudgetSeedFields = Omit<
  BudgetRecord,
  'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'channelIds' | 'timeZone'
>;

const budgetSeed = (key: string, at: When, fields: BudgetSeedFields): BudgetRecord => ({
  id: `budget-${key}`,
  projectId: PROJECT_ID,
  timeZone: 'UTC',
  channelIds: [],
  createdAt: at,
  updatedAt: at,
  ...fields,
});

export const budgets = collection<BudgetRecord>('aiBudgets', () => [
  budgetSeed('cc-monthly', ago(11 * DAY), {
    name: 'Claude Code monthly',
    amountUsd: 1200,
    period: 'month',
    scope: 'project',
    scopeValue: '',
    thresholds: [50, 80, 100],
    includeClaudeCode: true,
    includeLlmApps: false,
  }),
  budgetSeed('per-engineer', ago(4 * DAY), {
    name: 'Per engineer weekly',
    amountUsd: 120,
    period: 'week',
    scope: 'each_user',
    scopeValue: '',
    thresholds: [60, 100],
    includeClaudeCode: true,
    includeLlmApps: false,
  }),
  budgetSeed('llm-daily', ago(DAY + 9 * HOUR), {
    name: 'LLM apps daily',
    amountUsd: 25,
    period: 'day',
    scope: 'project',
    scopeValue: '',
    thresholds: [75, 100],
    includeClaudeCode: false,
    includeLlmApps: true,
  }),
  budgetSeed('opus-weekly', ago(9 * DAY), {
    name: 'Opus weekly',
    amountUsd: 400,
    period: 'week',
    scope: 'model',
    scopeValue: OPUS,
    thresholds: [80, 100],
    includeClaudeCode: true,
    includeLlmApps: true,
  }),
]);

const toBudget = (b: BudgetRecord): AiBudget => ({
  ...b,
  createdAt: isoOf(b.createdAt),
  updatedAt: isoOf(b.updatedAt),
});

/** The zone's offset from UTC at t, ms (0 for unknown zones). */
function zoneOffset(timeZone: string, t: number): number {
  if (!timeZone || timeZone === 'UTC') return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const local = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    return local - Math.floor(t / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** The calendar day, ISO week (from Monday) or month containing now, in the zone. */
function periodBounds(period: string, timeZone: string, now: number) {
  const offset = zoneOffset(timeZone, now);
  const local = new Date(now + offset);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  let start: number;
  let end: number;
  if (period === 'week') {
    const back = (local.getUTCDay() + 6) % 7;
    start = Date.UTC(y, m, d - back);
    end = Date.UTC(y, m, d - back + 7);
  } else if (period === 'month') {
    start = Date.UTC(y, m, 1);
    end = Date.UTC(y, m + 1, 1);
  } else {
    start = Date.UTC(y, m, d);
    end = Date.UTC(y, m, d + 1);
  }
  return { start: start - offset, end: end - offset };
}

function forecast(spent: number, start: number, end: number, now: number) {
  if (now >= end) return spent;
  const elapsed = Math.max(now - start, Math.min(HOUR, end - start));
  return (spent * (end - start)) / elapsed;
}

const perGroup = (b: BudgetRecord) => b.scope === 'each_user' || b.scope === 'each_model';

export function budgetStatus(b: BudgetRecord, now = Date.now()): AiBudgetStatus {
  const { start, end } = periodBounds(b.period, b.timeZone, now);
  const byKey = new Map<string, number>();
  const byModel = new Map<string, number>();
  const add = (key: string, model: string, cost: number) => {
    if (cost <= 0) return;
    byKey.set(key, (byKey.get(key) ?? 0) + cost);
    byModel.set(model, (byModel.get(model) ?? 0) + cost);
  };
  const keyFor = (user: string, model: string) =>
    b.scope === 'each_user' ? user : b.scope === 'each_model' ? model : '';
  // LLM app calls carry no user, so they don't count toward per-user budgets.
  const userScoped = b.scope === 'each_user' || b.scope === 'user';

  if (b.includeClaudeCode) {
    for (const e of ccEventsBetween(b.projectId, start, now, now)) {
      if (e.event !== 'api_request') continue;
      const user = e.fields.user_email ?? '';
      const model = e.fields.model ?? '';
      if (b.scope === 'user' && user !== b.scopeValue) continue;
      if (b.scope === 'model' && model !== b.scopeValue) continue;
      add(keyFor(user, model), model, costOf(e));
    }
  }
  if (b.includeLlmApps && !userScoped) {
    const priceOf = pricer(b.projectId);
    for (const s of llmSpansBetween(b.projectId, start, now, now)) {
      if (b.scope === 'model' && s.model !== b.scopeValue) continue;
      const price = s.inputTokens + s.outputTokens > 0 ? priceOf(s.model) : undefined;
      if (!price) continue;
      const cost = priceCost(price, s.inputTokens, s.outputTokens, s.cachedTokens);
      add(keyFor('', s.model), s.model, cost);
    }
  }

  let spent = 0;
  const top: { key: string; spentUsd: number; percent: number }[] = [];
  const group = (key: string, value: number) => ({
    key,
    spentUsd: value,
    percent: (value / b.amountUsd) * 100,
  });
  for (const [key, value] of byKey) {
    spent += value;
    if (perGroup(b)) top.push(group(key, value));
  }
  if (!perGroup(b) && b.scope !== 'model') {
    for (const [model, value] of byModel) top.push(group(model, value));
  }
  top.sort((x, y) => y.spentUsd - x.spentUsd || x.key.localeCompare(y.key));

  let measured = spent;
  let groupsWarning = 0;
  let groupsOver = 0;
  if (perGroup(b)) {
    measured = top[0]?.spentUsd ?? 0;
    const first = b.thresholds[0] ?? 100;
    for (const g of top) {
      if (g.percent >= 100) groupsOver++;
      else if (g.percent >= first) groupsWarning++;
    }
  }
  return {
    budgetId: b.id,
    periodStart: start,
    periodEnd: end,
    spentUsd: spent,
    percent: (measured / b.amountUsd) * 100,
    forecastUsd: forecast(measured, start, end, now),
    groups: perGroup(b) ? top.length : 0,
    groupsWarning,
    groupsOver,
    top: top.slice(0, 5),
  };
}

const BUDGET_SCOPES = ['project', 'each_user', 'each_model', 'user', 'model'];

function validateBudget(body: unknown): AiBudgetRequest {
  const b = (body ?? {}) as Partial<AiBudgetRequest>;
  const name = (b.name ?? '').trim();
  if (!name) throw new DemoError(400, 'name is required');
  if (typeof b.amountUsd !== 'number' || !(b.amountUsd > 0))
    throw new DemoError(400, 'amountUsd must be more than 0');
  if (!['day', 'week', 'month'].includes(b.period ?? ''))
    throw new DemoError(400, 'period must be day, week or month');
  if (!BUDGET_SCOPES.includes(b.scope ?? ''))
    throw new DemoError(400, 'scope must be project, each_user, each_model, user or model');
  const single = b.scope === 'user' || b.scope === 'model';
  if (single && !b.scopeValue?.trim())
    throw new DemoError(400, 'scopeValue is required for a single user or model');
  if (!b.includeClaudeCode && !b.includeLlmApps)
    throw new DemoError(400, 'include Claude Code, LLM apps or both');
  const thresholds = [...(b.thresholds ?? [])].sort((x, y) => x - y);
  if (thresholds.some((t) => typeof t !== 'number' || t <= 0 || t > 1000))
    throw new DemoError(400, 'thresholds are percents between 0 and 1000');
  return {
    name,
    amountUsd: b.amountUsd,
    period: b.period as AiBudgetRequest['period'],
    timeZone: b.timeZone || 'UTC',
    scope: b.scope as AiBudgetRequest['scope'],
    scopeValue: single ? (b.scopeValue ?? '').trim() : '',
    thresholds,
    channelIds: b.channelIds ?? [],
    includeClaudeCode: !!b.includeClaudeCode,
    includeLlmApps: !!b.includeLlmApps,
  };
}

function requireBudget(projectId: string, id: string) {
  const budget = budgets.get(id);
  if (!budget || budget.projectId !== projectId) throw new DemoError(404, 'Budget not found');
  return budget;
}

export function register(r: Router) {
  // --- Claude Code -----------------------------------------------------------
  r.get('/ai-usage/overview/:projectId', (req) => overview(req.params.projectId, req.query));
  r.get('/ai-usage/sessions/:projectId', (req) => sessionsPage(req.params.projectId, req.query));
  r.get('/ai-usage/sessions/:projectId/:sessionId/events', (req) => {
    requireProject(req.params.projectId);
    const found = sessionById(req.params.projectId, req.params.sessionId);
    if (!found) return { events: [], truncated: false };
    const events = found.events.slice(0, MAX_SESSION_EVENTS).map(toEvent);
    return { events, truncated: events.length >= MAX_SESSION_EVENTS };
  });
  r.get('/ai-usage/events/:projectId', (req) => eventsPage(req.params.projectId, req.query));

  // --- LLM apps --------------------------------------------------------------
  r.get('/ai-usage/llm/overview/:projectId', (req) => llmOverview(req.params.projectId, req.query));
  r.get('/ai-usage/llm/calls/:projectId', (req) => llmCalls(req.params.projectId, req.query));

  // --- budgets ---------------------------------------------------------------
  r.get('/projects/:projectId/ai-budgets', (req) => {
    requireProject(req.params.projectId);
    return budgets
      .find((b) => b.projectId === req.params.projectId)
      .map(toBudget)
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  r.get('/projects/:projectId/ai-budgets/status', (req) => {
    requireProject(req.params.projectId);
    const now = Date.now();
    return budgets
      .find((b) => b.projectId === req.params.projectId)
      .map((b) => budgetStatus(b, now));
  });
  r.post('/projects/:projectId/ai-budgets', (req) => {
    const project = requireProject(req.params.projectId);
    const body = validateBudget(req.body);
    const now = Date.now();
    const budget = budgets.insert({
      ...body,
      id: newId(),
      projectId: project.id,
      createdAt: now,
      updatedAt: now,
    });
    recordAudit(`AI budget created: ${budget.name}`, project.id);
    return toBudget(budget);
  });
  r.put('/projects/:projectId/ai-budgets/:budgetId', (req) => {
    requireBudget(req.params.projectId, req.params.budgetId);
    const body = validateBudget(req.body);
    const updated = budgets.update(req.params.budgetId, { ...body, updatedAt: Date.now() });
    recordAudit(`AI budget updated: ${body.name}`, req.params.projectId);
    return toBudget(updated as BudgetRecord);
  });
  r.delete('/projects/:projectId/ai-budgets/:budgetId', (req) => {
    const budget = requireBudget(req.params.projectId, req.params.budgetId);
    budgets.remove(budget.id);
    recordAudit(`AI budget deleted: ${budget.name}`, req.params.projectId);
    return { message: 'Budget deleted' };
  });

  // --- model prices ----------------------------------------------------------
  r.get('/projects/:projectId/ai-model-prices', (req) => listPrices(req.params.projectId));
  r.post('/projects/:projectId/ai-model-prices', (req) => {
    const project = requireProject(req.params.projectId);
    const body = validatePrice(req.body);
    const lower = body.model.toLowerCase();
    if (projectPrices(project.id).some((p) => p.model.toLowerCase() === lower))
      throw new DemoError(409, `A price for ${body.model} already exists`);
    const now = Date.now();
    const price = prices.insert({
      ...body,
      id: newId(),
      projectId: project.id,
      createdAt: now,
      updatedAt: now,
    });
    recordAudit(`AI model price added: ${price.model}`, project.id);
    return toPrice(price, -1);
  });
  r.put('/projects/:projectId/ai-model-prices/:priceId', (req) => {
    requirePrice(req.params.projectId, req.params.priceId);
    const body = validatePrice(req.body);
    const lower = body.model.toLowerCase();
    const clash = projectPrices(req.params.projectId).some(
      (p) => p.id !== req.params.priceId && p.model.toLowerCase() === lower,
    );
    if (clash) throw new DemoError(409, `A price for ${body.model} already exists`);
    const updated = prices.update(req.params.priceId, { ...body, updatedAt: Date.now() });
    recordAudit(`AI model price changed: ${body.model}`, req.params.projectId);
    return toPrice(updated as PriceRecord, -1);
  });
  r.delete('/projects/:projectId/ai-model-prices/:priceId', (req) => {
    const price = requirePrice(req.params.projectId, req.params.priceId);
    prices.remove(price.id);
    recordAudit(`AI model price deleted: ${price.model}`, req.params.projectId);
    return { message: 'Model price deleted' };
  });
  r.post('/projects/:projectId/ai-model-prices/fill-common', (req) => {
    const project = requireProject(req.params.projectId);
    const have = new Set(projectPrices(project.id).map((p) => p.model.toLowerCase()));
    const now = Date.now();
    const added: string[] = [];
    for (const item of COMMON_PRICES) {
      if (have.has(item.model.toLowerCase())) continue;
      prices.insert({
        ...item,
        id: newId(),
        projectId: project.id,
        createdAt: now,
        updatedAt: now,
      });
      added.push(item.model);
    }
    if (added.length)
      recordAudit(
        `AI model prices: added ${added.length} common models (list as of ${COMMON_PRICES_AS_OF})`,
        project.id,
      );
    return { added: added.length, asOf: COMMON_PRICES_AS_OF, models: added };
  });
}
