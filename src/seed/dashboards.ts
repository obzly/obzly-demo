// The demo's saved dashboards: what a Harborline engineer would have built.
// Logs panels read the generated logs, spans panels the generated traces and
// metrics panels PromQL over the metric registry's standard OTel/Prometheus
// names, so each panel shows the recurring payments incident in its own way.
import type { Dashboard, Folder, Panel, Tab, Variable } from '../../entity/dashboards';
import type { QueryNode } from '../../entity/query';
import { uuidFrom } from '../lib/rng';
import { PROJECT_ID } from '../world';

const DAY = 86_400_000;
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / 60_000) * 60_000).toISOString();

// --- query helpers ------------------------------------------------------------

export const cond = (
  field: string,
  operator: NonNullable<QueryNode['condition']>['operator'],
  value: NonNullable<QueryNode['condition']>['value'],
): QueryNode => ({ type: 'condition', condition: { field, operator, value } });

export const and = (...children: QueryNode[]): QueryNode => ({
  type: 'logical',
  logic: { operator: 'and', children },
});

export const errorLevels = () => cond('level', 'in', ['error', 'fatal']);
export const checkout5xx = () =>
  and(
    cond('service_name', 'equals', 'ingress-nginx'),
    cond('http_status_code', 'in', ['500', '502', '504']),
  );

// --- panel builders -------------------------------------------------------------

type Grid = Panel['gridPos'];
const grid = (x: number, y: number, w: number, h: number): Grid => ({ x, y, w, h });

function logsPanel(
  key: string,
  title: string,
  type: Panel['type'],
  gridPos: Grid,
  extra: Partial<Panel> = {},
): Panel {
  return { id: uuidFrom(`demo-panel:${key}`), title, type, source: 'logs', gridPos, ...extra };
}

function spansPanel(
  key: string,
  title: string,
  type: Panel['type'],
  gridPos: Grid,
  extra: Partial<Panel>,
): Panel {
  return { id: uuidFrom(`demo-panel:${key}`), title, type, source: 'spans', gridPos, ...extra };
}

function metricsPanel(
  key: string,
  title: string,
  type: Panel['type'],
  promQuery: string,
  gridPos: Grid,
  unit?: Panel['unit'],
): Panel {
  const panel: Panel = {
    id: uuidFrom(`demo-panel:${key}`),
    title,
    type,
    source: 'metrics',
    promQuery,
    gridPos,
  };
  if (unit) panel.unit = unit;
  return panel;
}

const tab = (key: string, title: string, panels: Panel[]): Tab => ({
  id: uuidFrom(`demo-tab:${key}`),
  title,
  panels,
});

// --- folders --------------------------------------------------------------------

export const SERVICES_FOLDER_ID = uuidFrom('demo-folder:services');
export const INFRA_FOLDER_ID = uuidFrom('demo-folder:infrastructure');

export function seedFolders(): Folder[] {
  return [
    {
      id: SERVICES_FOLDER_ID,
      projectId: PROJECT_ID,
      title: 'Services',
      createdAt: daysAgo(80),
      updatedAt: daysAgo(80),
    },
    {
      id: INFRA_FOLDER_ID,
      projectId: PROJECT_ID,
      title: 'Infrastructure',
      createdAt: daysAgo(80),
      updatedAt: daysAgo(41),
    },
  ];
}

// --- dashboards -------------------------------------------------------------------

export const OVERVIEW_DASHBOARD_ID = uuidFrom('demo-dashboard:harborline-overview');
export const CHECKOUT_DASHBOARD_ID = uuidFrom('demo-dashboard:checkout-payments');
export const K8S_DASHBOARD_ID = uuidFrom('demo-dashboard:kubernetes');
export const POSTGRES_DASHBOARD_ID = uuidFrom('demo-dashboard:postgres');

const HTTP_BUCKETS = 'http_server_request_duration_seconds_bucket';
const HTTP_COUNT = 'http_server_request_duration_seconds_count';

