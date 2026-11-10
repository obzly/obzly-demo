// Cloud cost: the Cost tab (overview, explorer, facets, budgets, anomalies, recommendations,
// commitments, planner) and the asset drawer's cost, answered from ../seed/cost the way a Site
// answers from its cost tables: amounts are never added across currencies, and a period nobody
// delivered is "none", never zero. Obzly never buys or changes anything, here or for real.
import type {
  AdviceSection,
  Commitment,
  CommitmentCoverage,
  CommitmentType,
  CostAlertSettings,
  CostAnomaly,
  CostBudget,
  CostBudgetRequest,
  CostFilters,
  CostRecommendation,
  CostSummary,
  CurrencyBlock,
  ExploreRequest,
  ExploreResponse,
  ExploreRow,
  FacetValue,
  Granularity,
  Plan,
  PurchaseOption,
  RecommendationUpdate,
  ResourceCostResponse,
} from '../../entity/cost';
import { DemoError, type DemoRequest, type Router } from '../router';
import { recordAudit } from '../seed/audit';
import {
  AWS_CONNECTION_NAME,
  AZURE_CONNECTION_NAME,
  type CostLine,
  DAY,
  GP2_VOLUME,
  SPIKE_DAYS_AGO,
  UNATTACHED_VOLUME,
  UNUSED_EIP,
  costLines,
  costRows,
  dayKey,
  sourceSpans,
  today,
} from '../seed/cost';
import {
  AWS_ACCOUNT,
  AWS_CONNECTION_ID,
  AZURE_CONNECTION_ID,
  AZURE_REGION,
  AZURE_SUBSCRIPTION,
  cloudResources,
  instanceId,
} from '../seed/inventory';
import { collection, newId, value } from '../store';
import { BATCH_HOST, DEMO_USER, PROJECT_ID, REGION, STAGING_PROJECT_ID } from '../world';

const DAYS_PER_MONTH = 30.4375;
const MAX_DAILY_SPAN = 92;
const MAX_ROWS = 500;

const bad = (message: string): never => {
  throw new DemoError(400, message);
};
const notFound = (what: string): never => {
  throw new DemoError(404, `${what} not found`);
};
const body = <T>(req: DemoRequest) => (req.body ?? {}) as T;
const round2 = (n: number) => Math.round(n * 100) / 100;

function parseDay(text: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text ?? '')) bad(`"${text}" isn't a day like 2026-11-01`);
  return Date.parse(`${text}T00:00:00Z`);
}

/** The projects asked for: one, or both the demo user can read. */
function projectsOf(projectId: string | null | undefined): string[] {
  if (!projectId) return [PROJECT_ID, STAGING_PROJECT_ID];
  if (projectId !== PROJECT_ID && projectId !== STAGING_PROJECT_ID) {
    throw new DemoError(403, "you can't see this project's cost");
  }
  return [projectId];
}

// --- dimensions and filters ----------------------------------------------------------

function valueOf(line: CostLine, dimension: string): string {
  switch (dimension) {
    case 'provider':
      return line.provider;
    case 'account':
      return line.account;
    case 'region':
      return line.region;
    case 'service':
      return line.service;
    case 'resource':
      return line.resource;
    case 'charge':
      return line.charge;
  }
  if (dimension.startsWith('tag:')) return line.tags[dimension.slice(4)] ?? '';
  return bad(`can't group by "${dimension}"`);
}

const ACCOUNT_NAMES: Record<string, string> = {
  [AWS_ACCOUNT]: 'Harborline production',
  [AZURE_SUBSCRIPTION]: 'Analytics subscription',
};

function passes(line: CostLine, filters: CostFilters, skip?: string): boolean {
  const lists: [string, string[] | undefined][] = [
    ['provider', filters.provider],
    ['account', filters.account],
    ['region', filters.region],
    ['service', filters.service],
    ['resource', filters.resource],
    ['charge', filters.charge],
    ...Object.entries(filters.tags ?? {}).map(([key, values]): [string, string[]] => [
      `tag:${key}`,
      values,
    ]),
  ];
  return lists.every(
    ([dimension, values]) =>
      dimension === skip || !values?.length || values.includes(valueOf(line, dimension)),
  );
}

// --- periods --------------------------------------------------------------------------

interface Period {
  key: string;
  from: number;
  to: number;
}

function periodKey(t: number, granularity: Granularity): string {
  const d = new Date(t);
  switch (granularity) {
    case 'daily':
      return dayKey(t);
    case 'monthly':
      return dayKey(t).slice(0, 7);
    case 'quarterly':
      return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  }
  return String(d.getUTCFullYear());
}

function periods(from: number, to: number, granularity: Granularity): Period[] {
  const out: Period[] = [];
  for (let start = from; start <= to;) {
    const d = new Date(start);
    let next: number;
    if (granularity === 'daily') next = start + DAY;
    else if (granularity === 'monthly') next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    else if (granularity === 'quarterly') {
      next = Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + 3, 1);
    } else next = Date.UTC(d.getUTCFullYear() + 1, 0, 1);
    out.push({
      key: periodKey(start, granularity),
      from: start,
      to: Math.min(next - DAY, to),
    });
    start = next;
  }
  return out;
}

/** full, partial or none: the share of (connection, day) pairs some source delivered. */
function coverage(period: Period, filters: CostFilters, resourceLevel: boolean) {
  const spans = sourceSpans().filter(
    (s) =>
      (!filters.provider?.length || filters.provider.includes(s.provider)) &&
      (!resourceLevel || s.source === 'export'),
  );
  if (!spans.length) return '' as const;
  const days = Math.round((period.to - period.from) / DAY) + 1;
  let covered = 0;
  for (const span of spans) {
    const from = Math.max(period.from, Date.parse(`${span.from}T00:00:00Z`));
    const to = Math.min(period.to, Date.parse(`${span.to}T00:00:00Z`));
    if (to >= from) covered += Math.round((to - from) / DAY) + 1;
  }
  if (covered === 0) return 'none' as const;
  return covered < days * spans.length ? ('partial' as const) : ('full' as const);
}

function rangeOf(request: { from: string; to: string }) {
  const from = parseDay(request.from);
  const to = parseDay(request.to);
  if (to < from) bad('to is before from');
  return { from, to };
}

