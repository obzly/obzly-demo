import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AiBudget,
  AiBudgetStatus,
  AiModelPricesResponse,
  AiUsageEventsResponse,
  AiUsageOverview,
  AiUsageSessionEventsResponse,
  AiUsageSessionsResponse,
  FillCommonPricesResponse,
  LlmCallsResponse,
  LlmOverview,
} from '../../entity/aiUsage';
import { ccEventsBetween, llmSpansBetween } from '../gen/aiUsage';
import { DAY } from '../seed/people';
import { resetDemo } from '../store';
import { PROJECT_ID, STAGING_PROJECT_ID } from '../world';
import { call, routerWith } from './admin.testkit';
import { register } from './aiUsage';

const router = routerWith(register);
const range = (ms: number) => {
  const to = new Date();
  return `from=${new Date(to.getTime() - ms).toISOString()}&to=${to.toISOString()}`;
};

describe('demo AI observability', () => {
  beforeEach(() => resetDemo());

  it('generates the same Claude Code events on every call', () => {
    const now = Date.now();
    const a = ccEventsBetween(PROJECT_ID, now - 2 * DAY, now, now);
    const b = ccEventsBetween(PROJECT_ID, now - 2 * DAY, now, now);
    expect(a.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
    expect(ccEventsBetween(STAGING_PROJECT_ID, now - DAY, now, now)).toEqual([]);
  });

  it('summarizes 14 days of Claude Code usage', async () => {
    const o = await call<AiUsageOverview>(
      router,
      'GET',
      `/ai-usage/overview/${PROJECT_ID}?${range(14 * DAY)}&groupBy=user`,
    );
    expect(o.summary.users).toBe(5);
    expect(o.summary.sessions).toBeGreaterThan(60);
    expect(o.summary.requests).toBeGreaterThan(1000);
    // Roughly $40-150 a day for five engineers.
    expect(o.summary.costUsd / 14).toBeGreaterThan(30);
    expect(o.summary.costUsd / 14).toBeLessThan(200);
    expect(o.bucketSeconds).toBe(21600);
    expect(o.filterOptions.models).toContain('claude-opus-4-1-20250805');
    expect(o.filterOptions.terminals.length).toBeGreaterThan(2);
    expect(o.tools[0].tool).toBe('Read');
    expect(o.timeseries.every((p) => p.key.endsWith('@harborline.example.com'))).toBe(true);
    expect(o.users[0].costUsd).toBeGreaterThanOrEqual(o.users[1].costUsd);
    expect(o.latestEventAt).toBeGreaterThan(Date.now() - 4 * DAY);
  });

  it('filters by user and pages sessions and their events', async () => {
    const user = 'marcus.webb@harborline.example.com';
    const page = await call<AiUsageSessionsResponse>(
      router,
      'GET',
      `/ai-usage/sessions/${PROJECT_ID}?${range(14 * DAY)}&user=${encodeURIComponent(user)}&sortBy=cost&limit=5&offset=0`,
    );
    expect(page.sessions).toHaveLength(5);
    expect(page.total).toBeGreaterThan(5);
    expect(page.sessions.every((s) => s.user === user)).toBe(true);
    expect(page.sessions[0].costUsd).toBeGreaterThanOrEqual(page.sessions[1].costUsd);

    const session = page.sessions[0];
    const events = await call<AiUsageSessionEventsResponse>(
      router,
      'GET',
      `/ai-usage/sessions/${PROJECT_ID}/${session.sessionId}/events?${range(14 * DAY)}`,
    );
    expect(events.events[0].event).toBe('mcp_server_connection');
    expect(events.events.filter((e) => e.event === 'user_prompt')).toHaveLength(session.prompts);

    const list = await call<AiUsageEventsResponse>(
      router,
      'GET',
      `/ai-usage/events/${PROJECT_ID}?${range(DAY * 3)}&event=tool_result&limit=10&offset=0`,
    );
    expect(list.events.every((e) => e.event === 'tool_result')).toBe(true);
    expect(list.eventTypes).toContain('api_request');
    expect(list.events[0].timestamp).toBeGreaterThanOrEqual(list.events[1].timestamp);
  });

  it('shows the onboarding state for a project without AI data', async () => {
    const o = await call<AiUsageOverview>(
      router,
      'GET',
      `/ai-usage/overview/${STAGING_PROJECT_ID}?${range(DAY)}`,
    );
    expect(o.filterOptions.users).toEqual([]);
    expect(o.latestEventAt).toBe(0);
  });

  it('reports LLM calls with cost for priced models only', async () => {
    const o = await call<LlmOverview>(
      router,
      'GET',
      `/ai-usage/llm/overview/${PROJECT_ID}?${range(DAY)}&groupBy=model`,
    );
    expect(o.summary.calls).toBeGreaterThan(500);
    expect(o.summary.services).toBe(2);
    expect(o.summary.unpricedModels).toEqual(['text-embedding-3-small']);
    expect(o.summary.costUsd).toBeGreaterThan(1);
    const embed = o.breakdown.find((row) => row.key === 'text-embedding-3-small');
    expect(embed?.costUsd).toBeNull();
    expect(embed?.unpriced).toBe(true);

    const calls = await call<LlmCallsResponse>(
      router,
      'GET',
      `/ai-usage/llm/calls/${PROJECT_ID}?${range(DAY)}&limit=5`,
    );
    expect(calls.slowest).toHaveLength(5);
    expect(calls.failed.length).toBeGreaterThan(0);
    expect(calls.failed.every((c) => c.isError && c.kind === 'failed')).toBe(true);
    expect(calls.slowest[0].serverAddress).toBe('llm-gateway.harborline.example.com');
  });

  it('prices: lists unpriced models, fills common ones, recomputes cost', async () => {
    const before = await call<AiModelPricesResponse>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/ai-model-prices`,
    );
    expect(before.prices).toHaveLength(4);
    expect(before.unpricedModels[0].model).toBe('text-embedding-3-small');
    const filled = await call<FillCommonPricesResponse>(
      router,
      'POST',
      `/projects/${PROJECT_ID}/ai-model-prices/fill-common`,
    );
    expect(filled.added).toBe(4);
    await call(router, 'POST', `/projects/${PROJECT_ID}/ai-model-prices`, {
      model: 'text-embedding-3-small',
      inputPerMillion: 0.02,
      outputPerMillion: 0,
      cachedInputPerMillion: null,
    });
    const after = await call<AiModelPricesResponse>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/ai-model-prices`,
    );
    expect(after.unpricedModels).toEqual([]);
    expect(after.prices.find((p) => p.model === 'gpt-4.1-mini*')?.seenCalls).toBeGreaterThan(0);
    // The longest prefix wins: gpt-4.1-mini* over gpt-4.1*.
    expect(after.prices.find((p) => p.model === 'gpt-4.1*')?.seenCalls).toBe(0);
  });

  it('budgets: seeded statuses and create/update/delete', async () => {
    const statuses = await call<AiBudgetStatus[]>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/ai-budgets/status`,
    );
    expect(statuses).toHaveLength(4);
    const perEngineer = statuses.find((s) => s.budgetId === 'budget-per-engineer');
    expect(perEngineer?.groups).toBeGreaterThan(0);
    for (const s of statuses) {
      expect(s.periodEnd).toBeGreaterThan(s.periodStart);
      expect(s.spentUsd).toBeGreaterThanOrEqual(0);
    }

    const created = await call<AiBudget>(router, 'POST', `/projects/${PROJECT_ID}/ai-budgets`, {
      name: 'Haiku daily',
      amountUsd: 5,
      period: 'day',
      timeZone: 'Europe/Berlin',
      scope: 'each_model',
      scopeValue: '',
      thresholds: [100, 50],
      channelIds: [],
      includeClaudeCode: true,
      includeLlmApps: true,
    });
    expect(created.thresholds).toEqual([50, 100]);
    await call(router, 'PUT', `/projects/${PROJECT_ID}/ai-budgets/${created.id}`, {
      ...created,
      amountUsd: 8,
    });
    const list = await call<AiBudget[]>(router, 'GET', `/projects/${PROJECT_ID}/ai-budgets`);
    expect(list.find((b) => b.id === created.id)?.amountUsd).toBe(8);
    await call(router, 'DELETE', `/projects/${PROJECT_ID}/ai-budgets/${created.id}`);
    const again = await call<AiBudget[]>(router, 'GET', `/projects/${PROJECT_ID}/ai-budgets`);
    expect(again).toHaveLength(4);
  });

  it('keeps LLM spans inside the demo window', () => {
    const now = Date.now();
    const spans = llmSpansBetween(PROJECT_ID, now - 20 * DAY, now, now);
    expect(spans[0].timestamp).toBeGreaterThanOrEqual(now - 14 * DAY);
    expect(spans[spans.length - 1].timestamp).toBeLessThanOrEqual(now);
  });
});