function harborlineOverview(): Dashboard {
  const overview = tab('overview:main', 'Overview', [
    spansPanel('ov:requests', 'Requests', 'stat', grid(0, 0, 3, 4), {
      rootSpansOnly: true,
      metric: 'count',
    }),
    logsPanel('ov:errors', 'Error logs', 'stat', grid(3, 0, 3, 4), { query: errorLevels() }),
    spansPanel('ov:p95', 'Request p95 (ms)', 'stat', grid(6, 0, 3, 4), {
      serviceName: 'ingress-nginx',
      rootSpansOnly: true,
      metric: 'p95_duration_ms',
    }),
    metricsPanel(
      'ov:cpu-stat',
      'Node CPU',
      'stat',
      '1 - avg(rate(system_cpu_time{state="idle"}[5m]))',
      grid(9, 0, 3, 4),
      'percent',
    ),
    spansPanel('ov:req-by-service', 'Requests by service', 'line', grid(0, 4, 6, 8), {
      groupField: 'service_name',
      metric: 'count',
      limit: 10,
    }),
    logsPanel('ov:errors-by-service', 'Errors by service (logs)', 'bar', grid(6, 4, 6, 8), {
      query: errorLevels(),
      groupField: 'service_name',
      limit: 10,
    }),
    spansPanel('ov:p95-by-service', 'p95 latency by service (ms)', 'line', grid(0, 12, 6, 8), {
      groupField: 'service_name',
      metric: 'p95_duration_ms',
      limit: 10,
    }),
    metricsPanel(
      'ov:cpu-by-node',
      'CPU utilization by node',
      'line',
      '1 - avg by (host_name) (rate(system_cpu_time{state="idle"}[5m]))',
      grid(6, 12, 6, 8),
      'percent',
    ),
    logsPanel('ov:levels', 'Log levels', 'pie', grid(0, 20, 4, 8), {
      groupField: 'level',
      limit: 10,
    }),
    logsPanel('ov:top-errors', 'Top error messages', 'table', grid(4, 20, 8, 8), {
      query: errorLevels(),
      groupField: 'message',
      limit: 10,
    }),
  ]);
  const http = tab('overview:http', 'HTTP (metrics)', [
    metricsPanel(
      'ov:http-rate',
      'Request rate by service (req/s)',
      'line',
      `sum by (service_name) (rate(${HTTP_COUNT}[5m]))`,
      grid(0, 0, 6, 8),
    ),
    metricsPanel(
      'ov:http-p95',
      'p95 request duration by service (s)',
      'line',
      `histogram_quantile(0.95, sum by (le, service_name) (rate(${HTTP_BUCKETS}[5m])))`,
      grid(6, 0, 6, 8),
    ),
    metricsPanel(
      'ov:http-5xx',
      '5xx responses by service (req/s)',
      'bar',
      `sum by (service_name) (rate(${HTTP_COUNT}{http_response_status_code=~"5.."}[5m]))`,
      grid(0, 8, 12, 8),
    ),
  ]);
  return {
    id: OVERVIEW_DASHBOARD_ID,
    projectId: PROJECT_ID,
    title: 'Harborline overview',
    description:
      'The shop at a glance: traffic, errors and latency per service, and node CPU. ' +
      'The spike every 6 hours is the payments connection-pool incident.',
    tabs: [overview, http],
    variables: [],
    isAutoGenerated: false,
    isPinned: true,
    createdAt: daysAgo(78),
    updatedAt: daysAgo(3),
  };
}