function rowsFor(
  projects: string[],
  from: number,
  to: number,
  filters: CostFilters,
  skip?: string,
) {
  const resourceLevel = skip !== 'resource' && !!filters.resource?.length;
  return costRows(
    from,
    to,
    (line) =>
      projects.includes(line.projectId) &&
      passes(line, filters, skip) &&
      (!resourceLevel || line.source === 'export'),
  );
}

// --- summary and explorer ---------------------------------------------------------------

function summary(projects: string[], now = Date.now()): CostSummary {
  const todayStart = today(now);
  const d = new Date(todayStart);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const lastStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  const sameDays = Math.min(lastStart + (d.getUTCDate() - 1) * DAY, monthStart - DAY);
  const dailyFrom = todayStart - 89 * DAY;
  const byCurrency = new Map<string, CostSummary['currencies'][number]>();
  const daily = new Map<string, Map<string, { amount: number; estimated: boolean }>>();
  for (const row of costRows(Math.min(lastStart, dailyFrom), todayStart, (l) =>
    projects.includes(l.projectId),
  )) {
    const currency = row.line.currency;
    let s = byCurrency.get(currency);
    if (!s) {
      s = {
        currency,
        monthToDate: 0,
        lastMonth: 0,
        lastMonthSameDays: 0,
        daily: [],
      };
      byCurrency.set(currency, s);
      daily.set(currency, new Map());
    }
    const t = Date.parse(`${row.day}T00:00:00Z`);
    if (t >= monthStart) s.monthToDate += row.effective;
    else if (t >= lastStart) {
      s.lastMonth += row.effective;
      if (t <= sameDays) s.lastMonthSameDays += row.effective;
    }
    if (t >= dailyFrom) {
      const days = daily.get(currency)!;
      const point = days.get(row.day) ?? { amount: 0, estimated: false };
      point.amount += row.effective;
      point.estimated ||= row.estimated;
      days.set(row.day, point);
    }
  }
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  const currencies = [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  for (const s of currencies) {
    const days = daily.get(s.currency)!;
    s.daily = [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, p]) => ({
        day,
        amount: round2(p.amount),
        estimated: p.estimated || undefined,
      }));
    // The provider's forecast for the rest of the month: the last full week's average a day.
    const week = s.daily.slice(-8, -1);
    const perDay = week.reduce((sum, p) => sum + p.amount, 0) / Math.max(1, week.length);
    s.forecast = round2(s.monthToDate + perDay * ((monthEnd - todayStart) / DAY + 0.55));
    s.monthToDate = round2(s.monthToDate);
    s.lastMonth = round2(s.lastMonth);
    s.lastMonthSameDays = round2(s.lastMonthSameDays);
  }
  const sources = sourceSpans(now)
    .filter((s) => projects.includes(s.projectId))
    .map((s) => ({
      projectId: s.projectId,
      connectionId: s.connectionId,
      connectionName: s.connectionName,
      provider: s.provider,
      source: s.source,
      from: s.source === 'export' ? dayKey(monthStart) : dayKey(todayStart - 4 * DAY),
      to: s.to,
      finalThrough: s.finalThrough,
      coveredFrom: s.from,
      coveredTo: s.to,
      rows: costLines().filter((l) => l.connectionId === s.connectionId).length * 30,
      deliveredAt: s.deliveredAt,
      forecastAt: s.deliveredAt,
    }));
  return {
    today: dayKey(todayStart),
    currencies,
    sources,
    openAnomalies: anomalyList(projects, now).filter((a) => a.status === 'open').length,
  };
}

function explore(projects: string[], request: ExploreRequest): ExploreResponse {
  const { from, to } = rangeOf(request);
  const granularity = request.granularity;
  if (!['daily', 'monthly', 'quarterly', 'yearly'].includes(granularity)) {
    bad('granularity must be daily, monthly, quarterly or yearly');
  }
  if (granularity === 'daily' && (to - from) / DAY >= MAX_DAILY_SPAN) {
    bad(`daily periods are for ranges of up to ${MAX_DAILY_SPAN} days`);
  }
  const metric = request.metric === 'billed' ? 'billed' : 'effective';
  const filters = request.filters ?? {};
  const resourceLevel = request.groupBy === 'resource' || !!filters.resource?.length;
  const columns = periods(from, to, granularity);
  const index = new Map(columns.map((p, i) => [p.key, i]));
  const blocks = new Map<string, Map<string, ExploreRow>>();
  const rows = costRows(
    from,
    to,
    (line) =>
      projects.includes(line.projectId) &&
      passes(line, filters) &&
      (!resourceLevel || line.source === 'export'),
  );
  for (const row of rows) {
    const i = index.get(periodKey(Date.parse(`${row.day}T00:00:00Z`), granularity));
    if (i === undefined) continue;
    const groups = blocks.get(row.line.currency) ?? new Map<string, ExploreRow>();
    blocks.set(row.line.currency, groups);
    const key = valueOf(row.line, request.groupBy);
    const group = groups.get(key) ?? {
      key,
      values: columns.map(() => 0),
      total: 0,
    };
    groups.set(key, group);
    group.values[i] += row[metric];
    group.total += row[metric];
  }
  const currencies: CurrencyBlock[] = [...blocks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, groups]) => {
      const list = [...groups.values()]
        .map((row) => ({
          ...row,
          label: request.groupBy === 'account' ? ACCOUNT_NAMES[row.key] : undefined,
          values: row.values.map(round2),
          total: round2(row.total),
        }))
        .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
      const totals = columns.map((_, i) =>
        round2(list.reduce((sum, row) => sum + row.values[i], 0)),
      );
      const block: CurrencyBlock = {
        currency,
        rows: list.slice(0, MAX_ROWS),
        totals,
        total: round2(list.reduce((sum, row) => sum + row.total, 0)),
      };
      if (list.length > MAX_ROWS) {
        const rest = list.slice(MAX_ROWS);
        block.other = {
          key: '',
          label: `${rest.length} more`,
          values: columns.map((_, i) => round2(rest.reduce((sum, row) => sum + row.values[i], 0))),
          total: round2(rest.reduce((sum, row) => sum + row.total, 0)),
        };
      }
      return block;
    });
  return {
    periods: columns.map((p) => ({
      key: p.key,
      from: dayKey(p.from),
      to: dayKey(p.to),
      coverage: coverage(p, filters, resourceLevel),
    })),
    currencies,
  };
}

