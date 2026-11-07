// Grafana and OpenObserve dashboard import for the demo. Goes a bit further
// than layout and types: Prometheus targets become metrics panels (Grafana
// variables rewritten to ${var}), Loki stream selectors and OpenObserve
// filters become logs queries, rows/tabs become tabs and simple variables
// carry over. Whatever can't be mapped is listed in the warnings.
import type { Panel, Tab, Variable } from '../../entity/dashboards';
import type { QueryNode } from '../../entity/query';
import { DemoError } from '../router';
import { newId } from '../store';

const MAX_IMPORT_BYTES = 4 << 20;

export interface ImportResult {
  title: string;
  description: string;
  tabs: Tab[];
  variables: Variable[];
  warnings: string[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value !== '' ? value : fallback;
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Attribute names the way storage keeps them: dots become underscores. */
const normalizeName = (name: string) => name.replace(/^resource\./, '').replace(/\./g, '_');

// --- layout -----------------------------------------------------------------------

interface RawPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rawPos(value: unknown): RawPos {
  const p = isObject(value) ? value : {};
  return { x: num(p.x), y: num(p.y), w: num(p.w) || 12, h: num(p.h) || 8 };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Scales a source grid of `columns` columns to our 12, clamped like the backend. */
function toGrid(pos: RawPos, columns: number, yOffset = 0): Panel['gridPos'] {
  const scale = 12 / columns;
  const x = clamp(Math.round(pos.x * scale), 0, 11);
  const w = clamp(Math.round(pos.w * scale) || 1, 1, 12 - x);
  return { x, y: clamp(pos.y - yOffset, 0, 10_000), w, h: clamp(pos.h, 1, 100) };
}

/** OpenObserve grids have changed width over versions; infer it from the widest panel. */
function inferColumns(positions: RawPos[]): number {
  const right = Math.max(0, ...positions.map((p) => p.x + p.w));
  if (right <= 12) return 12;
  if (right <= 24) return 24;
  if (right <= 48) return 48;
  return right;
}

// --- shared bits ----------------------------------------------------------------------

const cond = (
  field: string,
  operator: NonNullable<QueryNode['condition']>['operator'],
  value: NonNullable<QueryNode['condition']>['value'],
): QueryNode => ({
  type: 'condition',
  condition: { field: normalizeName(field), operator, value },
});

function allOf(nodes: QueryNode[]): QueryNode | undefined {
  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0];
  return { type: 'logical', logic: { operator: 'and', children: nodes } };
}

function unitOf(unit: string): Panel['unit'] {
  if (['bytes', 'decbytes', 'bits', 'kbytes', 'deckbytes'].includes(unit)) return 'bytes';
  if (unit === 'percentunit') return 'percent';
  return undefined;
}

// --- Grafana --------------------------------------------------------------------------

function grafanaType(type: string): Panel['type'] | undefined {
  switch (type) {
    case 'timeseries':
    case 'graph':
    case 'trend':
    case 'xychart':
      return 'line';
    case 'barchart':
    case 'bargauge':
    case 'histogram':
    case 'state-timeline':
      return 'bar';
    case 'piechart':
      return 'pie';
    case 'stat':
    case 'singlestat':
    case 'gauge':
      return 'stat';
    case 'table':
    case 'table-old':
    case 'logs':
      return 'table';
    default:
      return undefined;
  }
}

/** Grafana's built-in intervals and $var / ${var} / [[var]] into our ${var}. */
export function grafanaPromQL(expr: string): string {
  return expr
    .replace(/\$__(rate_interval|interval|range)\b|\$\{__(rate_interval|interval|range)\}/g, '5m')
    .replace(/\[\[(\w+)(?::\w+)?\]\]/g, '${$1}')
    .replace(/\$\{(\w+)(?::\w+)?\}/g, '${$1}')
    .replace(/\$([A-Za-z_]\w*)/g, (match, name: string) =>
      name.startsWith('__') ? match : `\${${name}}`,
    );
}

/** A Loki query's stream selector and line filters as a logs query. */
export function lokiToQuery(expr: string): { query?: QueryNode; dropped: boolean } {
  const nodes: QueryNode[] = [];
  let dropped = false;
  const selector = /\{([^}]*=[^}]*)\}/.exec(expr);
  if (selector) {
    for (const part of selector[1].split(',')) {
      const m = /^\s*([\w.]+)\s*(=~|!~|!=|=)\s*"([^"]*)"\s*$/.exec(part);
      if (!m) continue;
      const [, label, op, value] = m;
      if (value.includes('$')) continue; // a variable: leave it to the user
      const field = label === 'app' || label === 'job' ? 'service_name' : label;
      if (op === '=') nodes.push(cond(field, 'equals', value));
      else if (op === '!=') nodes.push(cond(field, 'not_equals', value));
      else if (op === '=~' && /^[\w-]+(\|[\w-]+)*$/.test(value)) {
        nodes.push(cond(field, 'in', value.split('|')));
      } else dropped = true;
    }
  }
  for (const m of expr.matchAll(/(\|=|!=)\s*"([^"]*)"/g)) {
    nodes.push(cond('message', m[1] === '|=' ? 'contains' : 'not_contains', m[2]));
  }
  if (
    /\|\s*(json|logfmt|regexp|pattern|line_format|label_format|unwrap)|\|~|!~|by\s*\(/.test(expr)
  ) {
    dropped = true;
  }
  return { query: allOf(nodes), dropped };
}