function checkoutPayments(): Dashboard {
  const flow = tab('checkout:flow', 'Checkout flow', [
    logsPanel('co:5xx', 'Checkout 5xx at the ingress', 'line', grid(0, 0, 6, 8), {
      query: checkout5xx(),
      groupField: 'http_status_code',
      limit: 5,
    }),
    logsPanel('co:orders', 'Orders placed', 'line', grid(6, 0, 6, 8), {
      query: and(
        cond('service_name', 'equals', 'checkout'),
        cond('order_id', 'exists', null),
        cond('level', 'equals', 'info'),
      ),
    }),
    spansPanel('co:p95-ops', 'Checkout p95 by operation (ms)', 'line', grid(0, 8, 6, 8), {
      serviceName: 'checkout',
      groupField: 'name',
      metric: 'p95_duration_ms',
      limit: 8,
    }),
    spansPanel('co:errors-ops', 'Checkout span errors by operation', 'bar', grid(6, 8, 6, 8), {
      serviceName: 'checkout',
      groupField: 'name',
      metric: 'error_count',
      limit: 8,
    }),
    logsPanel('co:top-errors', 'Top checkout errors', 'table', grid(0, 16, 12, 8), {
      query: and(cond('service_name', 'in', ['checkout', 'storefront']), errorLevels()),
      groupField: 'message',
      limit: 10,
    }),
  ]);
  const payments = tab('checkout:payments', 'Payments', [
    spansPanel('pay:p95', 'Payments p95 (ms)', 'stat', grid(0, 0, 3, 4), {
      serviceName: 'payments',
      metric: 'p95_duration_ms',
    }),
    spansPanel('pay:errors', 'Payments span errors', 'stat', grid(3, 0, 3, 4), {
      serviceName: 'payments',
      metric: 'error_count',
    }),
    logsPanel('pay:pool', 'Pool exhausted errors', 'stat', grid(6, 0, 3, 4), {
      query: and(cond('service_name', 'equals', 'payments'), errorLevels()),
    }),
    metricsPanel(
      'pay:http-p99',
      'Payments p99 (s)',
      'stat',
      `histogram_quantile(0.99, sum by (le) (rate(${HTTP_BUCKETS}{service_name="payments"}[5m])))`,
      grid(9, 0, 3, 4),
    ),
    metricsPanel(
      'pay:latency',
      'Checkout and payments p95 (s)',
      'line',
      `histogram_quantile(0.95, sum by (le, service_name) (rate(${HTTP_BUCKETS}{service_name=~"checkout|payments"}[5m])))`,
      grid(0, 4, 6, 8),
    ),
    logsPanel('pay:levels', 'Payments logs by level', 'bar', grid(6, 4, 6, 8), {
      query: cond('service_name', 'equals', 'payments'),
      groupField: 'level',
      limit: 5,
    }),
    logsPanel('pay:methods', 'Payment methods', 'pie', grid(0, 12, 4, 8), {
      query: cond('payment_method', 'exists', null),
      groupField: 'payment_method',
      limit: 8,
    }),
    logsPanel('pay:declines', 'Decline reasons', 'table', grid(4, 12, 4, 8), {
      query: cond('decline_reason', 'exists', null),
      groupField: 'decline_reason',
      limit: 8,
    }),
    logsPanel('pay:currencies', 'Payments by currency', 'pie', grid(8, 12, 4, 8), {
      query: and(cond('service_name', 'equals', 'payments'), cond('currency', 'exists', null)),
      groupField: 'currency',
      limit: 5,
    }),
  ]);
  return {
    id: CHECKOUT_DASHBOARD_ID,
    projectId: PROJECT_ID,
    title: 'Checkout & payments',
    description:
      'From the ingress to the payment provider. During an incident the 5xx line, the ' +
      'payments p95 and the pool-exhausted errors move together.',
    tabs: [flow, payments],
    variables: [],
    isAutoGenerated: false,
    isPinned: true,
    folderId: SERVICES_FOLDER_ID,
    createdAt: daysAgo(64),
    updatedAt: daysAgo(1),
  };
}

const NS = 'k8s_namespace_name=~"${namespace}"';

function kubernetesCluster(): Dashboard {
  const variables: Variable[] = [
    {
      key: 'namespace',
      label: 'Namespace',
      source: 'metricLabel',
      metricLabelName: 'k8s_namespace_name',
    },
    { key: 'service', label: 'Service', source: 'services', defaultValue: 'checkout' },
  ];
  const workloads = tab('k8s:workloads', 'Workloads', [
    metricsPanel(
      'k8s:pods',
      'Pods',
      'stat',
      `count(count by (k8s_pod_name) (k8s_pod_cpu_usage{${NS}}))`,
      grid(0, 0, 3, 4),
    ),
    metricsPanel(
      'k8s:cpu-total',
      'Pod CPU (cores)',
      'stat',
      `sum(k8s_pod_cpu_usage{${NS}})`,
      grid(3, 0, 3, 4),
    ),
    metricsPanel(
      'k8s:mem-total',
      'Working set (sum)',
      'stat',
      `sum(container_memory_working_set{${NS}})`,
      grid(6, 0, 3, 4),
      'bytes',
    ),
    logsPanel('k8s:warn', 'Warnings and errors', 'stat', grid(9, 0, 3, 4), {
      query: cond('level', 'in', ['warn', 'error', 'fatal']),
    }),
    metricsPanel(
      'k8s:cpu-by-pod',
      'CPU by pod (cores)',
      'line',
      `sum by (k8s_pod_name) (k8s_pod_cpu_usage{${NS}})`,
      grid(0, 4, 6, 9),
    ),
    metricsPanel(
      'k8s:mem-by-container',
      'Memory working set by container',
      'line',
      `sum by (k8s_container_name) (container_memory_working_set{${NS}})`,
      grid(6, 4, 6, 9),
      'bytes',
    ),
    logsPanel('k8s:logs-by-ns', 'Logs by namespace', 'bar', grid(0, 13, 6, 8), {
      groupField: 'k8s_namespace_name',
      limit: 10,
    }),
    logsPanel('k8s:logs-by-pod', 'Logs of ${service} by pod', 'line', grid(6, 13, 6, 8), {
      query: cond('service_name', 'equals', '${service}'),
      groupField: 'k8s_pod_name',
      limit: 10,
    }),
  ]);
  const nodes = tab('k8s:nodes', 'Nodes', [
    metricsPanel(
      'k8s:node-cpu',
      'CPU utilization by node',
      'line',
      '1 - avg by (host_name) (rate(system_cpu_time{state="idle"}[5m]))',
      grid(0, 0, 6, 9),
      'percent',
    ),
    logsPanel('k8s:logs-by-node', 'Logs by node', 'bar', grid(6, 0, 6, 9), {
      groupField: 'k8s_node_name',
      limit: 10,
    }),
    logsPanel('k8s:pods-by-node', 'Busiest pods', 'table', grid(0, 9, 12, 8), {
      groupField: 'k8s_pod_name',
      limit: 15,
    }),
  ]);
  return {
    id: K8S_DASHBOARD_ID,
    projectId: PROJECT_ID,
    title: 'Kubernetes cluster',
    description: 'harborline-prod (eu-west-1): pod CPU and memory, logs per namespace and node.',
    tabs: [workloads, nodes],
    variables,
    isAutoGenerated: false,
    isPinned: false,
    folderId: INFRA_FOLDER_ID,
    createdAt: daysAgo(55),
    updatedAt: daysAgo(9),
  };
}