function facets(projects: string[], request: ExploreRequest) {
  const { from, to } = rangeOf(request);
  const filters = request.filters ?? {};
  const tagKeys = [...new Set(costLines().flatMap((line) => Object.keys(line.tags)))].sort();
  const dimensions = [
    'provider',
    'account',
    'region',
    'service',
    'resource',
    'charge',
    ...tagKeys.map((k) => `tag:${k}`),
  ];
  const out: Record<string, FacetValue[]> = {};
  for (const dimension of dimensions) {
    const sums = new Map<string, Record<string, number>>();
    for (const row of rowsFor(projects, from, to, filters, dimension)) {
      const key = valueOf(row.line, dimension);
      if (dimension === 'resource' && (!key || row.line.source !== 'export')) continue;
      const amounts = sums.get(key) ?? {};
      amounts[row.line.currency] = (amounts[row.line.currency] ?? 0) + row.effective;
      sums.set(key, amounts);
    }
    out[dimension] = [...sums.entries()]
      .map(([key, amounts]) => ({
        value: key,
        label: dimension === 'account' ? ACCOUNT_NAMES[key] : undefined,
        amounts: Object.fromEntries(Object.entries(amounts).map(([c, a]) => [c, round2(a)])),
      }))
      .sort(
        (a, b) =>
          Math.max(...Object.values(b.amounts)) - Math.max(...Object.values(a.amounts)) ||
          a.value.localeCompare(b.value),
      );
  }
  return { dimensions: out };
}

/** Billing names an EC2 instance by its ID, a bucket by its name, an Azure resource lowercased. */
function resourceKeys(key: string): string[] {
  const keys = [key.trim()];
  if (key.startsWith('/subscriptions/')) return [key.toLowerCase()];
  const instance = /:instance\/(i-[0-9a-f]+)$/.exec(key);
  if (instance) keys.push(instance[1]);
  if (key.startsWith('arn:aws:s3:::')) keys.push(key.slice('arn:aws:s3:::'.length));
  return keys;
}

function resourceCost(projects: string[], key: string, days: number): ResourceCostResponse {
  const keys = resourceKeys(key);
  const todayStart = today();
  const from = todayStart - (Math.min(Math.max(days, 1), 366) - 1) * DAY;
  const byCurrency = new Map<string, ResourceCostResponse['currencies'][number]>();
  for (const row of costRows(
    from,
    todayStart,
    (line) =>
      projects.includes(line.projectId) && line.source === 'export' && keys.includes(line.resource),
  )) {
    const cost = byCurrency.get(row.line.currency) ?? {
      currency: row.line.currency,
      days: [],
      total: 0,
      byCharge: {},
    };
    byCurrency.set(row.line.currency, cost);
    const point = cost.days.find((p) => p.day === row.day);
    if (point) {
      point.amount = round2(point.amount + row.effective);
      point.estimated ||= row.estimated;
    } else
      cost.days.push({
        day: row.day,
        amount: row.effective,
        estimated: row.estimated || undefined,
      });
    cost.total = round2(cost.total + row.effective);
    cost.byCharge[row.line.charge] = round2((cost.byCharge[row.line.charge] ?? 0) + row.effective);
  }
  // Only an export of the resource's own cloud can have it: the Azure data comes from the API.
  const covered = !key.startsWith('/subscriptions/');
  return { keys, currencies: [...byCurrency.values()], covered };
}

// --- anomalies --------------------------------------------------------------------------

const anomalyStates = collection<{
  id: string;
  status: 'open' | 'acknowledged';
  note: string;
}>('cost.anomalies', () => []);

function anomalyList(projects: string[], now = Date.now()): CostAnomaly[] {
  if (!projects.includes(PROJECT_ID)) return [];
  const todayStart = today(now);
  const day = todayStart - SPIKE_DAYS_AGO * DAY;
  const service = 'Amazon Elastic Compute Cloud';
  const total = (t: number) =>
    costRows(
      t,
      t,
      (l) => l.connectionId === AWS_CONNECTION_ID && l.service === service,
      now,
    ).reduce((sum, row) => sum + row.effective, 0);
  const before = [1, 2, 3, 4, 5, 6, 7, 8]
    .map((w) => total(day - w * 7 * DAY))
    .sort((a, b) => a - b);
  const expected = round2((before[3] + before[4]) / 2);
  const actual = round2(total(day));
  const id = `anomaly-${dayKey(day)}-ec2`;
  const state = anomalyStates.get(id);
  return [
    {
      id,
      projectId: PROJECT_ID,
      connectionId: AWS_CONNECTION_ID,
      connectionName: AWS_CONNECTION_NAME,
      day: dayKey(day),
      subAccount: AWS_ACCOUNT,
      subAccountName: 'Harborline production',
      service,
      currency: 'USD',
      expected,
      actual,
      score: round2((actual - expected) / Math.max(1, expected * 0.08)),
      status: state?.status ?? 'open',
      note: state?.note ?? '',
      detectedAt: new Date(day + DAY + 6 * 3_600_000).toISOString(),
    },
  ];
}

// --- budgets and alert settings ----------------------------------------------------------

interface StoredBudget extends CostBudgetRequest {
  id: string;
  projectId: string;
}

const budgets = collection<StoredBudget>('cost.budgets', () => [
  {
    id: 'b6d1c2a3-5e4f-4a7b-8c9d-0e1f2a3b4c5d',
    projectId: PROJECT_ID,
    name: 'Production AWS',
    filters: { provider: ['aws'] },
    currency: 'USD',
    amount: 1500,
    thresholdPercent: 90,
    channelIds: [],
  },
  {
    id: 'c7e2d3b4-6f5a-4b8c-9d0e-1f2a3b4c5d6e',
    projectId: PROJECT_ID,
    name: 'Shop team',
    filters: { tags: { team: ['shop'] } },
    currency: 'USD',
    amount: 900,
    thresholdPercent: 80,
    channelIds: [],
  },
  {
    id: 'd8f3e4c5-7a6b-4c9d-8e1f-2a3b4c5d6e7f',
    projectId: STAGING_PROJECT_ID,
    name: 'Analytics',
    filters: { provider: ['azure'] },
    currency: 'EUR',
    amount: 700,
    thresholdPercent: 90,
    channelIds: [],
  },
]);

