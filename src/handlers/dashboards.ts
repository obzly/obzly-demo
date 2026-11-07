// Dashboards: CRUD, pins, folders, panel queries (logs, spans and metrics
// panels, one-shot and streamed), the auto-generated Overview and Grafana /
// OpenObserve import. Saved dashboards live in the demo store.
import type {
  AggregationBucket,
  CreateDashboardRequest,
  Dashboard,
  Folder,
  ImportDashboardRequest,
  Panel,
  PanelQueryRequest,
  Tab,
  UpdateDashboardRequest,
  Variable,
} from '../../entity/dashboards';
// The model file directly: the entity's index pulls in the API client (and window).
import { effectivePanelSource } from '../../entity/dashboards/model/PanelSource';
import { allMetrics } from '../gen/metricRegistry';
import { aggregateSpanPanel } from '../gen/traces';
import { ndjson, sleep } from '../lib/http';
import { evaluatePromQL } from '../query/promql';
import { DemoError, type Router } from '../router';
import { seedDashboards, seedFolders } from '../seed/dashboards';
import { collection, newId } from '../store';
import { DEMO_USER_ID } from '../world';
import { requireProject } from './bootstrap';
import { importDashboard } from './dashboardImport';
import { aggregateLogPanel } from './logs';

const HOUR = 3_600_000;

export const dashboards = collection<Dashboard>('dashboards', seedDashboards);
export const folders = collection<Folder>('dashboardFolders', seedFolders);

// --- validation (mirrors the backend's normalizeTabs / normalizeVariables) ------

const MAX_PANELS_PER_TAB = 100;
const MAX_TABS = 50;
const MAX_PANELS = 500;
const MAX_VARIABLES = 50;
const MAX_TEXT_BYTES = 64 << 10;
const PANEL_TYPES = new Set(['line', 'bar', 'pie', 'stat', 'table']);
const SOURCES = new Set(['logs', 'spans', 'metrics']);
const UNITS = new Set(['bytes', 'percent']);
export const SPAN_METRICS = new Set([
  'count',
  'error_count',
  'avg_duration_ms',
  'p50_duration_ms',
  'p95_duration_ms',
  'p99_duration_ms',
]);
export const SPAN_GROUPS = new Set(['service_name', 'name', 'status_code', 'kind']);
const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_SOURCES = new Set(['static', 'metricLabel', 'services']);

const bad = (message: string): never => {
  throw new DemoError(400, message);
};

function validTitle(title: unknown): string {
  if (typeof title !== 'string' || title.length < 1 || title.length > 255) {
    return bad('Invalid request format');
  }
  return title;
}

function normalizePanels(panels: Panel[] | undefined): Panel[] {
  const list = panels ?? [];
  if (list.length > MAX_PANELS_PER_TAB) {
    bad(`a tab cannot have more than ${MAX_PANELS_PER_TAB} panels`);
  }
  return list.map((panel) => {
    if (!PANEL_TYPES.has(panel.type)) bad(`invalid panel type "${panel.type}"`);
    if (panel.source && !SOURCES.has(panel.source)) bad(`invalid panel source "${panel.source}"`);
    if (panel.unit && !UNITS.has(panel.unit)) bad(`invalid panel unit "${panel.unit}"`);
    if ((panel.promQuery?.length ?? 0) > MAX_TEXT_BYTES) {
      bad(`a panel query can't be longer than ${MAX_TEXT_BYTES} bytes`);
    }
    if (effectivePanelSource(panel) === 'spans') {
      if (panel.groupField && !SPAN_GROUPS.has(panel.groupField)) {
        bad(`invalid panel group field "${panel.groupField}" for a spans panel`);
      }
      if (panel.metric && !SPAN_METRICS.has(panel.metric)) {
        bad(`invalid panel metric "${panel.metric}"`);
      }
    }
    return { ...panel, id: panel.id || newId() };
  });
}