function postgres(): Dashboard {
  const panels = [
    metricsPanel(
      'pg:usage',
      'Connections used',
      'stat',
      'sum(postgresql_backends) / max(postgresql_connection_max)',
      grid(0, 0, 3, 4),
      'percent',
    ),
    metricsPanel(
      'pg:max',
      'max_connections',
      'stat',
      'max(postgresql_connection_max)',
      grid(3, 0, 3, 4),
    ),
    logsPanel('pg:fatal-stat', 'FATAL connection errors', 'stat', grid(6, 0, 3, 4), {
      query: and(cond('service_name', 'equals', 'postgres'), cond('level', 'equals', 'fatal')),
    }),
    logsPanel('pg:slow-stat', 'Slow statements', 'stat', grid(9, 0, 3, 4), {
      query: and(
        cond('service_name', 'equals', 'postgres'),
        cond('message', 'contains', 'duration:'),
      ),
    }),
    metricsPanel(
      'pg:backends',
      'Backends by database',
      'line',
      'sum by (postgresql_database_name) (postgresql_backends)',
      grid(0, 4, 6, 8),
    ),
    metricsPanel(
      'pg:commits',
      'Commits per second',
      'line',
      'sum(rate(postgresql_commits[5m]))',
      grid(6, 4, 6, 8),
    ),
    logsPanel('pg:fatal', 'Connection-slot errors', 'line', grid(0, 12, 6, 8), {
      query: and(cond('service_name', 'equals', 'postgres'), cond('level', 'equals', 'fatal')),
    }),
    logsPanel('pg:slow', 'Slow statements (> 500 ms)', 'line', grid(6, 12, 6, 8), {
      query: and(
        cond('service_name', 'equals', 'postgres'),
        cond('duration_ms', 'greater_than', 500),
      ),
    }),
    logsPanel('pg:pool-timeouts', 'Pool timeouts by payments pod', 'table', grid(0, 20, 6, 8), {
      query: cond('db_pool', 'exists', null),
      groupField: 'k8s_pod_name',
      limit: 10,
    }),
    logsPanel('pg:levels', 'Postgres logs by level', 'pie', grid(6, 20, 6, 8), {
      query: cond('service_name', 'equals', 'postgres'),
      groupField: 'level',
      limit: 5,
    }),
  ];
  return {
    id: POSTGRES_DASHBOARD_ID,
    projectId: PROJECT_ID,
    title: 'Postgres',
    description:
      'The shop database (statefulset postgres in namespace data): connection headroom, ' +
      'throughput and slow statements.',
    tabs: [tab('pg:main', 'Postgres', panels)],
    variables: [],
    isAutoGenerated: false,
    isPinned: false,
    folderId: INFRA_FOLDER_ID,
    createdAt: daysAgo(41),
    updatedAt: daysAgo(6),
  };
}

export function seedDashboards(): Dashboard[] {
  return [harborlineOverview(), checkoutPayments(), kubernetesCluster(), postgres()];
}