function budgetStatus(budget: StoredBudget, now = Date.now()): CostBudget {
  const todayStart = today(now);
  const d = new Date(todayStart);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  const sum = (from: number, to: number) =>
    rowsFor([budget.projectId], from, to, budget.filters)
      .filter((row) => row.line.currency === budget.currency)
      .reduce((s, row) => s + row.effective, 0);
  const spent = sum(monthStart, todayStart);
  const week = sum(todayStart - 7 * DAY, todayStart - DAY) / 7;
  const projected = spent + week * ((monthEnd - todayStart) / DAY + 0.55);
  const percent = round2((projected / budget.amount) * 100);
  const filtered = Object.values(budget.filters).some((v) =>
    Array.isArray(v) ? v.length : v && Object.keys(v).length,
  );
  return {
    ...budget,
    spent: round2(spent),
    projected: round2(projected),
    percent,
    status: percent >= 100 ? 'over' : percent >= budget.thresholdPercent ? 'near' : 'ok',
    method: filtered ? 'run-rate' : 'forecast',
  };
}

function budgetFrom(request: CostBudgetRequest): CostBudgetRequest {
  const name = (request.name ?? '').trim();
  if (!name || name.length > 100) bad('name must be 1 to 100 characters');
  if (!/^[A-Z]{3}$/.test(request.currency ?? '')) bad('currency is a 3-letter code like USD');
  if (!(request.amount > 0)) bad('the amount must be more than 0');
  const threshold = request.thresholdPercent || 90;
  if (threshold < 1 || threshold > 200) bad('alert at 1% to 200%');
  return {
    name,
    filters: request.filters ?? {},
    currency: request.currency,
    amount: request.amount,
    thresholdPercent: threshold,
    channelIds: request.channelIds ?? [],
  };
}

const costAlerts = value<Record<string, CostAlertSettings>>('cost.alerts', () => ({}));

// --- recommendations ----------------------------------------------------------------------

const ec2Arn = (host: string) =>
  `arn:aws:ec2:${REGION}:${AWS_ACCOUNT}:instance/${instanceId(host)}`;
const rdsArn = (name: string) => cloudResources().find((r) => r.name === name)?.id ?? '';
const VM_ID = cloudResources().find((r) => r.name === 'analytics-jump-01')?.id ?? '';

type SeedRec = Omit<CostRecommendation, 'projectId' | 'status' | 'connectionName' | 'provider'> & {
  provider?: string;
  /** Savings worked out from the resource's own cost: this share of it. */
  share?: number;
};

function recommendationSeed(): SeedRec[] {
  const refreshed = new Date(today() - 2 * DAY + 5 * 3_600_000).toISOString();
  return [
    {
      key: `co:ec2:${ec2Arn(BATCH_HOST)}`,
      connectionId: AWS_CONNECTION_ID,
      source: 'compute_optimizer',
      kind: 'rightsizing',
      account: AWS_ACCOUNT,
      region: REGION,
      resourceKey: ec2Arn(BATCH_HOST),
      resourceName: 'batch-01',
      resourceType: 'aws_ec2_instance',
      action: 'Change t3.large to t3.medium',
      current: 't3.large',
      target: 't3.medium',
      currency: 'USD',
      monthlySavings: 30.37,
      savingsBasis: 'provider',
      effort: 'low',
      risk: 'low',
      evidence: {
        finding: 'Overprovisioned',
        reasons: 'CPUOverprovisioned, MemoryOverprovisioned',
        cpu_maximum: '31.2',
        look_back_days: '14',
        agent_cpu_p95: '11.8',
        agent_memory_p95: '34.6',
      },
      refreshedAt: refreshed,
    },
    {
      key: `co:idle:${rdsArn('legacy-orders-mysql')}`,
      connectionId: AWS_CONNECTION_ID,
      source: 'compute_optimizer',
      kind: 'idle',
      account: AWS_ACCOUNT,
      region: REGION,
      resourceKey: rdsArn('legacy-orders-mysql'),
      resourceName: 'legacy-orders-mysql',
      resourceType: 'aws_rds_instance',
      action: 'Delete the idle RDS instance (take a final snapshot first)',
      currency: 'USD',
      monthlySavings: 36.52,
      savingsBasis: 'provider',
      effort: 'low',
      risk: 'low',
      evidence: {
        finding: 'Idle',
        description: 'Stopped for 61 days; storage and backups are still billed.',
        look_back_days: '14',
      },
      refreshedAt: refreshed,
    },
    {
      key: `co:ebs:${GP2_VOLUME}`,
      connectionId: AWS_CONNECTION_ID,
      source: 'compute_optimizer',
      kind: 'modernize',
      account: AWS_ACCOUNT,
      region: REGION,
      resourceKey: GP2_VOLUME,
      resourceName: 'batch-scratch',
      resourceType: 'aws_ebs_volume',
      action: 'Change gp2 500 GiB to gp3 500 GiB',
      current: 'gp2 500 GiB',
      target: 'gp3 500 GiB',
      currency: 'USD',
      monthlySavings: 10,
      savingsBasis: 'provider',
      effort: 'low',
      risk: 'low',
      evidence: { finding: 'NotOptimized', look_back_days: '14' },
      refreshedAt: refreshed,
    },
    {
      key: `obzly:ebs-unattached:${UNATTACHED_VOLUME}`,
      connectionId: AWS_CONNECTION_ID,
      source: 'obzly',
      kind: 'idle',
      account: AWS_ACCOUNT,
      region: REGION,
      resourceKey: UNATTACHED_VOLUME,
      resourceName: 'old-reports-export',
      resourceType: 'aws_ebs_volume',
      action: 'Delete the unattached EBS volume (snapshot it first if you need the data)',
      currency: 'USD',
      monthlySavings: null,
      savingsBasis: 'resource_cost',
      share: 1,
      effort: 'low',
      risk: 'low',
      evidence: {
        volume_type: 'gp2',
        size_gib: '200',
        state: 'available',
        created: '2025-06-18T09:12:00Z',
      },
      refreshedAt: refreshed,
    },
    {
      key: `obzly:eip:${UNUSED_EIP}`,
      connectionId: AWS_CONNECTION_ID,
      source: 'obzly',
      kind: 'idle',
      account: AWS_ACCOUNT,
      region: REGION,
      resourceKey: UNUSED_EIP,
      resourceName: '198.51.100.24',
      resourceType: 'aws_elastic_ip',
      action: 'Release the unused Elastic IP',
      currency: 'USD',
      monthlySavings: 3.65,
      savingsBasis: 'list_price',
      effort: 'low',
      risk: 'low',
      evidence: {
        public_ip: '198.51.100.24',
        associated: 'false',
        price: 'public IPv4: $0.005 an hour',
      },
      refreshedAt: refreshed,
    },
    {
      key: `advisor:/subscriptions/${AZURE_SUBSCRIPTION}/providers/microsoft.advisor/recommendations/4c1e`,
      connectionId: AZURE_CONNECTION_ID,
      provider: 'azure',
      source: 'advisor',
      kind: 'rightsizing',
      account: AZURE_SUBSCRIPTION,
      region: AZURE_REGION,
      resourceKey: VM_ID,
      resourceName: 'analytics-jump-01',
      resourceType: 'azure_virtual_machine',
      action: 'Change Standard_B2s to Standard_B1ms',
      current: 'Standard_B2s',
      target: 'Standard_B1ms',
      currency: 'EUR',
      monthlySavings: 17.4,
      savingsBasis: 'provider',
      effort: 'medium',
      risk: 'low',
      evidence: {
        problem: 'Right-size or shutdown underutilized virtual machines',
        MaxCpuP95: '7',
        MaxMemoryP95: '29',
      },
      refreshedAt: refreshed,
    },
  ];
}