export function normalizeTabs(tabs: Tab[] | undefined): Tab[] {
  if (!tabs?.length) return [{ id: newId(), title: 'Default', panels: [] }];
  if (tabs.length > MAX_TABS) bad(`a dashboard cannot have more than ${MAX_TABS} tabs`);
  let total = 0;
  const normalized = tabs.map((tab) => {
    let panels: Panel[];
    try {
      panels = normalizePanels(tab.panels);
    } catch (error) {
      if (error instanceof DemoError) return bad(`tab "${tab.title}": ${error.message}`);
      throw error;
    }
    total += panels.length;
    return { id: tab.id || newId(), title: tab.title || 'Untitled tab', panels };
  });
  if (total > MAX_PANELS) bad(`a dashboard cannot have more than ${MAX_PANELS} panels in total`);
  return normalized;
}

export function normalizeVariables(variables: Variable[] | undefined): Variable[] {
  const list = variables ?? [];
  if (list.length > MAX_VARIABLES) {
    bad(`a dashboard cannot have more than ${MAX_VARIABLES} variables`);
  }
  const seen = new Set<string>();
  for (const variable of list) {
    if (!VARIABLE_KEY.test(variable.key ?? '')) {
      bad(
        `invalid variable key "${variable.key}" - must start with a letter or underscore and contain only letters, digits, underscores`,
      );
    }
    if (seen.has(variable.key)) bad(`duplicate variable key "${variable.key}"`);
    seen.add(variable.key);
    if (!VARIABLE_SOURCES.has(variable.source)) bad(`invalid variable source "${variable.source}"`);
    if (variable.source === 'metricLabel' && !variable.metricLabelName?.trim()) {
      bad(`variable "${variable.key}": metricLabelName is required for source metricLabel`);
    }
    if (variable.source === 'static' && !variable.staticValues?.length) {
      bad(`variable "${variable.key}": staticValues is required for source static`);
    }
  }
  return list;
}

function checkDescription(description: string | undefined) {
  if ((description?.length ?? 0) > MAX_TEXT_BYTES) {
    bad(`the description can't be longer than ${MAX_TEXT_BYTES} bytes`);
  }
}

function ownedDashboard(projectId: string, id: string): Dashboard {
  const dashboard = dashboards.get(id);
  if (!dashboard || dashboard.projectId !== projectId) {
    throw new DemoError(404, 'dashboard not found');
  }
  return dashboard;
}

function ownedFolder(projectId: string, id: string): Folder {
  const folder = folders.get(id);
  if (!folder || folder.projectId !== projectId) {
    throw new DemoError(404, 'dashboard folder not found');
  }
  return folder;
}

/** The backend's order: pinned first, then the auto-generated one, then oldest first. */
function listOrder(a: Dashboard, b: Dashboard): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  if (a.isAutoGenerated !== b.isAutoGenerated) return a.isAutoGenerated ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

const now = () => new Date().toISOString();

// --- panel queries ------------------------------------------------------------------

export type Range = { from?: string; to?: string } | undefined;

/** A compact legend ("code=200, service=api") without __name__, like the backend. */
export function metricSeriesLabel(labels: Record<string, string>): string | undefined {
  const keys = Object.keys(labels)
    .filter((key) => key !== '__name__')
    .sort();
  if (!keys.length) return labels.__name__ || undefined;
  return keys.map((key) => `${key}=${labels[key]}`).join(', ');
}

/** A metrics panel: its PromQL as a range query, each series one group. */
export function metricPanelBuckets(
  projectId: string,
  panel: Panel,
  range: Range,
): AggregationBucket[] {
  const query = panel.promQuery?.trim();
  if (!query) return [];
  const end = range?.to ? Date.parse(range.to) : Date.now();
  const start = range?.from ? Date.parse(range.from) : end - HOUR;
  if (!Number.isFinite(start) || !Number.isFinite(end)) bad('Invalid time range');
  // bucketMs, or about 120 points across the range; never under a second.
  const stepMs =
    panel.bucketMs && panel.bucketMs > 0
      ? Math.max(1000, panel.bucketMs)
      : Math.max(1000, (end - start) / 120);
  const response = evaluatePromQL(projectId, {
    query,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    stepSeconds: Math.max(1, Math.round(stepMs / 1000)),
  });
  const buckets: AggregationBucket[] = [];
  for (const series of response.series ?? []) {
    const groupKey = metricSeriesLabel(series.labels ?? {});
    for (const point of series.points ?? []) {
      if (!Number.isFinite(point.value)) continue;
      const bucket: AggregationBucket = { timestamp: point.timestamp, value: point.value };
      if (groupKey) bucket.groupKey = groupKey;
      buckets.push(bucket);
    }
  }
  if (!buckets.length && typeof response.scalar === 'number') {
    buckets.push({ timestamp: new Date(end).toISOString(), value: response.scalar });
  }
  return buckets;
}