function grafanaPanel(raw: Json, warnings: string[], yOffset: number): Panel | undefined {
  const title = str(raw.title, 'Untitled panel');
  const sourceType = str(raw.type);
  const type = grafanaType(sourceType);
  if (!type) {
    warnings.push(`"${title}": ${sourceType || 'unknown'} panels aren't supported, skipped`);
    return undefined;
  }
  const panel: Panel = {
    id: newId(),
    title,
    type,
    gridPos: toGrid(rawPos(raw.gridPos), 24, yOffset),
  };
  const defaults =
    isObject(raw.fieldConfig) && isObject(raw.fieldConfig.defaults) ? raw.fieldConfig.defaults : {};
  const unit = unitOf(str(defaults.unit));
  if (unit) panel.unit = unit;

  const targets = arr(raw.targets)
    .filter(isObject)
    .filter((t) => !t.hide);
  const datasource = (t: Json) => {
    const ds = t.datasource ?? raw.datasource;
    return (isObject(ds) ? str(ds.type) : str(ds)).toLowerCase();
  };
  const target = targets[0];
  if (!target) {
    warnings.push(`"${title}": no query, so it counts all logs until you add one`);
    return panel;
  }
  if (targets.length > 1) {
    warnings.push(`"${title}": only the first of ${targets.length} queries was imported`);
  }
  const ds = datasource(target);
  const expr = str(target.expr);
  const looksLikeLogQL = /\{[^}]*\}\s*(\|=|!=|\|~|!~|\|\s*(json|logfmt))|_over_time\(\s*\{/.test(
    expr,
  );
  if (ds.includes('loki') || (!ds.includes('prometheus') && looksLikeLogQL)) {
    const { query, dropped } = lokiToQuery(expr);
    panel.source = 'logs';
    if (query) panel.query = query;
    const by = /(?:sum|count)\s+by\s*\(\s*([\w.]+)/.exec(expr);
    if (by) panel.groupField = normalizeName(by[1]);
    if (dropped) {
      warnings.push(`"${title}": parts of the LogQL query (parsers, regex filters) were dropped`);
    }
    return panel;
  }
  if (expr) {
    panel.source = 'metrics';
    panel.promQuery = grafanaPromQL(expr);
    return panel;
  }
  warnings.push(
    `"${title}": ${ds || 'this'} queries aren't translated; it counts all logs until you edit it`,
  );
  return panel;
}

function grafanaVariables(root: Json, warnings: string[]): Variable[] {
  const templating = isObject(root.templating) ? root.templating : {};
  const variables: Variable[] = [];
  for (const raw of arr(templating.list).filter(isObject)) {
    const key = str(raw.name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const label = str(raw.label, key);
    const type = str(raw.type);
    const query = isObject(raw.query) ? str(raw.query.query) : str(raw.query);
    if (type === 'custom') {
      const values = query
        .split(/,(?![^{]*})/)
        .map((v) => v.split(' : ').pop()!.trim())
        .filter(Boolean);
      if (values.length) variables.push({ key, label, source: 'static', staticValues: values });
      continue;
    }
    if (type === 'constant' || type === 'textbox') {
      if (query)
        variables.push({
          key,
          label,
          source: 'static',
          staticValues: [query],
          defaultValue: query,
        });
      continue;
    }
    if (type === 'query') {
      const m = /label_values\(\s*(?:[^,()]*(?:\{[^}]*\})?\s*,\s*)?([\w.]+)\s*\)/.exec(query);
      if (m) {
        const labelName = normalizeName(m[1]);
        variables.push(
          labelName === 'service_name'
            ? { key, label, source: 'services' }
            : { key, label, source: 'metricLabel', metricLabelName: labelName },
        );
        continue;
      }
    }
    if (type === 'datasource' || type === 'interval' || type === 'adhoc') continue;
    warnings.push(`variable "${key}" (${type || 'unknown'}) couldn't be imported`);
  }
  return variables;
}

function importGrafana(doc: Json): ImportResult {
  const root = isObject(doc.dashboard) ? doc.dashboard : doc;
  const warnings: string[] = [];
  const tabs: Tab[] = [];
  let current: Tab = { id: newId(), title: 'Overview', panels: [] };
  let rowY = 0;
  const push = () => {
    if (current.panels.length) tabs.push(current);
  };
  for (const raw of arr(root.panels).filter(isObject)) {
    if (str(raw.type) === 'row') {
      // Each row becomes a tab; a collapsed row keeps its panels inside it.
      push();
      current = { id: newId(), title: str(raw.title, 'Row'), panels: [] };
      rowY = num(isObject(raw.gridPos) ? raw.gridPos.y : 0) + 1;
      for (const inner of arr(raw.panels).filter(isObject)) {
        const panel = grafanaPanel(inner, warnings, rowY);
        if (panel) current.panels.push(panel);
      }
      continue;
    }
    const panel = grafanaPanel(raw, warnings, rowY);
    if (panel) current.panels.push(panel);
  }
  push();
  if (!tabs.length) warnings.unshift('no panels found in the imported JSON');
  return {
    title: str(root.title, 'Imported dashboard'),
    description: str(root.description, 'Imported from grafana.'),
    tabs,
    variables: grafanaVariables(root, warnings),
    warnings,
  };
}

// --- OpenObserve -------------------------------------------------------------------------

function openObserveType(type: string): Panel['type'] | undefined {
  switch (type) {
    case 'line':
    case 'area':
    case 'area-stacked':
    case 'scatter':
      return 'line';
    case 'bar':
    case 'h-bar':
    case 'stacked':
    case 'h-stacked':
      return 'bar';
    case 'pie':
    case 'donut':
      return 'pie';
    case 'metric':
    case 'gauge':
      return 'stat';
    case 'table':
      return 'table';
    default:
      return undefined;
  }
}

const OO_OPERATORS: Record<string, NonNullable<QueryNode['condition']>['operator']> = {
  '=': 'equals',
  '<>': 'not_equals',
  '!=': 'not_equals',
  '>': 'greater_than',
  '>=': 'greater_or_equal',
  '<': 'less_than',
  '<=': 'less_or_equal',
  contains: 'contains',
  'not contains': 'not_contains',
  in: 'in',
  'not in': 'not_in',
  'is null': 'not_exists',
  'is not null': 'exists',
};

/** OpenObserve's builder filters (old flat list or new nested group) as conditions. */
function openObserveFilters(filter: unknown, out: QueryNode[]): boolean {
  let dropped = false;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isObject(node)) return;
    if (Array.isArray(node.conditions)) {
      if (str(node.logicalOperator, 'AND').toUpperCase() === 'OR' && node.conditions.length > 1) {
        dropped = true;
        return;
      }
      return node.conditions.forEach(visit);
    }
    const column = str(node.column);
    if (!column) return;
    const op = OO_OPERATORS[str(node.operator, '=').toLowerCase()];
    if (!op) {
      dropped = true;
      return;
    }
    const value = node.value ?? (Array.isArray(node.values) ? node.values : null);
    if (op === 'in' || op === 'not_in') {
      out.push(cond(column, op, (Array.isArray(value) ? value : [value]).map(String)));
    } else if (op === 'exists' || op === 'not_exists') {
      out.push(cond(column, op, null));
    } else {
      out.push(cond(column, op, typeof value === 'number' ? value : String(value ?? '')));
    }
  };
  visit(filter);
  return dropped;
}