interface StoredRecState {
  id: string;
  status: CostRecommendation['status'];
  owner?: string;
  dueDate?: string;
  reason?: string;
  doneAt?: string;
  doneBy?: string;
  expectedMonthly?: number | null;
  realizedMonthly?: number | null;
  measuredAt?: string;
  action?: string;
  resourceKey?: string;
  resourceName?: string;
  currency?: string;
  projectId?: string;
}

const recStates = collection<StoredRecState>('cost.recommendations', () => [
  {
    // Done six weeks ago and measured: the change saved a little more than expected.
    id: `co:idle:arn:aws:ec2:${REGION}:${AWS_ACCOUNT}:instance/i-0e2f4a6c8b1d3f507`,
    status: 'done',
    doneAt: new Date(today() - 44 * DAY).toISOString(),
    doneBy: 'detected',
    expectedMonthly: 48.0,
    realizedMonthly: 52.1,
    measuredAt: new Date(today() - 28 * DAY).toISOString(),
    action: 'Stop or delete the idle EC2 instance',
    resourceKey: `arn:aws:ec2:${REGION}:${AWS_ACCOUNT}:instance/i-0e2f4a6c8b1d3f507`,
    resourceName: 'load-test-runner',
    currency: 'USD',
    projectId: PROJECT_ID,
  },
]);

/** A resource's effective cost over the last 30 days, per month; null without export data. */
function resourceMonthly(key: string): number | null {
  const todayStart = today();
  const rows = costRows(
    todayStart - 30 * DAY,
    todayStart,
    (l) => l.source === 'export' && resourceKeys(key).includes(l.resource),
  );
  if (!rows.length) return null;
  const days = new Set(rows.map((r) => r.day)).size;
  return round2((rows.reduce((s, r) => s + r.effective, 0) * DAYS_PER_MONTH) / days);
}

function recommendations(projects: string[]): CostRecommendation[] {
  const out: CostRecommendation[] = [];
  for (const seed of recommendationSeed()) {
    const projectId = seed.connectionId === AZURE_CONNECTION_ID ? STAGING_PROJECT_ID : PROJECT_ID;
    if (!projects.includes(projectId)) continue;
    const { share, provider, ...rest } = seed;
    const state = recStates.get(seed.key);
    const saving = share ? resourceMonthly(seed.resourceKey) : rest.monthlySavings;
    out.push({
      ...rest,
      monthlySavings: saving === null ? null : round2(saving * (share ?? 1)),
      projectId,
      provider: provider ?? 'aws',
      connectionName: projectId === PROJECT_ID ? AWS_CONNECTION_NAME : AZURE_CONNECTION_NAME,
      status: state?.status ?? 'open',
      owner: state?.owner,
      dueDate: state?.dueDate,
      reason: state?.reason,
      doneAt: state?.doneAt,
      doneBy: state?.doneBy,
      expectedMonthly: state?.expectedMonthly,
      realizedMonthly: state?.realizedMonthly,
      measuredAt: state?.measuredAt,
    });
  }
  const listed = new Set(out.map((r) => r.key));
  for (const state of recStates.all()) {
    if (
      listed.has(state.id) ||
      state.status !== 'done' ||
      !projects.includes(state.projectId ?? '')
    )
      continue;
    out.push({
      key: state.id,
      projectId: state.projectId ?? PROJECT_ID,
      connectionName: AWS_CONNECTION_NAME,
      provider: 'aws',
      source: 'compute_optimizer',
      kind: 'idle',
      account: AWS_ACCOUNT,
      region: REGION,
      resourceKey: state.resourceKey ?? '',
      resourceName: state.resourceName ?? '',
      resourceType: 'aws_ec2_instance',
      action: state.action ?? '',
      currency: state.currency ?? 'USD',
      monthlySavings: null,
      savingsBasis: '',
      effort: 'low',
      risk: 'low',
      evidence: {},
      status: 'done',
      doneAt: state.doneAt,
      doneBy: state.doneBy,
      expectedMonthly: state.expectedMonthly,
      realizedMonthly: state.realizedMonthly,
      measuredAt: state.measuredAt,
    });
  }
  return out.sort((a, b) => (b.monthlySavings ?? 0) - (a.monthlySavings ?? 0));
}

