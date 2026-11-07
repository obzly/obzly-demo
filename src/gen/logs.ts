// Sample logs, generated on demand. Time is cut into 10-second slots; each
// slot's logs come from a PRNG seeded by the slot index (and project), so any
// range regenerates exactly the same rows.
import { type Rng, hashString, hex, int, mix, pick, poisson, rng, weighted } from '../lib/rng';
import {
  BATCH_HOST,
  CLIENT_IPS,
  CLUSTER,
  PROJECT_ID,
  WORKLOADS,
  type Workload,
  dataStart,
  incidentLevel,
  podsFor,
  spanIdFor,
  traceIdAt,
  traffic,
  workloadByService,
} from '../world';

export const SLOT_MS = 10_000;

/**
 * How long before its log a traced request started (ms), per template, so the
 * log falls inside its service's span. Keep within 1-400: gen/traces.ts looks
 * for a trace's log only in the 400 ms after the trace starts.
 */
const LOG_TRACE_OFFSET: Record<string, [number, number]> = {
  'storefront.render': [2, 20],
  'storefront.slow_api': [2, 400],
  'storefront.checkout_failed': [2, 400],
  'checkout.order_placed': [8, 110],
  'checkout.payment_timeout': [8, 400],
  'checkout.retry': [8, 400],
  'payments.authorized': [20, 110],
  'payments.declined': [20, 110],
  'payments.pool_exhausted': [45, 400],
  'catalog.served': [6, 10],
  'inventory.reserved': [8, 10],
  'search.query': [6, 8],
  'auth.signin': [3, 38],
};
/** Average logs per second across the project at traffic 1. */
const BASE_RATE = 2.4;

export interface GenLog {
  id: string;
  projectId: string;
  timestamp: string;
  ts: number;
  level: string;
  message: string;
  fields: Record<string, string>;
  clientIp?: string;
  traceId?: string;
  spanId?: string;
  patternHash: string;
  /** Template id, for patterns and anomalies. */
  template: string;
}

interface Ctx {
  r: Rng;
  t: number;
  incident: number;
  traceId: string;
}

interface Rendered {
  message: string;
  fields?: Record<string, string>;
  clientIp?: string;
}

interface Template {
  id: string;
  level: string;
  /** Message pattern with <*> where values vary; what Patterns shows. */
  pattern: string;
  weight: (incident: number) => number;
  render: (ctx: Ctx) => Rendered;
  traced?: boolean;
}

const routes = [
  ['GET', '/', 6],
  ['GET', '/products', 10],
  ['GET', '/products/:id', 16],
  ['GET', '/search', 8],
  ['GET', '/cart', 5],
  ['POST', '/cart/items', 4],
  ['POST', '/checkout', 2],
  ['GET', '/account', 2],
  ['POST', '/login', 2],
  ['GET', '/static/app.js', 6],
] as const;

const agents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Harborline-iOS/4.12.0 CFNetwork/1568 Darwin/24.1.0',
];