function openObservePanel(raw: Json, columns: number, warnings: string[]): Panel | undefined {
  const title = str(raw.title, 'Untitled panel');
  const sourceType = str(raw.type);
  const type = openObserveType(sourceType);
  if (!type) {
    warnings.push(`"${title}": ${sourceType || 'unknown'} panels aren't supported, skipped`);
    return undefined;
  }
  const panel: Panel = { id: newId(), title, type, gridPos: toGrid(rawPos(raw.layout), columns) };
  const queries = arr(raw.queries).filter(isObject);
  const first = queries[0];
  if (!first) return panel;
  if (queries.length > 1) {
    warnings.push(`"${title}": only the first of ${queries.length} queries was imported`);
  }
  const queryType = str(first.queryType, str(raw.queryType)).toLowerCase();
  const fields = isObject(first.fields) ? first.fields : {};
  const streamType = str(fields.stream_type).toLowerCase();
  if (queryType === 'promql' || streamType === 'metrics') {
    const promQuery = str(first.query);
    if (promQuery && queryType === 'promql') {
      panel.source = 'metrics';
      panel.promQuery = grafanaPromQL(promQuery);
    } else {
      warnings.push(`"${title}": a metrics builder query; add PromQL to it after import`);
      panel.source = 'metrics';
    }
    return panel;
  }
  panel.source = 'logs';
  const nodes: QueryNode[] = [];
  const dropped = openObserveFilters(fields.filter, nodes);
  const query = allOf(nodes);
  if (query) panel.query = query;
  const breakdown = arr(fields.breakdown).filter(isObject)[0];
  const xAxis = arr(fields.x).filter(isObject);
  const nonTimeX = xAxis.find(
    (x) => !/_timestamp|histogram/i.test(str(x.column) + str(x.aggregationFunction)),
  );
  const group = breakdown ? str(breakdown.column) : nonTimeX ? str(nonTimeX.column) : '';
  if (group) panel.groupField = normalizeName(group);
  if (first.customQuery) {
    warnings.push(`"${title}": custom SQL isn't translated; it counts logs matching its filters`);
  } else if (dropped) {
    warnings.push(`"${title}": some filters (OR groups, unknown operators) were dropped`);
  }
  return panel;
}