function updateRecommendation(update: RecommendationUpdate): CostRecommendation {
  if (!['open', 'planned', 'done', 'dismissed'].includes(update.status)) {
    bad('status must be open, planned, done or dismissed');
  }
  if (update.status === 'dismissed' && !(update.reason ?? '').trim()) bad("say why it's dismissed");
  if (update.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(update.dueDate))
    bad(`"${update.dueDate}" isn't a day`);
  projectsOf(update.projectId);
  const current =
    recommendations([update.projectId]).find((r) => r.key === update.key) ??
    notFound('Recommendation');
  const done = update.status === 'done';
  const state: StoredRecState = {
    id: update.key,
    status: update.status,
    owner: update.status === 'planned' ? (update.owner ?? '').trim() : undefined,
    dueDate: update.status === 'planned' ? update.dueDate : undefined,
    reason: update.status === 'dismissed' ? update.reason?.trim() : undefined,
    doneAt: done
      ? current.status === 'done'
        ? current.doneAt
        : new Date().toISOString()
      : undefined,
    doneBy: done ? (current.status === 'done' ? current.doneBy : DEMO_USER.email) : undefined,
    expectedMonthly: current.monthlySavings,
    realizedMonthly: done ? current.realizedMonthly : undefined,
    measuredAt: done ? current.measuredAt : undefined,
    action: current.action,
    resourceKey: current.resourceKey,
    resourceName: current.resourceName,
    currency: current.currency,
    projectId: update.projectId,
  };
  if (recStates.get(update.key)) recStates.update(update.key, state);
  else recStates.insert(state);
  const verb = {
    open: 'Reopened',
    planned: 'Planned',
    done: 'Marked done',
    dismissed: 'Dismissed',
  }[update.status];
  recordAudit(
    `${verb} cost recommendation "${current.action}" on ${current.resourceKey}`,
    update.projectId,
  );
  return recommendations([update.projectId]).find((r) => r.key === update.key)!;
}

// --- sections, commitments, planner --------------------------------------------------------

function sections(projects: string[]): AdviceSection[] {
  const refreshedAt = new Date(today() - 2 * DAY + 5 * 3_600_000).toISOString();
  const all: AdviceSection[] = [
    ...(['rightsizing', 'checks', 'commitments', 'planner'] as const).map((section) => ({
      projectId: PROJECT_ID,
      connectionId: AWS_CONNECTION_ID,
      connectionName: AWS_CONNECTION_NAME,
      section,
      state: 'ok' as const,
      refreshedAt,
    })),
    {
      projectId: STAGING_PROJECT_ID,
      connectionId: AZURE_CONNECTION_ID,
      connectionName: AZURE_CONNECTION_NAME,
      section: 'rightsizing',
      state: 'ok',
      refreshedAt,
    },
    {
      projectId: STAGING_PROJECT_ID,
      connectionId: AZURE_CONNECTION_ID,
      connectionName: AZURE_CONNECTION_NAME,
      section: 'checks',
      state: 'ok',
      refreshedAt,
    },
    {
      projectId: STAGING_PROJECT_ID,
      connectionId: AZURE_CONNECTION_ID,
      connectionName: AZURE_CONNECTION_NAME,
      section: 'commitments',
      state: 'needs_permission',
      reason: 'Reservations Reader (assigned at /providers/Microsoft.Capacity)',
      refreshedAt,
    },
    {
      projectId: STAGING_PROJECT_ID,
      connectionId: AZURE_CONNECTION_ID,
      connectionName: AZURE_CONNECTION_NAME,
      section: 'planner',
      state: 'ok',
      refreshedAt,
    },
  ];
  return all.filter((s) => projects.includes(s.projectId));
}

function commitments(projects: string[]) {
  if (!projects.includes(PROJECT_ID)) return { commitments: [], coverage: [] };
  const todayStart = today();
  const endsIn = (days: number) => new Date(todayStart + days * DAY).toISOString();
  const base = {
    projectId: PROJECT_ID,
    connectionId: AWS_CONNECTION_ID,
    connectionName: AWS_CONNECTION_NAME,
    provider: 'aws',
    account: AWS_ACCOUNT,
  };
  const list: Commitment[] = [
    {
      ...base,
      id: `arn:aws:savingsplans::${AWS_ACCOUNT}:savingsplan/7e1a9c2b-3d4f-4a5b-9c6d-0e1f2a3b4c5d`,
      type: 'compute_sp',
      description: 'Compute Savings Plan, 0.28 USD an hour',
      term: '1y',
      payment: 'no_upfront',
      startsAt: endsIn(-324),
      endsAt: endsIn(41),
      endsInDays: 41,
      currency: 'USD',
      monthlyCost: 204.4,
      utilization: 99.1,
      unusedMonthly: 1.84,
      unused: false,
      endingSoon: true,
    },
    {
      ...base,
      id: 'ri-harborline-reporting-0001',
      type: 'rds_ri',
      region: REGION,
      description: 'RDS reservation: 1 × db.r6g.large',
      term: '1y',
      payment: 'all_upfront',
      startsAt: endsIn(-160),
      endsAt: endsIn(205),
      endsInDays: 205,
      currency: 'USD',
      monthlyCost: 129.5,
      utilization: 100,
      unusedMonthly: 0,
      unused: false,
      endingSoon: false,
    },
    {
      ...base,
      id: 'ri-legacy-orders-0001',
      type: 'rds_ri',
      region: REGION,
      description: 'RDS reservation: 1 × db.t3.medium',
      term: '1y',
      payment: 'partial_upfront',
      startsAt: endsIn(-240),
      endsAt: endsIn(125),
      endsInDays: 125,
      currency: 'USD',
      monthlyCost: 31.2,
      utilization: 0,
      unusedMonthly: 31.2,
      unused: true,
      endingSoon: false,
    },
  ];
  const coverage: CommitmentCoverage[] = [
    {
      connectionId: AWS_CONNECTION_ID,
      connectionName: AWS_CONNECTION_NAME,
      type: 'compute_sp',
      currency: 'USD',
      coveredPercent: 36,
      onDemandMonthly: 412.6,
    },
    {
      connectionId: AWS_CONNECTION_ID,
      connectionName: AWS_CONNECTION_NAME,
      type: 'rds_ri',
      currency: 'USD',
      coveredPercent: 84,
      onDemandMonthly: 36.5,
    },
  ];
  return { commitments: list, coverage };
}

/** Discounts by term and payment, roughly what the providers' calculators show. */
const DISCOUNTS: Record<
  string,
  {
    pays: PurchaseOption['payment'][];
    d: Record<'1y' | '3y', (number | null)[]>;
  }