const products = [
  'trail running shoes',
  'rain jacket',
  'merino socks',
  'canvas tote',
  'travel mug',
  'wool beanie',
  'hiking poles',
  'linen shirt',
];
const currencies = ['EUR', 'EUR', 'EUR', 'GBP', 'USD'];
const nginxTime = (t: number) => {
  const d = new Date(t);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${months[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};
const pgTime = (t: number) => new Date(t).toISOString().replace('T', ' ').replace('Z', ' UTC');
const orderId = (r: Rng) => `ORD-${int(r, 100000, 999999)}`;
const userId = (r: Rng) => `u_${int(r, 1000, 48000)}`;
const sku = (r: Rng) => `SKU-${int(r, 10000, 10999)}`;
const money = (r: Rng) => (int(r, 900, 24000) / 100).toFixed(2);
const always = (w: number) => () => w;

const TEMPLATES: Record<string, Template[]> = {
  'ingress-nginx': [
    {
      id: 'nginx.access',
      level: 'info',
      pattern: '<*> - - [<*>] "<*> <*> HTTP/1.1" <*> <*> "-" "<*>" <*>',
      weight: (i) => 100 - 20 * i,
      render: ({ r, t }) => {
        const [method, route] = weighted(
          r,
          routes.map(([m, p, w]) => [[m, p], w] as const),
        );
        const path = route.replace(':id', String(int(r, 1000, 1999)));
        const status = r() < 0.03 ? pick(r, ['301', '304', '404']) : '200';
        const bytes = int(r, 300, 48000);
        const duration = (int(r, 3, 180) / 1000).toFixed(3);
        const ip = pick(r, CLIENT_IPS);
        return {
          message: `${ip} - - [${nginxTime(t)}] "${method} ${path} HTTP/1.1" ${status} ${bytes} "-" "${pick(r, agents)}" ${duration}`,
          clientIp: ip,
          fields: {
            http_method: method,
            http_route: route,
            http_status_code: status,
            duration_ms: String(Math.round(Number(duration) * 1000)),
          },
        };
      },
    },
    {
      id: 'nginx.access.5xx',
      level: 'error',
      pattern: '<*> - - [<*>] "POST /checkout HTTP/1.1" <*> <*> "-" "<*>" <*>',
      weight: (i) => 0.2 + 25 * i,
      render: ({ r, t }) => {
        const ip = pick(r, CLIENT_IPS);
        const status = pick(r, ['502', '504', '500']);
        const duration = (int(r, 2000, 5100) / 1000).toFixed(3);
        return {
          message: `${ip} - - [${nginxTime(t)}] "POST /checkout HTTP/1.1" ${status} 157 "-" "${pick(r, agents)}" ${duration}`,
          clientIp: ip,
          fields: {
            http_method: 'POST',
            http_route: '/checkout',
            http_status_code: status,
            duration_ms: String(Math.round(Number(duration) * 1000)),
          },
        };
      },
    },
  ],
  storefront: [
    {
      id: 'storefront.render',
      level: 'info',
      pattern: 'Rendered <*> in <*>ms (cache <*>)',
      weight: always(60),
      traced: true,
      render: ({ r }) => {
        const page = pick(r, ['/', '/products', '/products/:id', '/cart', '/search']);
        const ms = int(r, 8, 140);
        const cache = r() < 0.7 ? 'hit' : 'miss';
        return {
          message: `Rendered ${page} in ${ms}ms (cache ${cache})`,
          fields: { http_route: page, duration_ms: String(ms), cache },
        };
      },
    },
    {
      id: 'storefront.session',
      level: 'debug',
      pattern: 'Session <*> refreshed for <*>',
      weight: always(18),
      render: ({ r }) => {
        const user = userId(r);
        return {
          message: `Session ${hex(mix(r() * 1e9), 8)} refreshed for ${user}`,
          fields: { user_id: user },
        };
      },
    },
    {
      id: 'storefront.checkout_failed',
      level: 'error',
      pattern: 'Checkout failed for cart <*>: upstream checkout returned <*>',
      weight: (i) => 0.05 + 30 * i,
      traced: true,
      render: ({ r }) => {
        const status = pick(r, ['502', '504']);
        return {
          message: `Checkout failed for cart ${hex(mix(r() * 1e9), 6)}: upstream checkout returned ${status}`,
          fields: { http_status_code: status, upstream: 'checkout' },
        };
      },
    },
    {
      id: 'storefront.slow_api',
      level: 'warn',
      pattern: 'Slow upstream call to <*> took <*>ms',
      weight: (i) => 2 + 10 * i,
      traced: true,
      render: ({ r }) => {
        const upstream = pick(r, ['catalog', 'search', 'checkout']);
        const ms = int(r, 800, 3200);
        return {
          message: `Slow upstream call to ${upstream} took ${ms}ms`,
          fields: { upstream, duration_ms: String(ms) },
        };
      },
    },
  ],
  checkout: [
    {
      id: 'checkout.order_placed',
      level: 'info',
      pattern: 'Order <*> placed: <*> items, total <*> <*>',
      weight: (i) => 40 - 25 * i,
      traced: true,
      render: ({ r }) => {
        const order = orderId(r);
        const items = int(r, 1, 6);
        const amount = money(r);
        const currency = pick(r, currencies);
        return {
          message: `Order ${order} placed: ${items} items, total ${amount} ${currency}`,
          fields: {
            order_id: order,
            item_count: String(items),
            amount,
            currency,
            user_id: userId(r),
          },
        };
      },
    },
    {
      id: 'checkout.cart',
      level: 'debug',
      pattern: 'Cart <*> recalculated in <*>ms',
      weight: always(30),
      render: ({ r }) => {
        const ms = int(r, 2, 40);
        return {
          message: `Cart ${hex(mix(r() * 1e9), 6)} recalculated in ${ms}ms`,
          fields: { duration_ms: String(ms) },
        };
      },
    },
    {
      id: 'checkout.payment_timeout',
      level: 'error',
      pattern: 'Payment authorization failed for order <*>: upstream timeout after 5000ms',
      weight: (i) => 0.05 + 45 * i,
      traced: true,
      render: ({ r }) => {
        const order = orderId(r);
        return {
          message: `Payment authorization failed for order ${order}: upstream timeout after 5000ms`,
          fields: { order_id: order, upstream: 'payments', error_type: 'timeout' },
        };
      },
    },
    {
      id: 'checkout.retry',
      level: 'warn',
      pattern: 'Retrying payment for order <*> (attempt <*>/3)',
      weight: (i) => 0.5 + 20 * i,
      traced: true,
      render: ({ r }) => {
        const order = orderId(r);
        const attempt = int(r, 2, 3);
        return {
          message: `Retrying payment for order ${order} (attempt ${attempt}/3)`,
          fields: { order_id: order, attempt: String(attempt) },
        };
      },
    },
  ],
  payments: [
    {
      id: 'payments.authorized',
      level: 'info',
      pattern: 'Authorized payment <*> for <*> <*> via <*> in <*>ms',
      weight: (i) => 50 - 35 * i,
      traced: true,
      render: ({ r, incident }) => {
        const ms = int(r, 90, 320) + Math.round(incident * int(r, 1500, 4000));
        const amount = money(r);
        const currency = pick(r, currencies);
        const method = pick(r, ['card', 'card', 'card', 'paypal', 'sepa']);
        return {
          message: `Authorized payment pay_${hex(mix(r() * 1e9), 10)} for ${amount} ${currency} via ${method} in ${ms}ms`,
          fields: { amount, currency, payment_method: method, duration_ms: String(ms) },
        };
      },
    },
    {
      id: 'payments.pool_exhausted',
      level: 'error',
      pattern:
        'HikariPool-1 - Connection is not available, request timed out after <*>ms (total=20, active=20, idle=0, waiting=<*>)',
      weight: (i) => 60 * i,
      traced: true,
      render: ({ r }) => {
        const waiting = int(r, 4, 48);
        const ms = int(r, 3000, 5000);
        return {
          message: `HikariPool-1 - Connection is not available, request timed out after ${ms}ms (total=20, active=20, idle=0, waiting=${waiting})`,
          fields: {
            db_pool: 'HikariPool-1',
            pool_waiting: String(waiting),
            error_type: 'SQLTransientConnectionException',
          },
        };
      },
    },
    {
      id: 'payments.declined',
      level: 'warn',
      pattern: 'Payment <*> declined by issuer: <*>',
      weight: always(3),
      traced: true,
      render: ({ r }) => {
        const reason = pick(r, ['insufficient_funds', 'do_not_honor', 'expired_card']);
        return {
          message: `Payment pay_${hex(mix(r() * 1e9), 10)} declined by issuer: ${reason}`,
          fields: { decline_reason: reason },
        };
      },
    },
    {
      id: 'payments.gc',
      level: 'debug',
      pattern: 'GC pause (G1 Evacuation Pause) <*>ms, heap <*>M-><*>M',
      weight: always(8),
      render: ({ r }) => {
        const before = int(r, 400, 900);
        return {
          message: `GC pause (G1 Evacuation Pause) ${int(r, 3, 40)}ms, heap ${before}M->${before - int(r, 100, 300)}M`,
        };
      },
    },
  ],
  catalog: [
    {
      id: 'catalog.served',
      level: 'info',
      pattern: 'GET /products/<*> 200 in <*>ms',
      weight: always(55),
      traced: true,
      render: ({ r }) => {
        const id = int(r, 1000, 1999);
        const ms = int(r, 4, 60);
        return {
          message: `GET /products/${id} 200 in ${ms}ms`,
          fields: { product_id: String(id), http_status_code: '200', duration_ms: String(ms) },
        };
      },
    },
    {
      id: 'catalog.cache_miss',
      level: 'debug',
      pattern: 'Cache miss for product <*>, loaded from database in <*>ms',
      weight: always(20),
      render: ({ r }) => ({
        message: `Cache miss for product ${int(r, 1000, 1999)}, loaded from database in ${int(r, 12, 90)}ms`,
      }),
    },
    {
      id: 'catalog.reindex',
      level: 'info',
      pattern: 'Reindexed <*> products in <*>s',
      weight: always(1),
      render: ({ r }) => ({
        message: `Reindexed ${int(r, 40, 400)} products in ${(int(r, 10, 90) / 10).toFixed(1)}s`,
      }),
    },
    {
      id: 'catalog.image_missing',
      level: 'warn',
      pattern: 'Image not found for product <*>, using placeholder',
      weight: always(2),
      render: ({ r }) => ({
        message: `Image not found for product ${int(r, 1000, 1999)}, using placeholder`,
      }),
    },
  ],
  inventory: [
    {
      id: 'inventory.reserved',
      level: 'info',
      pattern: 'Reserved <*> units of <*> for order <*>',
      weight: always(50),
      traced: true,
      render: ({ r }) => {
        const s = sku(r);
        const order = orderId(r);
        return {
          message: `Reserved ${int(r, 1, 4)} units of ${s} for order ${order}`,
          fields: { sku: s, order_id: order },
        };
      },
    },
    {
      id: 'inventory.low_stock',
      level: 'warn',
      pattern: 'Stock low for <*>: <*> left (reorder point <*>)',
      weight: always(4),
      render: ({ r }) => {
        const s = sku(r);
        return {
          message: `Stock low for ${s}: ${int(r, 0, 5)} left (reorder point 10)`,
          fields: { sku: s },
        };
      },
    },
    {
      id: 'inventory.sync',
      level: 'info',
      pattern: 'Warehouse sync finished: <*> SKUs updated',
      weight: always(3),
      render: ({ r }) => ({ message: `Warehouse sync finished: ${int(r, 20, 300)} SKUs updated` }),
    },
  ],
  search: [
    {
      id: 'search.query',
      level: 'info',
      pattern: 'Query "<*>" returned <*> hits in <*>ms',
      weight: always(60),
      traced: true,
      render: ({ r }) => {
        const q = pick(r, products);
        const ms = int(r, 6, 80);
        return {
          message: `Query "${q}" returned ${int(r, 0, 240)} hits in ${ms}ms`,
          fields: { search_query: q, duration_ms: String(ms) },
        };
      },
    },
    {
      id: 'search.slow',
      level: 'warn',
      pattern: 'Slow query "<*>" took <*>ms',
      weight: always(3),
      render: ({ r }) => {
        const q = pick(r, products);
        const ms = int(r, 600, 1800);
        return {
          message: `Slow query "${q}" took ${ms}ms`,
          fields: { search_query: q, duration_ms: String(ms) },
        };
      },
    },
  ],
  auth: [
    {
      id: 'auth.signin',
      level: 'info',
      pattern: 'User <*> signed in (method=<*>)',
      weight: always(30),
      traced: true,
      render: ({ r }) => {
        const user = userId(r);
        const method = pick(r, ['password', 'password', 'passkey', 'google']);
        return {
          message: `User ${user} signed in (method=${method})`,
          fields: { user_id: user, auth_method: method },
        };
      },
    },
    {
      id: 'auth.refresh',
      level: 'debug',
      pattern: 'Token refreshed for <*>',
      weight: always(40),
      render: ({ r }) => {
        const user = userId(r);
        return { message: `Token refreshed for ${user}`, fields: { user_id: user } };
      },
    },
    {
      id: 'auth.failed',
      level: 'warn',
      pattern: 'Failed sign-in for <*> from <*> (bad password, <*> attempts)',
      weight: always(5),
      render: ({ r }) => {
        const ip = pick(r, CLIENT_IPS);
        const user = userId(r);
        return {
          message: `Failed sign-in for ${user} from ${ip} (bad password, ${int(r, 1, 5)} attempts)`,
          clientIp: ip,
          fields: { user_id: user },
        };
      },
    },
  ],
  postgres: [
    {
      id: 'postgres.checkpoint',
      level: 'info',
      pattern:
        '<*> UTC [<*>] LOG:  checkpoint complete: wrote <*> buffers (<*>%); <*> WAL file(s) added',
      weight: always(10),
      render: ({ r, t }) => ({
        message: `${pgTime(t)} [${int(r, 100, 9999)}] LOG:  checkpoint complete: wrote ${int(r, 200, 4000)} buffers (${(r() * 20).toFixed(1)}%); ${int(r, 0, 3)} WAL file(s) added`,
      }),
    },
    {
      id: 'postgres.slow',
      level: 'warn',
      pattern: '<*> UTC [<*>] LOG:  duration: <*> ms  statement: <*>',
      weight: (i) => 12 + 30 * i,
      render: ({ r, t }) => {
        const stmt = pick(r, [
          'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20',
          'UPDATE inventory SET reserved = reserved + $1 WHERE sku = $2',
          'SELECT p.* FROM products p JOIN categories c ON c.id = p.category_id WHERE c.slug = $1',
          'INSERT INTO payments (order_id, amount, currency, status) VALUES ($1, $2, $3, $4)',
        ]);
        const ms = (int(r, 500, 4000) + r()).toFixed(3);
        return {
          message: `${pgTime(t)} [${int(r, 100, 9999)}] LOG:  duration: ${ms} ms  statement: ${stmt}`,
          fields: { duration_ms: String(Math.round(Number(ms))) },
        };
      },
    },
    {
      id: 'postgres.conn_slots',
      level: 'fatal',
      pattern:
        '<*> UTC [<*>] FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute',
      weight: (i) => 40 * i,
      render: ({ r, t }) => ({
        message: `${pgTime(t)} [${int(r, 100, 9999)}] FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute`,
      }),
    },
    {
      id: 'postgres.autovacuum',
      level: 'info',
      pattern: '<*> UTC [<*>] LOG:  automatic vacuum of table "<*>": index scans: <*>',
      weight: always(6),
      render: ({ r, t }) => ({
        message: `${pgTime(t)} [${int(r, 100, 9999)}] LOG:  automatic vacuum of table "shop.public.${pick(r, ['orders', 'carts', 'sessions', 'inventory'])}": index scans: ${int(r, 0, 2)}`,
      }),
    },
  ],
  valkey: [
    {
      id: 'valkey.save',
      level: 'info',
      pattern: '1:M <*> * <*> changes in 300 seconds. Saving...',
      weight: always(10),
      render: ({ r, t }) => ({
        message: `1:M ${new Date(t).toUTCString().slice(5, 25)} * ${int(r, 100, 2000)} changes in 300 seconds. Saving...`,
      }),
    },
    {
      id: 'valkey.saved',
      level: 'info',
      pattern: '1:M <*> * Background saving terminated with success',
      weight: always(10),
      render: ({ t }) => ({
        message: `1:M ${new Date(t).toUTCString().slice(5, 25)} * Background saving terminated with success`,
      }),
    },
  ],
  'otel-collector': [
    {
      id: 'otel.export',
      level: 'info',
      pattern: 'Exporting <*> batch: <*> items',
      weight: always(10),
      render: ({ r }) => {
        const signal = pick(r, ['logs', 'traces', 'metrics']);
        return {
          message: `Exporting ${signal} batch: ${int(r, 50, 2000)} items`,
          fields: { otel_signal: signal },
        };
      },
    },
    {
      id: 'otel.retry',
      level: 'warn',
      pattern:
        'Exporting failed. Will retry the request after interval. error="<*>" interval="<*>s"',
      weight: always(0.4),
      render: ({ r }) => ({
        message: `Exporting failed. Will retry the request after interval. error="rpc error: code = Unavailable desc = connection reset" interval="${(r() * 5 + 1).toFixed(1)}s"`,
      }),
    },
  ],
  'nightly-export': [
    {
      id: 'export.progress',
      level: 'info',
      pattern: 'Exported <*> orders to s3://harborline-exports/<*>/orders-<*>.parquet',
      weight: always(20),
      render: ({ r, t }) => {
        const day = new Date(t).toISOString().slice(0, 10);
        return {
          message: `Exported ${int(r, 1000, 9000)} orders to s3://harborline-exports/${day}/orders-${int(r, 1, 40)}.parquet`,
        };
      },
    },
    {
      id: 'export.slow',
      level: 'warn',
      pattern: 'Export batch <*> took <*>s, above the 30s budget',
      weight: always(2),
      render: ({ r }) => ({
        message: `Export batch ${int(r, 1, 40)} took ${int(r, 31, 90)}s, above the 30s budget`,
      }),
    },
  ],
};

/** Every template, for Patterns and the SQL demo's fields. */
export const ALL_TEMPLATES = Object.entries(TEMPLATES).flatMap(([service, list]) =>
  list.map((template) => ({ service, ...template })),
);

export const patternHashOf = (templateId: string) => hex(hashString(templateId), 16);

const templateById = new Map(ALL_TEMPLATES.map((template) => [template.id, template]));
export const templateFor = (id: string) => templateById.get(id);

function workloadFields(workload: Workload, t: number, r: Rng): Record<string, string> {
  const pods = podsFor(workload, t);
  const pod = pods[Math.floor(r() * pods.length)];
  const fields: Record<string, string> = {
    service_name: workload.service,
    service_version: workload.version,
    deployment_environment: 'production',
    k8s_cluster_name: CLUSTER,
    k8s_namespace_name: workload.namespace,
    k8s_pod_name: pod.name,
    k8s_node_name: pod.node,
    k8s_container_name: workload.container,
  };
  fields[`k8s_${workload.kind}_name`] = workload.name;
  if (pod.replicaSet) fields.k8s_replicaset_name = pod.replicaSet;
  return fields;
}

const isNightlyExport = (t: number) => {
  const minuteOfDay = (t % 86_400_000) / 60_000;
  return minuteOfDay >= 120 && minuteOfDay < 140;
};

const projectSalt = (projectId: string) => (projectId === PROJECT_ID ? 0 : hashString(projectId));
/** The staging project is a fraction of production's volume. */
const projectScale = (projectId: string) => (projectId === PROJECT_ID ? 1 : 0.08);

/** Mean log count of one slot, before the per-slot Poisson draw. */
export function slotMean(slot: number, projectId: string): number {
  const t = slot * SLOT_MS;
  const incident = incidentLevel(t);
  return BASE_RATE * (SLOT_MS / 1000) * traffic(t) * (1 + 0.6 * incident) * projectScale(projectId);
}

const cache = new Map<string, GenLog[]>();
const CACHE_LIMIT = 4000;

/** One slot's logs, oldest first. Empty before the demo's data start or after now. */
export function slotLogs(slot: number, projectId: string = PROJECT_ID, now = Date.now()): GenLog[] {
  const t0 = slot * SLOT_MS;
  if (t0 > now || t0 + SLOT_MS < dataStart(now)) return [];
  const key = `${projectId}:${slot}`;
  const hit = cache.get(key);
  // The newest slot is still filling, so it's never cached.
  if (hit && t0 + SLOT_MS <= now) return hit;

  const salt = projectSalt(projectId);
  const r = rng(mix(slot, salt, 17));
  const count = poisson(r, slotMean(slot, projectId));
  const incident = incidentLevel(t0);
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(Math.floor(r() * SLOT_MS));
  offsets.sort((a, b) => a - b);

  const serviceWeights = WORKLOADS.map((w) => {
    let weight = w.logWeight;
    if (incident > 0 && (w.service === 'payments' || w.service === 'checkout'))
      weight *= 1 + 1.5 * incident;
    if (incident > 0 && w.service === 'postgres') weight *= 1 + 2 * incident;
    return [w.service, weight] as const;
  });
  const nightly = isNightlyExport(t0);
  if (nightly) serviceWeights.push(['nightly-export', 8]);

  const logs: GenLog[] = [];
  for (let i = 0; i < count; i++) {
    const t = t0 + offsets[i];
    if (t > now) break;
    const service = weighted(r, serviceWeights);
    const templates = TEMPLATES[service];
    const template = weighted(
      r,
      templates.map((tpl) => [tpl, Math.max(0, tpl.weight(incident))] as const),
    );
    const [lo, hi] = LOG_TRACE_OFFSET[template.id] ?? [1, 400];
    const traceId = traceIdAt(t - int(r, lo, hi), mix(slot, i, salt));
    const rendered = template.render({ r, t, incident, traceId });
    const workload = workloadByService.get(service);
    const fields: Record<string, string> = workload
      ? workloadFields(workload, t, r)
      : { service_name: service, host_name: BATCH_HOST, deployment_environment: 'production' };
    if (projectId !== PROJECT_ID) fields.deployment_environment = 'staging';
    Object.assign(fields, rendered.fields);
    const log: GenLog = {
      id: `${slot.toString(36)}-${i.toString(36)}${salt ? `-${(salt % 1296).toString(36)}` : ''}`,
      projectId,
      ts: t,
      timestamp: new Date(t).toISOString(),
      level: template.level,
      message: rendered.message,
      fields,
      clientIp: rendered.clientIp,
      patternHash: patternHashOf(template.id),
      template: template.id,
    };
    if (template.traced) {
      log.traceId = traceId;
      log.spanId = spanIdFor(traceId, service);
    }
    logs.push(log);
  }
  if (t0 + SLOT_MS <= now) {
    if (cache.size > CACHE_LIMIT) cache.clear();
    cache.set(key, logs);
  }
  return logs;
}

export const slotOf = (t: number) => Math.floor(t / SLOT_MS);

/** Finds a generated log by id (ids encode their slot). */
export function logById(id: string, projectId: string = PROJECT_ID): GenLog | undefined {
  const slot = parseInt(id.split('-')[0], 36);
  if (!Number.isFinite(slot)) return undefined;
  return slotLogs(slot, projectId).find((log) => log.id === id);
}

/**
 * Walks logs in a range newest first (or oldest first), calling visit for
 * each; visit returns false to stop. Stops after maxRows generated rows and
 * reports where it got to.
 */
export function walkLogs(
  projectId: string,
  from: number,
  to: number,
  order: 'asc' | 'desc',
  visit: (log: GenLog) => boolean,
  maxRows = 400_000,
): { complete: boolean; reached: number } {
  const now = Date.now();
  const start = Math.max(from, dataStart(now));
  const end = Math.min(to, now);
  let generated = 0;
  if (start > end) return { complete: true, reached: from };
  const first = slotOf(start);
  const last = slotOf(end);
  for (let k = 0; k <= last - first; k++) {
    const slot = order === 'desc' ? last - k : first + k;
    const logs = slotLogs(slot, projectId, now);
    generated += logs.length;
    for (let j = 0; j < logs.length; j++) {
      const log = logs[order === 'desc' ? logs.length - 1 - j : j];
      if (log.ts < from || log.ts > to) continue;
      if (!visit(log)) return { complete: false, reached: log.ts };
    }
    if (generated > maxRows) {
      return { complete: false, reached: order === 'desc' ? slot * SLOT_MS : (slot + 1) * SLOT_MS };
    }
  }
  return { complete: true, reached: order === 'desc' ? from : to };
}

/**
 * Counts matching logs per bucket. Ranges too long to generate in full are
 * sampled: up to `samplesPerBucket` slots per bucket, scaled up by the
 * slot-mean ratio. Results are deterministic, so a chart doesn't jitter.
 */
export function countLogs(
  projectId: string,
  from: number,
  to: number,
  bucketMs: number,
  predicate: (log: GenLog) => boolean,
  groupBy?: (log: GenLog) => string,
  samplesPerBucket = 24,
): Map<number, Map<string, number>> {
  const now = Date.now();
  const out = new Map<number, Map<string, number>>();
  const start = Math.max(from, dataStart(now));
  const end = Math.min(to, now);
  if (start > end) return out;
  const firstBucket = Math.floor(start / bucketMs) * bucketMs;
  for (let bucket = firstBucket; bucket <= end; bucket += bucketMs) {
    const bucketStart = Math.max(bucket, start);
    const bucketEnd = Math.min(bucket + bucketMs - 1, end);
    const firstSlot = slotOf(bucketStart);
    const lastSlot = slotOf(bucketEnd);
    const slots = lastSlot - firstSlot + 1;
    const step = Math.max(1, Math.floor(slots / samplesPerBucket));
    const groups = new Map<string, number>();
    let sampledMean = 0;
    let fullMean = 0;
    for (let s = firstSlot; s <= lastSlot; s++) fullMean += slotMean(s, projectId);
    for (let s = firstSlot; s <= lastSlot; s += step) {
      sampledMean += slotMean(s, projectId);
      for (const log of slotLogs(s, projectId, now)) {
        if (log.ts < bucketStart || log.ts > bucketEnd || !predicate(log)) continue;
        const key = groupBy ? groupBy(log) : '';
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
    }
    const scale = step === 1 || sampledMean === 0 ? 1 : fullMean / sampledMean;
    if (scale !== 1) for (const [key, count] of groups) groups.set(key, Math.round(count * scale));
    out.set(bucket, groups);
  }
  return out;
}

/** Total matching logs in a range (sampled for long ranges). */
export function totalLogs(
  projectId: string,
  from: number,
  to: number,
  predicate: (log: GenLog) => boolean,
): number {
  const span = Math.max(1, to - from);
  const bucketMs = Math.max(SLOT_MS, Math.ceil(span / 60 / SLOT_MS) * SLOT_MS);
  let total = 0;
  for (const groups of countLogs(projectId, from, to, bucketMs, predicate).values()) {
    for (const count of groups.values()) total += count;
  }
  return total;
}

export const toLogItem = (log: GenLog) => ({
  id: log.id,
  projectId: log.projectId,
  timestamp: log.timestamp,
  level: log.level,
  message: log.message,
  fields: log.fields,
  clientIp: log.clientIp,
  createdAt: new Date(log.ts + 800).toISOString(),
  traceId: log.traceId,
  spanId: log.spanId,
  patternHash: log.patternHash,
});

/** A representative message for a template (Patterns and Anomalies samples). */
export function sampleMessage(templateId: string, t = Date.now()): string {
  const template = templateById.get(templateId);
  if (!template) return '';
  const r = rng(hashString(templateId));
  return template.render({ r, t, incident: 1, traceId: traceIdAt(t, 1) }).message;
}