function openObserveVariables(doc: Json, warnings: string[]): Variable[] {
  const container = isObject(doc.variables) ? doc.variables : {};
  const variables: Variable[] = [];
  for (const raw of arr(container.list).filter(isObject)) {
    const key = str(raw.name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const label = str(raw.label, key);
    const type = str(raw.type);
    if (type === 'custom') {
      const values = arr(raw.options)
        .filter(isObject)
        .map((o) => str(o.value))
        .filter(Boolean);
      if (values.length) variables.push({ key, label, source: 'static', staticValues: values });
      continue;
    }
    if (type === 'constant' || type === 'textbox') {
      const value = str(raw.value);
      if (value)
        variables.push({
          key,
          label,
          source: 'static',
          staticValues: [value],
          defaultValue: value,
        });
      continue;
    }
    if (type === 'query_values') {
      const data = isObject(raw.query_data) ? raw.query_data : {};
      const field = normalizeName(str(data.field));
      if (field === 'service_name') {
        variables.push({ key, label, source: 'services' });
        continue;
      }
      if (field && str(data.stream_type) === 'metrics') {
        variables.push({ key, label, source: 'metricLabel', metricLabelName: field });
        continue;
      }
    }
    warnings.push(`variable "${key}" (${type || 'unknown'}) couldn't be imported`);
  }
  return variables;
}

function importOpenObserve(doc: Json): ImportResult {
  const warnings: string[] = [];
  const sourceTabs: { name: string; panels: Json[] }[] = [];
  const topPanels = arr(doc.panels).filter(isObject);
  if (topPanels.length) {
    sourceTabs.push({ name: 'Default', panels: topPanels });
  } else {
    for (const raw of arr(doc.tabs).filter(isObject)) {
      sourceTabs.push({ name: str(raw.name, 'Tab'), panels: arr(raw.panels).filter(isObject) });
    }
  }
  const columns = inferColumns(sourceTabs.flatMap((t) => t.panels.map((p) => rawPos(p.layout))));
  const tabs: Tab[] = [];
  for (const source of sourceTabs) {
    const panels = source.panels
      .map((raw) => openObservePanel(raw, columns, warnings))
      .filter((p): p is Panel => !!p);
    if (panels.length) tabs.push({ id: newId(), title: source.name, panels });
  }
  if (!tabs.length) warnings.unshift('no panels found in the imported JSON');
  return {
    title: str(doc.title, 'Imported dashboard'),
    description: str(doc.description, 'Imported from openobserve.'),
    tabs,
    variables: openObserveVariables(doc, warnings),
    warnings,
  };
}

// --- entry ------------------------------------------------------------------------------------

export function importDashboard(format: string, json: string): ImportResult {
  if (json.length > MAX_IMPORT_BYTES) {
    throw new DemoError(
      400,
      `the dashboard JSON can't be larger than ${MAX_IMPORT_BYTES >> 20} MiB`,
    );
  }
  if (format !== 'grafana' && format !== 'openobserve') {
    throw new DemoError(400, `unsupported import format "${format}"`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (error) {
    throw new DemoError(
      400,
      `failed to parse dashboard JSON: invalid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!isObject(doc)) {
    throw new DemoError(400, 'failed to parse dashboard JSON: expected a JSON object');
  }
  return format === 'grafana' ? importGrafana(doc) : importOpenObserve(doc);
}