> = {
  compute_sp: {
    pays: ['no_upfront', 'partial_upfront', 'all_upfront'],
    d: { '1y': [0.27, 0.3, 0.32], '3y': [0.46, 0.5, 0.52] },
  },
  ec2_instance_sp: {
    pays: ['no_upfront', 'partial_upfront', 'all_upfront'],
    d: { '1y': [0.33, 0.36, 0.38], '3y': [0.54, 0.57, 0.6] },
  },
  rds_ri: {
    pays: ['no_upfront', 'partial_upfront', 'all_upfront'],
    d: { '1y': [0.31, 0.34, 0.36], '3y': [null, 0.52, 0.55] },
  },
  azure_sp: {
    pays: ['monthly', 'upfront'],
    d: { '1y': [0.17, 0.17], '3y': [0.35, 0.35] },
  },
  azure_reservation: {
    pays: ['monthly', 'upfront'],
    d: { '1y': [0.36, 0.36], '3y': [0.58, 0.58] },
  },
};

const TYPE_SERVICES: Record<string, (l: CostLine) => boolean> = {
  compute_sp: (l) =>
    ['Amazon Elastic Compute Cloud', 'AWS Lambda'].includes(l.service) &&
    !!l.resource &&
    !l.resource.includes(':volume/') &&
    !l.resource.includes('elastic-ip'),
  ec2_instance_sp: (l) =>
    l.service === 'Amazon Elastic Compute Cloud' && l.resource.startsWith('i-'),
  rds_ri: (l) => l.service === 'Amazon Relational Database Service',
  azure_sp: (l) => l.service === 'Virtual Machines' || l.service === 'Azure Kubernetes Service',
  azure_reservation: (l) => l.service === 'Virtual Machines',
};

const RIGHTSIZED_TYPES: Record<string, string[]> = {
  compute_sp: ['aws_ec2_instance'],
  ec2_instance_sp: ['aws_ec2_instance'],
  rds_ri: ['aws_rds_instance'],
  azure_sp: ['azure_virtual_machine'],
  azure_reservation: ['azure_virtual_machine'],
};