/** Logs and spans panels need a closed range, as on the server; metrics default to an hour. */
function requireClosedRange(panel: Panel, range: Range) {
  if (effectivePanelSource(panel) === 'metrics') return;
  if (!range?.from || !range.to) return bad('timeRange.from and timeRange.to are required');
  if (Date.parse(range.from) > Date.parse(range.to)) {
    bad('timeRange.from must be before timeRange.to');
  }
}

/** One panel's buckets, whatever its source (alert previews use this too). */
export function runPanel(projectId: string, panel: Panel, range: Range): AggregationBucket[] {
  switch (effectivePanelSource(panel)) {
    case 'spans':
      if (panel.metric && !SPAN_METRICS.has(panel.metric)) {
        bad(`invalid panel metric "${panel.metric}"`);
      }
      if (panel.groupField && !SPAN_GROUPS.has(panel.groupField)) {
        bad(`invalid panel group field "${panel.groupField}"`);
      }
      return aggregateSpanPanel(projectId, { ...panel, metric: panel.metric || 'count' }, range);
    case 'metrics':
      return metricPanelBuckets(projectId, panel, range);
    default:
      return aggregateLogPanel(projectId, panel, range);
  }
}

function panelRequest(body: unknown): PanelQueryRequest {
  const request = (body ?? {}) as PanelQueryRequest;
  if (!request.panel || typeof request.panel !== 'object') bad('Invalid request format');
  return request;
}

// --- Overview -----------------------------------------------------------------------

const OVERVIEW_TITLE = 'Overview';
const OVERVIEW_DESCRIPTION =
  "Auto-generated from your project's log data. Regenerate any time " +
  "to pick up fields you've started sending since — or edit it like any other dashboard.";

const LEGACY_METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const promSelector = (name: string) =>
  LEGACY_METRIC_NAME.test(name) ? name : `{"__name__"=${JSON.stringify(name)}}`;