function planner(projects: string[], lookback: number, rightsizingFirst: boolean) {
  if (![7, 30, 60].includes(lookback)) bad('lookbackDays must be 7, 30 or 60');
  const todayStart = today();
  const recs = recommendations(projects).filter(
    (r) =>
      (r.status === 'open' || r.status === 'planned') &&
      (r.kind === 'rightsizing' || r.kind === 'idle'),
  );
  const plans: Plan[] = [];
  for (const [kind, discount] of Object.entries(DISCOUNTS)) {
    const azure = kind.startsWith('azure');
    const projectId = azure ? STAGING_PROJECT_ID : PROJECT_ID;
    if (!projects.includes(projectId)) continue;
    const currency = azure ? 'EUR' : 'USD';
    const rows = costRows(
      todayStart - lookback * DAY,
      todayStart - DAY,
      (l) => l.projectId === projectId && TYPE_SERVICES[kind](l),
    );
    const byDay = new Map<string, { day: string; onDemand: number; committed: number }>();
    for (const row of rows) {
      const point = byDay.get(row.day) ?? {
        day: row.day,
        onDemand: 0,
        committed: 0,
      };
      if (row.line.pricing === 'Committed') point.committed += row.effective;
      else point.onDemand += row.effective;
      byDay.set(row.day, point);
    }
    const usage = [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((p) => ({
        ...p,
        onDemand: round2(p.onDemand),
        committed: round2(p.committed),
      }));
    const onDemandDaily = usage.reduce((s, p) => s + p.onDemand, 0) / Math.max(1, usage.length);
    const onDemandMonthly = round2(onDemandDaily * DAYS_PER_MONTH);
    if (onDemandMonthly <= 0) continue;
    const rightsizing = round2(
      recs
        .filter((r) => r.currency === currency && RIGHTSIZED_TYPES[kind].includes(r.resourceType))
        .reduce((s, r) => s + (r.monthlySavings ?? 0), 0),
    );
    const factor =
      rightsizingFirst && rightsizing > 0
        ? Math.max(0, Math.min(1, 1 - rightsizing / onDemandMonthly))
        : 1;
    // The steady part of the usage the provider recommends committing to.
    const steady = onDemandMonthly * 0.82 * (lookback === 7 ? 1.03 : lookback === 60 ? 0.97 : 1);
    const options: PurchaseOption[] = [];
    for (const term of ['1y', '3y'] as const) {
      discount.pays.forEach((payment, i) => {
        const d = discount.d[term][i];
        if (d === null) {
          options.push({
            term,
            payment,
            offered: false,
            reason: "AWS doesn't sell 3-year RDS reservations without upfront",
            hourlyCommitment: 0,
            upfront: 0,
            monthlyRecurring: 0,
            monthlySavings: 0,
            savingsPercent: 0,
            breakEvenMonths: 0,
            averageUtilization: 0,
            coveragePercent: 0,
            lines: [],
            labels: [],
          });
          return;
        }
        const months = term === '1y' ? 12 : 36;
        const monthlyCost = steady * (1 - d);
        const share = azure ? (payment === 'upfront' ? 1 : 0) : [0, 0.5, 1][i];
        const upfront = monthlyCost * months * share;
        const savings = (steady * d - steady * 0.015) * factor;
        const hourly = (monthlyCost / 730) * factor;
        const commitment =
          kind === 'rds_ri'
            ? '1 × db.r6g.large in eu-west-1'
            : kind === 'azure_reservation'
              ? '1 × Standard_D4s_v5 in westeurope'
              : `${hourly.toFixed(hourly < 1 ? 4 : 2)} an hour`;
        options.push({
          term,
          payment,
          offered: true,
          commitment,
          hourlyCommitment:
            kind === 'rds_ri' || kind === 'azure_reservation' ? 0 : round2(hourly * 10000) / 10000,
          upfront: round2(upfront * factor),
          monthlyRecurring: round2(monthlyCost * (1 - share) * factor),
          monthlySavings: round2(savings),
          savingsPercent: round2(d * 100 - 1.5),
          breakEvenMonths: upfront ? round2(upfront / (savings / factor + upfront / months)) : 0,
          averageUtilization: 97.5,
          coveragePercent: azure && kind === 'azure_sp' ? 82 : 0,
          lines: [
            {
              description:
                kind === 'rds_ri'
                  ? '1 × db.r6g.large'
                  : kind === 'azure_reservation'
                    ? '1 × Standard_D4s_v5'
                    : kind === 'ec2_instance_sp'
                      ? 'm6i family'
                      : TYPE_LABEL[kind],
              account: azure ? AZURE_SUBSCRIPTION : AWS_ACCOUNT,
              region:
                kind === 'compute_sp' || kind === 'azure_sp'
                  ? undefined
                  : azure
                    ? AZURE_REGION
                    : REGION,
              quantity: commitment,
              monthlySavings: round2(savings),
              upfront: round2(upfront * factor),
            },
          ],
          labels: [],
        });
      });
    }
    const priced = options.filter((o) => o.offered && o.monthlySavings > 0);
    const risk = (o: PurchaseOption) =>
      (o.term === '3y' ? 10 : 0) +
      ({
        no_upfront: 0,
        monthly: 0,
        partial_upfront: 1,
        all_upfront: 2,
        upfront: 2,
      }[o.payment] ?? 0);
    const lowest = [...priced].sort((a, b) => risk(a) - risk(b))[0];
    const most = [...priced].sort((a, b) => b.monthlySavings - a.monthlySavings)[0];
    lowest?.labels.push('lowest_risk');
    most?.labels.push('most_savings');
    plans.push({
      connectionId: azure ? AZURE_CONNECTION_ID : AWS_CONNECTION_ID,
      connectionName: azure ? AZURE_CONNECTION_NAME : AWS_CONNECTION_NAME,
      provider: azure ? 'azure' : 'aws',
      type: kind as CommitmentType,
      lookbackDays: lookback,
      currency,
      onDemandMonthly,
      rightsizingMonthly: rightsizing,
      factor: round2(factor * 10000) / 10000,
      refreshedAt: new Date(todayStart - 2 * DAY + 5 * 3_600_000).toISOString(),
      options,
      usage,
    });
  }
  return { plans, sections: sections(projects) };
}

const TYPE_LABEL: Record<string, string> = {
  compute_sp: 'Compute Savings Plan',
  ec2_instance_sp: 'EC2 Instance Savings Plan',
};

// --- routes -----------------------------------------------------------------------------

export function register(r: Router) {
  r.get('/cloud-cost/summary', (req) => summary(projectsOf(req.query.get('projectId'))));
  r.post('/cloud-cost/explore', (req) => {
    const request = body<ExploreRequest>(req);
    return explore(projectsOf(request.projectId), request);
  });
  r.post('/cloud-cost/facets', (req) => {
    const request = body<ExploreRequest>(req);
    return facets(projectsOf(request.projectId), request);
  });
  r.get('/cloud-cost/resource', (req) =>
    resourceCost(
      projectsOf(req.query.get('projectId')),
      req.query.get('key') || bad('key is required'),
      Number(req.query.get('days') || 30),
    ),
  );
  r.get('/cloud-cost/anomalies', (req) => {
    const from = req.query.get('from');
    const to = req.query.get('to');
    const status = req.query.get('status');
    return anomalyList(projectsOf(req.query.get('projectId'))).filter(
      (a) => (!from || a.day >= from) && (!to || a.day <= to) && (!status || a.status === status),
    );
  });
  r.patch('/cloud-cost/anomalies/:id', (req) => {
    const { status, note } = body<{
      status: 'open' | 'acknowledged';
      note: string;
    }>(req);
    if (status !== 'open' && status !== 'acknowledged') bad('status must be open or acknowledged');
    const anomaly =
      anomalyList([PROJECT_ID]).find((a) => a.id === req.params.id) ?? notFound('Anomaly');
    const state = { id: anomaly.id, status, note: (note ?? '').slice(0, 1000) };
    if (anomalyStates.get(anomaly.id)) anomalyStates.update(anomaly.id, state);
    else anomalyStates.insert(state);
    return { ...anomaly, ...state };
  });
  r.get('/projects/:id/cost-budgets', (req) => {
    projectsOf(req.params.id);
    return budgets
      .find((b) => b.projectId === req.params.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => budgetStatus(b));
  });
  r.post('/projects/:id/cost-budgets', (req) => {
    projectsOf(req.params.id);
    const stored = budgets.insert({
      id: newId(),
      projectId: req.params.id,
      ...budgetFrom(body(req)),
    });
    return budgetStatus(stored);
  });
  r.put('/projects/:id/cost-budgets/:budgetId', (req) => {
    const existing = budgets.get(req.params.budgetId);
    if (!existing || existing.projectId !== req.params.id) notFound('Budget');
    return budgetStatus(budgets.update(req.params.budgetId, budgetFrom(body(req)))!);
  });
  r.delete('/projects/:id/cost-budgets/:budgetId', (req) => {
    const existing = budgets.get(req.params.budgetId);
    if (!existing || existing.projectId !== req.params.id) notFound('Budget');
    budgets.remove(req.params.budgetId);
    return {};
  });
  r.get(
    '/projects/:id/cost-alerts',
    (req) => costAlerts.get()[req.params.id] ?? { anomalyChannelIds: [] },
  );
  r.put('/projects/:id/cost-alerts', (req) => {
    projectsOf(req.params.id);
    const settings = {
      anomalyChannelIds: body<CostAlertSettings>(req).anomalyChannelIds ?? [],
    };
    costAlerts.set({ ...costAlerts.get(), [req.params.id]: settings });
    return settings;
  });
  r.get('/cloud-cost/recommendations', (req) => {
    const projects = projectsOf(req.query.get('projectId'));
    return { items: recommendations(projects), sections: sections(projects) };
  });
  r.patch('/cloud-cost/recommendations', (req) =>
    updateRecommendation(body<RecommendationUpdate>(req)),
  );
  r.get('/cloud-cost/resource-recommendations', (req) => {
    const keys = resourceKeys(req.query.get('key') || bad('key is required'));
    return recommendations(projectsOf(req.query.get('projectId'))).filter(
      (r) =>
        (r.status === 'open' || r.status === 'planned') &&
        resourceKeys(r.resourceKey).some((k) => keys.includes(k)),
    );
  });
  r.get('/cloud-cost/commitments', (req) => {
    const projects = projectsOf(req.query.get('projectId'));
    return { ...commitments(projects), sections: sections(projects) };
  });
  r.get('/cloud-cost/planner', (req) =>
    planner(
      projectsOf(req.query.get('projectId')),
      Number(req.query.get('lookbackDays') || 30),
      req.query.get('rightsizingFirst') !== 'false',
    ),
  );
}