function overviewPanels(projectId: string): Panel[] {
  const errors = {
    type: 'condition' as const,
    condition: { field: 'level', operator: 'in' as const, value: ['error', 'fatal'] },
  };
  const panels: Panel[] = [
    { id: newId(), title: 'Log volume', type: 'line', gridPos: { x: 0, y: 0, w: 12, h: 8 } },
    {
      id: newId(),
      title: 'Errors over time',
      type: 'line',
      query: errors,
      gridPos: { x: 0, y: 8, w: 6, h: 8 },
    },
    {
      id: newId(),
      title: 'Level breakdown',
      type: 'pie',
      groupField: 'level',
      limit: 10,
      gridPos: { x: 6, y: 8, w: 6, h: 8 },
    },
    {
      id: newId(),
      title: 'Top error messages',
      type: 'table',
      query: errors,
      groupField: 'message',
      limit: 10,
      gridPos: { x: 0, y: 16, w: 12, h: 8 },
    },
    // Span panels: the demo project always has traces.
    {
      id: newId(),
      title: 'Requests by service',
      type: 'bar',
      source: 'spans',
      rootSpansOnly: true,
      groupField: 'service_name',
      metric: 'count',
      limit: 10,
      gridPos: { x: 0, y: 24, w: 4, h: 8 },
    },
    {
      id: newId(),
      title: 'p95 latency by service (ms)',
      type: 'bar',
      source: 'spans',
      groupField: 'service_name',
      metric: 'p95_duration_ms',
      limit: 10,
      gridPos: { x: 4, y: 24, w: 4, h: 8 },
    },
    {
      id: newId(),
      title: 'Errors by service',
      type: 'bar',
      source: 'spans',
      groupField: 'service_name',
      metric: 'error_count',
      limit: 10,
      gridPos: { x: 8, y: 24, w: 4, h: 8 },
    },
  ];
  // Like the backend: the first six metric names (no _bucket series), counters as rate().
  let metrics: { name: string; type: string }[];
  try {
    metrics = allMetrics(projectId);
  } catch {
    metrics = [];
  }
  const names = [...new Map(metrics.map((m) => [m.name, m])).values()]
    .filter((m) => !m.name.endsWith('_bucket'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 6);
  names.forEach((metric, i) => {
    const selector = promSelector(metric.name);
    const counter = metric.type === 'counter';
    panels.push({
      id: newId(),
      title: `${metric.name} (${counter ? 'rate' : 'avg'})`,
      type: 'line',
      source: 'metrics',
      promQuery: counter ? `sum(rate(${selector}[5m]))` : `avg(${selector})`,
      gridPos: { x: (i % 2) * 6, y: 32 + Math.floor(i / 2) * 8, w: 6, h: 8 },
    });
  });
  return panels;
}

/** Builds, or replaces in place (keeping the tab id), the project's Overview. */
export function generateOverview(projectId: string): Dashboard {
  const panels = overviewPanels(projectId);
  const existing = dashboards.find((d) => d.projectId === projectId && d.isAutoGenerated)[0];
  if (existing) {
    const tabId = existing.tabs[0]?.id ?? newId();
    return dashboards.update(existing.id, {
      title: OVERVIEW_TITLE,
      description: OVERVIEW_DESCRIPTION,
      tabs: [{ id: tabId, title: 'Overview', panels }],
      updatedAt: now(),
    })!;
  }
  const at = now();
  return dashboards.insert({
    id: newId(),
    projectId,
    title: OVERVIEW_TITLE,
    description: OVERVIEW_DESCRIPTION,
    tabs: [{ id: newId(), title: 'Overview', panels }],
    variables: [],
    isAutoGenerated: true,
    isPinned: false,
    createdBy: DEMO_USER_ID,
    createdAt: at,
    updatedAt: at,
  });
}

// --- routes ---------------------------------------------------------------------------

export function register(r: Router) {
  const base = '/projects/dashboards/:pid';

  r.get(base, (req) => {
    requireProject(req.params.pid);
    return {
      dashboards: dashboards.find((d) => d.projectId === req.params.pid).sort(listOrder),
    };
  });

  r.post(base, (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as CreateDashboardRequest;
    const title = validTitle(body.title);
    checkDescription(body.description);
    const at = now();
    return dashboards.insert({
      id: newId(),
      projectId: req.params.pid,
      title,
      description: body.description ?? '',
      tabs: normalizeTabs(body.tabs),
      variables: normalizeVariables(body.variables),
      isAutoGenerated: false,
      isPinned: false,
      createdBy: DEMO_USER_ID,
      createdAt: at,
      updatedAt: at,
    });
  });

  r.post(`${base}/query`, (req) => {
    requireProject(req.params.pid);
    const request = panelRequest(req.body);
    requireClosedRange(request.panel, request.timeRange);
    return { buckets: runPanel(req.params.pid, request.panel, request.timeRange) };
  });

  r.post(`${base}/query/stream`, (req) => {
    requireProject(req.params.pid);
    const request = panelRequest(req.body);
    requireClosedRange(request.panel, request.timeRange);
    const projectId = req.params.pid;
    return ndjson(async (send, signal) => {
      send({ type: 'heartbeat' });
      await sleep(30, signal);
      const buckets = runPanel(projectId, request.panel, request.timeRange);
      const timed =
        effectivePanelSource(request.panel) === 'logs' && (request.panel.bucketMs ?? 0) > 0;
      if (!timed || buckets.length < 40) {
        send({ type: 'buckets', buckets });
      } else {
        // Like the server's partition-by-partition reads: newest buckets first.
        const times = [...new Set(buckets.map((b) => b.timestamp ?? ''))].sort().reverse();
        const per = Math.ceil(times.length / 4);
        for (let i = 0; i < times.length; i += per) {
          const slice = new Set(times.slice(i, i + per));
          send({ type: 'buckets', buckets: buckets.filter((b) => slice.has(b.timestamp ?? '')) });
          await sleep(70, signal);
        }
      }
      send({ type: 'done' });
    }, req.signal);
  });

  r.post(`${base}/overview`, (req) => {
    requireProject(req.params.pid);
    return generateOverview(req.params.pid);
  });

  r.post(`${base}/import`, (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as ImportDashboardRequest;
    if (typeof body.json !== 'string') bad('Invalid request format');
    const result = importDashboard(body.format, body.json);
    const at = now();
    const dashboard = dashboards.insert({
      id: newId(),
      projectId: req.params.pid,
      title: result.title.slice(0, 255),
      description: result.description,
      tabs: normalizeTabs(result.tabs),
      variables: normalizeVariables(result.variables),
      isAutoGenerated: false,
      isPinned: false,
      createdBy: DEMO_USER_ID,
      createdAt: at,
      updatedAt: at,
    });
    return { dashboard, warnings: result.warnings.length ? result.warnings : undefined };
  });

  // Folders (the literal "folders" segment beats :dashboardId when matching).
  r.get(`${base}/folders`, (req) => {
    requireProject(req.params.pid);
    return {
      folders: folders
        .find((f) => f.projectId === req.params.pid)
        .sort((a, b) => a.title.localeCompare(b.title)),
    };
  });

  r.post(`${base}/folders`, (req) => {
    requireProject(req.params.pid);
    const title = validTitle((req.body as { title?: unknown } | undefined)?.title);
    const at = now();
    return folders.insert({
      id: newId(),
      projectId: req.params.pid,
      title,
      createdAt: at,
      updatedAt: at,
    });
  });

  r.put(`${base}/folders/:folderId`, (req) => {
    requireProject(req.params.pid);
    ownedFolder(req.params.pid, req.params.folderId);
    const title = validTitle((req.body as { title?: unknown } | undefined)?.title);
    return folders.update(req.params.folderId, { title, updatedAt: now() });
  });

  r.delete(`${base}/folders/:folderId`, (req) => {
    requireProject(req.params.pid);
    ownedFolder(req.params.pid, req.params.folderId);
    folders.remove(req.params.folderId);
    // ON DELETE SET NULL: the dashboards are un-filed, not deleted.
    for (const dashboard of dashboards.find((d) => d.folderId === req.params.folderId)) {
      dashboards.update(dashboard.id, { folderId: undefined });
    }
    return { message: 'Folder deleted successfully' };
  });

  r.get(`${base}/:dashboardId`, (req) => {
    requireProject(req.params.pid);
    return ownedDashboard(req.params.pid, req.params.dashboardId);
  });

  r.put(`${base}/:dashboardId`, (req) => {
    requireProject(req.params.pid);
    ownedDashboard(req.params.pid, req.params.dashboardId);
    const body = (req.body ?? {}) as UpdateDashboardRequest;
    const title = validTitle(body.title);
    checkDescription(body.description);
    return dashboards.update(req.params.dashboardId, {
      title,
      description: body.description ?? '',
      tabs: normalizeTabs(body.tabs),
      variables: normalizeVariables(body.variables),
      updatedAt: now(),
    });
  });

  r.put(`${base}/:dashboardId/pin`, (req) => {
    requireProject(req.params.pid);
    ownedDashboard(req.params.pid, req.params.dashboardId);
    const pinned = !!(req.body as { pinned?: boolean } | undefined)?.pinned;
    return dashboards.update(req.params.dashboardId, { isPinned: pinned });
  });

  r.put(`${base}/:dashboardId/folder`, (req) => {
    requireProject(req.params.pid);
    ownedDashboard(req.params.pid, req.params.dashboardId);
    const folderId = (req.body as { folderId?: string | null } | undefined)?.folderId ?? null;
    if (folderId) ownedFolder(req.params.pid, folderId);
    return dashboards.update(req.params.dashboardId, { folderId: folderId ?? undefined });
  });

  r.delete(`${base}/:dashboardId`, (req) => {
    requireProject(req.params.pid);
    ownedDashboard(req.params.pid, req.params.dashboardId);
    dashboards.remove(req.params.dashboardId);
    return { message: 'Dashboard deleted successfully' };
  });
}
