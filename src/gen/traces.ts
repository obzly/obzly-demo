// Sample traces, derived from the logs: every traced log line (gen/logs.ts)
// stands for one request, and that request's trace is regenerated from the
// trace id alone. The id carries the start time (world.traceTime) and seeds
// the PRNG; the log it came from (found again by scanning the one or two
// 10-second slots after the start) picks the flow, so a "payment timeout"
// log opens a trace that really timed out, and the log's span id is exactly
// the first span of its service in the trace (world.spanIdFor(id, service, 0)).
//
// Requests enter at ingress-nginx and follow world.CALLS: storefront calls
// auth, catalog, search and checkout; checkout calls inventory and payments;
// Postgres and Valkey show up as client spans (they aren't instrumented),
// like a real OpenTelemetry setup. During the recurring incident payments
// waits on its exhausted connection pool: checkout slows down and fails.
import type { AggregationBucket, Panel } from '../../entity/dashboards';
import type { Span, TraceSummary } from '../../entity/traces';
import { type Rng, hashString, hex, int, mix, pick, rng, uuidFrom, weighted } from '../lib/rng';
import { DemoError } from '../router';
import {
  CLIENT_IPS,
  CLUSTER,
  NODES,
  PROJECT_ID,
  REGION,
  dataStart,
  incidentLevel,
  incidentsBetween,
  podsFor,
  spanIdFor,
  traceTime,
  traffic,
  workloadByService,
} from '../world';
import {
  EMBEDDING,
  GPT_MINI,
  HAIKU,
  LLM_GATEWAY,
  type LlmSpan,
  SONNET,
  llmSpansBetween,
} from './aiUsage';
import { type GenLog, SLOT_MS, slotLogs, slotMean, slotOf } from './logs';

const HOUR = 3_600_000;
/** Share of requests where a cache call times out (handled: the request still succeeds). */
export const LEAF_ERROR_RATE = 0.0015;

export function resolveRange(range: { from?: string; to?: string } | undefined, fallbackMs = HOUR) {
  const to = range?.to ? Date.parse(range.to) : Date.now();
  const from = range?.from ? Date.parse(range.from) : to - fallbackMs;
  if (!Number.isFinite(from) || !Number.isFinite(to))
    throw new DemoError(400, 'Invalid time range');
  return { from, to };
}

// ---------------------------------------------------------------------------
// Plans: which request a trace is, decided cheaply before building it.
// ---------------------------------------------------------------------------

export type Flow =
  | 'home'
  | 'products'
  | 'product'
  | 'search'
  | 'cart'
  | 'addToCart'
  | 'checkout'
  | 'account'
  | 'login';

/** How a checkout goes: fine, slow (pool contention), declined, or failing. */
export type Mode = 'ok' | 'slow' | 'declined' | 'pool' | 'timeout' | 'retry';

export interface Plan {
  flow: Flow;
  mode: Mode;
  /** The browser has a session cookie, so storefront validates it with auth. */
  session: boolean;
  /** A cache call in this service times out (the request still succeeds). */
  leaf?: 'catalog' | 'search' | 'auth';
  slowService?: string;
  slowMs?: number;
  paymentsMs?: number;
  catalogMs?: number;
  renderMs?: number;
  productId?: string;
  query?: string;
  orderId?: string;
}

/** What a traced log says about its request. */
export interface TraceHint {
  service: string;
  template: string;
  fields: Record<string, string>;
  /** The log's time: the service's span is laid out to contain it. */
  ts?: number;
}

export const FLOW_ROUTE: Record<Flow, readonly [string, string]> = {
  home: ['GET', '/'],
  products: ['GET', '/products'],
  product: ['GET', '/products/:id'],
  search: ['GET', '/search'],
  cart: ['GET', '/cart'],
  addToCart: ['POST', '/cart/items'],
  checkout: ['POST', '/checkout'],
  account: ['GET', '/account'],
  login: ['POST', '/login'],
};

const FLOW_SERVICES: Record<Flow, string[]> = {
  home: ['catalog'],
  products: ['catalog'],
  product: ['catalog'],
  search: ['search'],
  cart: ['checkout'],
  addToCart: ['checkout', 'inventory'],
  checkout: ['checkout', 'inventory', 'payments'],
  account: ['auth', 'checkout'],
  login: ['auth'],
};

const GENERIC_FLOWS: (readonly [Flow, number])[] = [
  ['product', 30],
  ['products', 12],
  ['home', 10],
  ['search', 14],
  ['cart', 8],
  ['addToCart', 7],
  ['checkout', 9],
  ['account', 4],
  ['login', 6],
];

const RENDER_FLOW: Record<string, Flow> = {
  '/': 'home',
  '/products': 'products',
  '/products/:id': 'product',
  '/cart': 'cart',
  '/search': 'search',
};

const SERVICE_FLOW: Record<string, Flow> = {
  storefront: 'product',
  checkout: 'checkout',
  payments: 'checkout',
  inventory: 'checkout',
  catalog: 'product',
  search: 'search',
  auth: 'login',
};

/** A per-id roll, separate from the PRNG, so callers can find leaf-error traces cheaply. */
export const leafRoll = (traceId: string) => (mix(hashString(traceId), 0x1eaf) % 100_000) / 100_000;

function checkoutMode(r: Rng, incident: number): Mode {
  const roll = r();
  if (incident > 0) {
    if (roll < 0.32 * incident) return 'pool';
    if (roll < 0.45 * incident) return 'timeout';
    if (roll < 0.55 * incident) return 'retry';
    if (roll < 0.9 * incident) return 'slow';
  }
  if (roll > 0.97) return 'declined';
  if (roll > 0.968) return 'retry';
  return 'ok';
}

const num = (value: string | undefined) => {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export const planHasErrors = (plan: Plan) =>
  plan.mode === 'pool' || plan.mode === 'timeout' || plan.mode === 'retry' || !!plan.leaf;

export function planServices(plan: Plan): string[] {
  const services = ['ingress-nginx', 'storefront'];
  if (plan.session) services.push('auth');
  for (const s of FLOW_SERVICES[plan.flow]) if (!services.includes(s)) services.push(s);
  return services;
}

export function planTrace(traceId: string, hint?: TraceHint): Plan {
  const r = rng(mix(hashString(traceId), 1));
  const incident = incidentLevel(traceTime(traceId));
  const f = hint?.fields ?? {};
  const base = (flow: Flow, mode: Mode = 'ok'): Plan => ({ flow, mode, session: false });
  let plan: Plan;
  switch (hint?.template) {
    case 'storefront.render':
      plan = { ...base(RENDER_FLOW[f.http_route] ?? 'product'), renderMs: num(f.duration_ms) };
      break;
    case 'storefront.checkout_failed':
      plan = base('checkout', f.http_status_code === '504' ? 'timeout' : 'pool');
      break;
    case 'storefront.slow_api': {
      const upstream = f.upstream;
      const flow: Flow =
        upstream === 'search' ? 'search' : upstream === 'checkout' ? 'checkout' : 'product';
      plan = {
        ...base(flow, flow === 'checkout' ? 'slow' : 'ok'),
        slowService: upstream,
        slowMs: num(f.duration_ms),
      };
      break;
    }
    case 'checkout.order_placed':
      plan = {
        ...base('checkout', incident > 0 && r() < incident ? 'slow' : 'ok'),
        orderId: f.order_id,
      };
      break;
    case 'checkout.payment_timeout':
      plan = { ...base('checkout', 'timeout'), orderId: f.order_id };
      break;
    case 'checkout.retry':
      plan = { ...base('checkout', 'retry'), orderId: f.order_id };
      break;
    case 'payments.authorized':
      plan = { ...base('checkout', incident > 0 ? 'slow' : 'ok'), paymentsMs: num(f.duration_ms) };
      break;
    case 'payments.pool_exhausted':
      plan = base('checkout', 'pool');
      break;
    case 'payments.declined':
      plan = base('checkout', 'declined');
      break;
    case 'catalog.served':
      plan = { ...base('product'), productId: f.product_id, catalogMs: num(f.duration_ms) };
      break;
    case 'inventory.reserved':
      plan = { ...base('checkout', checkoutMode(r, incident)), orderId: f.order_id };
      break;
    case 'search.query':
      plan = { ...base('search'), query: f.search_query };
      break;
    case 'auth.signin':
      plan = base('login');
      break;
    default: {
      const flow = (hint && SERVICE_FLOW[hint.service]) || weighted(r, GENERIC_FLOWS);
      plan = base(flow, flow === 'checkout' ? checkoutMode(r, incident) : 'ok');
    }
  }
  plan.session =
    plan.flow === 'login'
      ? false
      : ['account', 'cart', 'addToCart', 'checkout'].includes(plan.flow) || r() < 0.55;
  if (!planHasErrors(plan) && leafRoll(traceId) < LEAF_ERROR_RATE) {
    if (plan.flow === 'product' || plan.flow === 'products' || plan.flow === 'home')
      plan.leaf = 'catalog';
    else if (plan.flow === 'search') plan.leaf = 'search';
    else if (plan.session && plan.flow !== 'account') plan.leaf = 'auth';
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Building: a tree of nodes, then laid out in time.
// ---------------------------------------------------------------------------

export type SpanKind = 'SERVER' | 'CLIENT' | 'INTERNAL';
export type SpanStatus = 'UNSET' | 'OK' | 'ERROR';

export interface GenSpan {
  spanId: string;
  parentSpanId?: string;
  parentService?: string;
  name: string;
  service: string;
  kind: SpanKind;
  start: number;
  end: number;
  status: SpanStatus;
  message?: string;
  attrs: Record<string, unknown>;
  events?: { name: string; time: number; attributes: Record<string, unknown> }[];
}

export interface GenTrace {
  traceId: string;
  projectId: string;
  start: number;
  plan: Plan;
  spans: GenSpan[];
}

interface Exception {
  type: string;
  message: string;
  stacktrace?: string;
}

interface Node {
  service: string;
  name: string;
  kind: SpanKind;
  attrs: Record<string, unknown>;
  /** Gap after the previous sibling (or the parent's start), ms. */
  lead: number;
  /** A leaf's duration, or a parent's time after its last child, ms. */
  self: number;
  minDur?: number;
  /** A client gives up after this long; the callee may run on. */
  timeout?: number;
  status?: SpanStatus;
  message?: string;
  exception?: Exception;
  /** A fixed span id (the LLM call rows carry their own). */
  spanId?: string;
  children: Node[];
}

interface Ctx {
  r: Rng;
  plan: Plan;
  incident: number;
  /** Mild latency factor from the traffic curve. */
  load: number;
  /** Postgres latency factor (the incident slows the database for everyone). */
  pg: number;
}

const between = (r: Rng, min: number, max: number) => min + r() * (max - min);

function node(
  service: string,
  name: string,
  kind: SpanKind,
  attrs: Record<string, unknown>,
  options: Partial<Node> = {},
  children: Node[] = [],
): Node {
  return { service, name, kind, attrs, lead: 0.1, self: 0.2, children, ...options };
}

/** The LLM-backed support chat (gen/aiUsage.ts); not one of world.WORKLOADS. */
export const SUPPORT_ASSISTANT = {
  service: 'support-assistant',
  namespace: 'support',
  deployment: 'support-assistant',
  version: '0.9.3',
};

export const namespaceOf = (service: string) =>
  service === SUPPORT_ASSISTANT.service
    ? SUPPORT_ASSISTANT.namespace
    : workloadByService.get(service)?.namespace;

const host = (service: string) =>
  `${service}.${namespaceOf(service) ?? 'default'}.svc.cluster.local`;
const PUBLIC_HOST = 'shop.harborline.example.com';
const PSP_HOST = 'api.psp.example.com';

const GO_SCOPES = {
  grpc: 'go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc',
  http: 'go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp',
  pg: 'github.com/exaring/otelpgx',
  valkey: 'github.com/valkey-io/valkey-go/valkeyotel',
};
const PY_SCOPES = {
  server: 'opentelemetry.instrumentation.fastapi',
  pg: 'opentelemetry.instrumentation.asyncpg',
  valkey: 'opentelemetry.instrumentation.redis',
};
const SCOPES: Record<string, Record<string, string>> = {
  'ingress-nginx': { server: 'nginx' },
  storefront: {
    server: '@opentelemetry/instrumentation-http',
    http: '@opentelemetry/instrumentation-undici',
    grpc: '@opentelemetry/instrumentation-grpc',
    internal: 'harborline-storefront',
  },
  checkout: GO_SCOPES,
  inventory: GO_SCOPES,
  auth: { ...GO_SCOPES, internal: 'harborline/auth' },
  payments: {
    server: 'io.opentelemetry.spring-webmvc-6.0',
    http: 'io.opentelemetry.java-http-client',
    pg: 'io.opentelemetry.jdbc',
    pool: 'io.opentelemetry.hikaricp-3.0',
    internal: 'io.opentelemetry.opentelemetry-instrumentation-annotations-1.16',
  },
  catalog: { ...PY_SCOPES, internal: 'harborline.catalog.jobs' },
  search: PY_SCOPES,
  'support-assistant': { ...PY_SCOPES, internal: 'harborline.support' },
};
const scope = (service: string, what: string) =>
  SCOPES[service]?.[what] ?? SCOPES[service]?.server ?? 'unknown';

const CACHE_TIMEOUT: Record<string, Exception> = {
  catalog: {
    type: 'redis.exceptions.TimeoutError',
    message: 'Timeout reading from socket',
    stacktrace:
      'Traceback (most recent call last):\n  File "/app/catalog/cache.py", line 41, in get_product\n    raw = await self.client.get(key)\n  File "/usr/local/lib/python3.12/site-packages/redis/asyncio/connection.py", line 569, in read_response\n    raise TimeoutError("Timeout reading from socket")\nredis.exceptions.TimeoutError: Timeout reading from socket',
  },
  search: {
    type: 'redis.exceptions.TimeoutError',
    message: 'Timeout reading from socket',
  },
  auth: {
    type: '*net.OpError',
    message: 'read tcp 10.20.2.41:51544->10.20.3.17:6379: i/o timeout',
  },
};

function valkey(c: Ctx, caller: string, op: string, key: string, fail = false): Node {
  const attrs: Record<string, unknown> = {
    scope_name: scope(caller, 'valkey'),
    db_system_name: 'valkey',
    db_operation_name: op,
    db_query_text: `${op} ${key}`,
    server_address: host('valkey'),
    server_port: 6379,
  };
  if (fail) {
    const exception = CACHE_TIMEOUT[caller] ?? CACHE_TIMEOUT.auth;
    return node(
      caller,
      op,
      'CLIENT',
      { ...attrs, error_type: 'timeout' },
      {
        lead: between(c.r, 0.05, 0.3),
        self: between(c.r, 100, 250),
        status: 'ERROR',
        message: exception.message,
        exception,
      },
    );
  }
  return node(caller, op, 'CLIENT', attrs, {
    lead: between(c.r, 0.05, 0.3),
    self: between(c.r, 0.25, 1.4) * c.load,
  });
}

function pg(
  c: Ctx,
  caller: string,
  op: string,
  table: string,
  query: string,
  rows?: number,
  write = false,
): Node {
  const attrs: Record<string, unknown> = {
    scope_name: scope(caller, 'pg'),
    db_system_name: 'postgresql',
    db_namespace: 'harborline',
    db_collection_name: table,
    db_operation_name: op,
    db_query_text: query,
    server_address: host('postgres'),
    server_port: 5432,
  };
  if (rows !== undefined) attrs.db_response_returned_rows = rows;
  return node(caller, `${op} ${table}`, 'CLIENT', attrs, {
    lead: between(c.r, 0.05, 0.4),
    self: (write ? between(c.r, 1.5, 9) : between(c.r, 0.8, 6)) * c.pg,
  });
}

const GRPC_SERVER_ERRORS = new Set([2, 4, 12, 13, 14, 15]);

function grpc(
  c: Ctx,
  caller: string,
  callee: string,
  service: string,
  method: string,
  children: Node[],
  options: {
    code?: number;
    message?: string;
    serverMin?: number;
    attrs?: Record<string, unknown>;
  } = {},
): Node {
  const code = options.code ?? 0;
  const name = `${service}/${method}`;
  const rpc = { rpc_system: 'grpc', rpc_service: service, rpc_method: method };
  const server = node(
    callee,
    name,
    'SERVER',
    { scope_name: scope(callee, 'grpc'), ...rpc, rpc_grpc_status_code: code, ...options.attrs },
    {
      lead: between(c.r, 0.2, 0.8),
      self: between(c.r, 0.3, 2) * c.load,
      minDur: options.serverMin,
      status: GRPC_SERVER_ERRORS.has(code) ? 'ERROR' : 'UNSET',
      message: code ? options.message : undefined,
    },
    children,
  );
  return node(
    caller,
    name,
    'CLIENT',
    {
      scope_name: scope(caller, 'grpc'),
      ...rpc,
      rpc_grpc_status_code: code,
      server_address: host(callee),
      server_port: 50051,
    },
    {
      lead: between(c.r, 0.1, 0.6),
      self: between(c.r, 0.2, 0.7),
      status: code ? 'ERROR' : 'UNSET',
      message: code ? options.message : undefined,
    },
    [server],
  );
}

function http(
  c: Ctx,
  caller: string,
  callee: string,
  method: string,
  route: string,
  path: string,
  status: number,
  children: Node[],
  options: {
    query?: string;
    serverMin?: number;
    timeout?: number;
    lead?: number;
    exception?: Exception;
  } = {},
): Node {
  const query = options.query ? `?${options.query}` : '';
  const serverAttrs: Record<string, unknown> = {
    scope_name: scope(callee, 'server'),
    http_request_method: method,
    http_route: route,
    url_path: path,
    url_scheme: 'http',
    server_address: host(callee),
    server_port: 8080,
    network_protocol_version: '1.1',
    http_response_status_code: status,
  };
  if (options.query) serverAttrs.url_query = options.query;
  const server = node(
    callee,
    `${method} ${route}`,
    'SERVER',
    serverAttrs,
    {
      lead: between(c.r, 0.2, 0.9),
      self: between(c.r, 0.2, 1.5) * c.load,
      minDur: options.serverMin,
      status: status >= 500 ? 'ERROR' : 'UNSET',
      message: status >= 500 ? options.exception?.message : undefined,
      exception: options.exception,
    },
    children,
  );
  const timedOut = options.timeout !== undefined;
  const clientAttrs: Record<string, unknown> = {
    scope_name: scope(caller, 'http'),
    http_request_method: method,
    url_full: `http://${host(callee)}:8080${path}${query}`,
    server_address: host(callee),
    server_port: 8080,
  };
  if (timedOut) clientAttrs.error_type = 'timeout';
  else {
    clientAttrs.http_response_status_code = status;
    if (status >= 400) clientAttrs.error_type = String(status);
  }
  return node(
    caller,
    method,
    'CLIENT',
    clientAttrs,
    {
      lead: options.lead ?? between(c.r, 0.1, 0.6),
      self: between(c.r, 0.2, 0.8),
      timeout: options.timeout,
      status: timedOut || status >= 400 ? 'ERROR' : 'UNSET',
      message: timedOut ? 'context deadline exceeded' : undefined,
    },
    [server],
  );
}

const CHECKOUT_SVC = 'harborline.checkout.v1.CheckoutService';
const INVENTORY_SVC = 'harborline.inventory.v1.InventoryService';
const AUTH_SVC = 'harborline.auth.v1.AuthService';
const CATEGORIES = ['shoes', 'jackets', 'accessories', 'outdoor', 'shirts', 'featured'];
const QUERIES = ['trail running shoes', 'rain jacket', 'merino socks', 'travel mug', 'wool beanie'];

const HIKARI_STACK =
  'java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out\n\tat com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:686)\n\tat com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:179)\n\tat com.zaxxer.hikari.HikariDataSource.getConnection(HikariDataSource.java:100)\n\tat com.harborline.payments.PaymentRepository.save(PaymentRepository.java:58)\n\tat com.harborline.payments.PaymentService.authorize(PaymentService.java:112)';

function paymentsCall(c: Ctx, outcome: Mode, lead?: number): Node {
  const { r, plan } = c;
  const psp = between(r, 80, 240) * c.load;
  let wait = 0;
  if (outcome === 'slow') {
    if (plan.paymentsMs) wait = Math.max(150, plan.paymentsMs - psp - 15);
    else if (plan.slowMs) wait = Math.max(300, plan.slowMs - psp - 60);
    else wait = between(r, 1200, 3800) * Math.max(c.incident, 0.4);
  } else if (outcome === 'ok' && c.incident > 0) {
    wait = between(r, 30, 400) * c.incident;
  } else if (outcome === 'pool') {
    wait = between(r, 3000, 4800);
  } else if (outcome === 'timeout') {
    wait = between(r, 5200, 6000);
  }
  const failed = outcome === 'pool' || outcome === 'timeout';
  const poolMessage = `HikariPool-1 - Connection is not available, request timed out after ${Math.round(wait)}ms (total=20, active=20, idle=0, waiting=${int(r, 4, 48)})`;
  const exception: Exception | undefined = failed
    ? {
        type: 'java.sql.SQLTransientConnectionException',
        message: poolMessage,
        stacktrace: HIKARI_STACK,
      }
    : undefined;
  const kids: Node[] = [];
  if (wait > 0) {
    kids.push(
      node(
        'payments',
        'HikariDataSource.getConnection',
        'INTERNAL',
        {
          scope_name: scope('payments', 'pool'),
          db_client_connection_pool_name: 'HikariPool-1',
          db_system_name: 'postgresql',
        },
        {
          lead: between(r, 0.1, 0.4),
          self: wait,
          status: failed ? 'ERROR' : 'UNSET',
          message: failed ? poolMessage : undefined,
          exception,
        },
      ),
    );
  }
  const method = pick(r, ['card', 'card', 'card', 'paypal', 'sepa']);
  if (!failed) {
    kids.push(
      pg(
        c,
        'payments',
        'SELECT',
        'shop.payments',
        'SELECT id, status FROM shop.payments WHERE idempotency_key = ?',
        0,
      ),
      node(
        'payments',
        'POST',
        'CLIENT',
        {
          scope_name: scope('payments', 'http'),
          http_request_method: 'POST',
          url_full: `https://${PSP_HOST}/v1/authorizations`,
          server_address: PSP_HOST,
          server_port: 443,
          http_response_status_code: 200,
        },
        { lead: between(r, 0.2, 1), self: psp },
      ),
      pg(
        c,
        'payments',
        'INSERT',
        'shop.payments',
        'INSERT INTO shop.payments (id, order_id, amount, currency, status) VALUES (?, ?, ?, ?, ?)',
        undefined,
        true,
      ),
    );
  }
  const inner = node(
    'payments',
    'PaymentService.authorize',
    'INTERNAL',
    {
      scope_name: scope('payments', 'internal'),
      code_function_name: 'com.harborline.payments.PaymentService.authorize',
      payment_method: method,
      payment_outcome: failed ? 'error' : outcome === 'declined' ? 'declined' : 'authorized',
    },
    {
      lead: between(r, 0.3, 1),
      self: between(r, 0.5, 2),
      status: failed ? 'ERROR' : 'UNSET',
      message: failed ? poolMessage : undefined,
      exception,
    },
    kids,
  );
  return http(
    c,
    'checkout',
    'payments',
    'POST',
    '/v1/payments/authorize',
    '/v1/payments/authorize',
    failed ? 500 : 200,
    [inner],
    { timeout: outcome === 'timeout' ? 5000 : undefined, lead, exception },
  );
}

function checkoutCall(c: Ctx): { node: Node; status: number } {
  const { r, plan } = c;
  const cart = hex(mix(r() * 1e9), 6);
  const order = plan.orderId ?? `ORD-${int(r, 100000, 999999)}`;
  const kids: Node[] = [valkey(c, 'checkout', 'HGETALL', `cart:${cart}`)];
  kids.push(
    grpc(c, 'checkout', 'inventory', INVENTORY_SVC, 'ReserveStock', [
      pg(
        c,
        'inventory',
        'UPDATE',
        'shop.inventory',
        'UPDATE shop.inventory SET reserved = reserved + $1 WHERE sku = $2 AND stock - reserved >= $1',
        undefined,
        true,
      ),
    ]),
  );
  let failed: 'pool' | 'timeout' | undefined;
  if (plan.mode === 'retry') {
    kids.push(paymentsCall(c, 'pool'), paymentsCall(c, 'slow', between(r, 120, 260)));
  } else if (plan.mode === 'pool' || plan.mode === 'timeout') {
    failed = plan.mode;
    kids.push(paymentsCall(c, plan.mode));
  } else {
    kids.push(paymentsCall(c, plan.mode));
  }
  if (failed) {
    kids.push(
      grpc(c, 'checkout', 'inventory', INVENTORY_SVC, 'ReleaseStock', [
        pg(
          c,
          'inventory',
          'UPDATE',
          'shop.inventory',
          'UPDATE shop.inventory SET reserved = reserved - $1 WHERE sku = $2',
          undefined,
          true,
        ),
      ]),
    );
  } else if (plan.mode !== 'declined') {
    kids.push(
      pg(
        c,
        'checkout',
        'INSERT',
        'shop.orders',
        'INSERT INTO shop.orders (id, customer_id, total, currency, status) VALUES ($1, $2, $3, $4, $5)',
        undefined,
        true,
      ),
      pg(
        c,
        'checkout',
        'INSERT',
        'shop.order_items',
        'INSERT INTO shop.order_items (order_id, sku, quantity, price) VALUES ($1, $2, $3, $4)',
        undefined,
        true,
      ),
      valkey(c, 'checkout', 'DEL', `cart:${cart}`),
    );
  }
  const code = failed === 'timeout' ? 4 : failed === 'pool' ? 14 : 0;
  const message =
    failed === 'timeout'
      ? 'payment authorization failed: upstream timeout after 5000ms'
      : failed
        ? 'payment authorization failed: payments returned 500'
        : undefined;
  const status = failed === 'timeout' ? 504 : failed ? 502 : plan.mode === 'declined' ? 402 : 303;
  return {
    node: grpc(c, 'storefront', 'checkout', CHECKOUT_SVC, 'PlaceOrder', kids, {
      code,
      message,
      attrs: { order_id: order },
    }),
    status,
  };
}

function validateSession(c: Ctx): Node {
  const fail = c.plan.leaf === 'auth';
  const session = hex(mix(c.r() * 1e9), 12);
  const kids = [valkey(c, 'auth', 'GET', `session:${session}`, fail)];
  if (fail)
    kids.push(
      pg(
        c,
        'auth',
        'SELECT',
        'identity.sessions',
        'SELECT user_id, expires_at FROM identity.sessions WHERE id = $1',
        1,
      ),
    );
  return grpc(c, 'storefront', 'auth', AUTH_SVC, 'ValidateSession', kids);
}

function catalogProduct(c: Ctx, id: string): Node {
  const { r, plan } = c;
  const fail = plan.leaf === 'catalog';
  const hit = !fail && r() < 0.72;
  const kids = [valkey(c, 'catalog', 'GET', `product:${id}`, fail)];
  if (!hit)
    kids.push(
      pg(
        c,
        'catalog',
        'SELECT',
        'shop.products',
        'SELECT p.*, c.slug FROM shop.products p JOIN shop.categories c ON c.id = p.category_id WHERE p.id = $1',
        1,
      ),
      valkey(c, 'catalog', 'SET', `product:${id}`),
    );
  const minDur = plan.slowService === 'catalog' ? plan.slowMs : plan.catalogMs;
  return http(
    c,
    'storefront',
    'catalog',
    'GET',
    '/products/{product_id}',
    `/products/${id}`,
    200,
    kids,
    { serverMin: minDur },
  );
}

function catalogList(c: Ctx, category: string): Node {
  const fail = c.plan.leaf === 'catalog';
  const kids = [valkey(c, 'catalog', 'GET', `products:${category}:p1`, fail)];
  if (fail || c.r() < 0.25)
    kids.push(
      pg(
        c,
        'catalog',
        'SELECT',
        'shop.products',
        'SELECT id, name, price, image_url FROM shop.products WHERE category_id = $1 ORDER BY popularity DESC LIMIT 24',
        24,
      ),
      valkey(c, 'catalog', 'SET', `products:${category}:p1`),
    );
  return http(c, 'storefront', 'catalog', 'GET', '/products', '/products', 200, kids, {
    query: `category=${category}&page=1`,
  });
}

function searchCall(c: Ctx, query: string): Node {
  const { plan } = c;
  const fail = plan.leaf === 'search';
  const search = valkey(c, 'search', 'FT.SEARCH', `idx:products "${query}" LIMIT 0 20`, fail);
  if (!fail) search.self = between(c.r, 2, 25) * c.load;
  return http(c, 'storefront', 'search', 'GET', '/search', '/search', 200, [search], {
    query: `q=${encodeURIComponent(query)}`,
    serverMin: plan.slowService === 'search' ? plan.slowMs : undefined,
  });
}

const AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Harborline-iOS/4.12.0 CFNetwork/1568 Darwin/24.1.0',
];

function storefront(c: Ctx): { node: Node; status: number; path: string; query?: string } {
  const { r, plan } = c;
  const [method, route] = FLOW_ROUTE[plan.flow];
  const kids: Node[] = [];
  if (plan.session) kids.push(validateSession(c));
  let status = 200;
  let view: string | undefined;
  let path = route;
  let query: string | undefined;
  switch (plan.flow) {
    case 'home':
      kids.push(catalogList(c, 'featured'));
      view = 'home/index';
      break;
    case 'products': {
      const category = pick(r, CATEGORIES);
      kids.push(catalogList(c, category));
      query = `category=${category}`;
      view = 'products/index';
      break;
    }
    case 'product': {
      const id = plan.productId ?? String(int(r, 1000, 1999));
      path = `/products/${id}`;
      kids.push(catalogProduct(c, id));
      view = 'products/show';
      break;
    }
    case 'search': {
      const q = plan.query ?? pick(r, QUERIES);
      query = `q=${encodeURIComponent(q)}`;
      kids.push(searchCall(c, q));
      view = 'search/results';
      break;
    }
    case 'cart':
      kids.push(
        grpc(c, 'storefront', 'checkout', CHECKOUT_SVC, 'GetCart', [
          valkey(c, 'checkout', 'HGETALL', `cart:${hex(mix(r() * 1e9), 6)}`),
        ]),
      );
      view = 'cart/show';
      break;
    case 'addToCart': {
      const sku = `SKU-${int(r, 10000, 10999)}`;
      kids.push(
        grpc(
          c,
          'storefront',
          'checkout',
          CHECKOUT_SVC,
          'AddItem',
          [
            grpc(c, 'checkout', 'inventory', INVENTORY_SVC, 'CheckStock', [
              pg(
                c,
                'inventory',
                'SELECT',
                'shop.inventory',
                'SELECT stock, reserved FROM shop.inventory WHERE sku = $1',
                1,
              ),
            ]),
            valkey(c, 'checkout', 'HSET', `cart:${hex(mix(r() * 1e9), 6)}`),
          ],
          { attrs: { sku } },
        ),
      );
      status = 201;
      break;
    }
    case 'checkout': {
      const result = checkoutCall(c);
      kids.push(result.node);
      status = result.status;
      break;
    }
    case 'account':
      kids.push(
        grpc(c, 'storefront', 'auth', AUTH_SVC, 'GetProfile', [
          pg(
            c,
            'auth',
            'SELECT',
            'identity.users',
            'SELECT id, email, name, created_at FROM identity.users WHERE id = $1',
            1,
          ),
        ]),
        grpc(c, 'storefront', 'checkout', CHECKOUT_SVC, 'ListOrders', [
          pg(
            c,
            'checkout',
            'SELECT',
            'shop.orders',
            'SELECT id, status, total, currency, created_at FROM shop.orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20',
            int(r, 0, 20),
          ),
        ]),
      );
      view = 'account/show';
      break;
    case 'login':
      kids.push(
        grpc(c, 'storefront', 'auth', AUTH_SVC, 'SignIn', [
          pg(
            c,
            'auth',
            'SELECT',
            'identity.users',
            'SELECT id, password_hash FROM identity.users WHERE email = $1',
            1,
          ),
          node(
            'auth',
            'argon2id.Verify',
            'INTERNAL',
            { scope_name: scope('auth', 'internal') },
            { lead: between(r, 0.05, 0.2), self: between(r, 25, 60) },
          ),
          valkey(c, 'auth', 'SET', `session:${hex(mix(r() * 1e9), 12)}`),
          pg(
            c,
            'auth',
            'UPDATE',
            'identity.users',
            'UPDATE identity.users SET last_sign_in_at = now() WHERE id = $1',
            undefined,
            true,
          ),
        ]),
      );
      status = 303;
      break;
  }
  if (view)
    kids.push(
      node(
        'storefront',
        `render ${view}`,
        'INTERNAL',
        { scope_name: scope('storefront', 'internal'), template_name: view },
        { lead: between(r, 0.05, 0.3), self: between(r, 1.5, 25) * c.load },
      ),
    );
  const attrs: Record<string, unknown> = {
    scope_name: scope('storefront', 'server'),
    http_request_method: method,
    http_route: route,
    url_path: path,
    url_scheme: 'http',
    server_address: host('storefront'),
    server_port: 3000,
    network_protocol_version: '1.1',
    http_response_status_code: status,
  };
  if (query) attrs.url_query = query;
  const slowCheckout =
    plan.slowService === 'checkout' && plan.slowMs ? plan.slowMs + between(r, 5, 30) : undefined;
  return {
    node: node(
      'storefront',
      `${method} ${route}`,
      'SERVER',
      attrs,
      {
        lead: between(r, 0.3, 1.2),
        self: between(r, 0.5, 3) * c.load,
        minDur: plan.renderMs ?? slowCheckout,
        status: status >= 500 ? 'ERROR' : 'UNSET',
        message: status >= 500 ? `upstream checkout returned ${status}` : undefined,
      },
      kids,
    ),
    status,
    path,
    query,
  };
}

function ingress(c: Ctx): Node {
  const { r, plan } = c;
  const [method, route] = FLOW_ROUTE[plan.flow];
  const front = storefront(c);
  const attrs: Record<string, unknown> = {
    scope_name: scope('ingress-nginx', 'server'),
    http_request_method: method,
    http_route: route,
    url_path: front.path,
    url_scheme: 'https',
    server_address: PUBLIC_HOST,
    client_address: pick(r, CLIENT_IPS),
    user_agent_original: pick(r, AGENTS),
    network_protocol_version: '2',
    http_response_status_code: front.status,
  };
  if (front.query) attrs.url_query = front.query;
  return node(
    'ingress-nginx',
    `${method} ${route}`,
    'SERVER',
    attrs,
    { lead: 0, self: between(r, 0.1, 0.6), status: front.status >= 500 ? 'ERROR' : 'UNSET' },
    [front.node],
  );
}

/** A subtree's duration; it doesn't depend on where the subtree starts. */
function durationOf(n: Node): number {
  let cursor = 0;
  for (const child of n.children) cursor += child.lead + durationOf(child);
  const end = Math.max(cursor + n.self, n.minDur ?? 0);
  return n.timeout !== undefined ? Math.min(end, n.timeout) : end;
}

/** The log a trace came from: its service's first span must contain `at`. */
interface Pin {
  service: string;
  at: number;
  done?: boolean;
  /** The span's natural start, recorded by the first pass. */
  naturalStart?: number;
  /** Time factor for everything laid out before the span (second pass). */
  scale?: number;
}

function layout(
  n: Node,
  start: number,
  parent: GenSpan | undefined,
  out: GenSpan[],
  counters: Map<string, number>,
  traceId: string,
  pin?: Pin,
): number {
  const k = counters.get(n.service) ?? 0;
  counters.set(n.service, k + 1);
  if (pin && !pin.done && n.service === pin.service) {
    pin.done = true;
    pin.naturalStart = start;
    // Logs are written as a request finishes: if the log is after the span's
    // natural end, the span starts later (its caller was busy) and ends just
    // after the log; if it's before the start, the span starts earlier.
    const naturalEnd = start + durationOf(n);
    if (pin.at > naturalEnd) start += pin.at - naturalEnd + 0.2;
    else if (pin.at < start) start = Math.max((parent?.start ?? start) + 0.05, pin.at - 0.1);
  }
  const span: GenSpan = {
    spanId: n.spanId ?? spanIdFor(traceId, n.service, k),
    parentSpanId: parent?.spanId,
    parentService: parent?.service,
    name: n.name,
    service: n.service,
    kind: n.kind,
    start,
    end: start,
    status: n.status ?? 'UNSET',
    message: n.message,
    attrs: n.attrs,
  };
  out.push(span);
  // Before the pinned span is reached, a second pass may compress time.
  const scale = () => (pin && !pin.done && pin.scale !== undefined ? pin.scale : 1);
  let cursor = start;
  for (const child of n.children)
    cursor = layout(child, cursor + child.lead * scale(), span, out, counters, traceId, pin);
  let end = Math.max(cursor + n.self * scale(), start + (n.minDur ?? 0) * scale());
  if (n.timeout !== undefined) end = Math.min(end, start + n.timeout * scale());
  span.end = end;
  if (n.exception) {
    const attributes: Record<string, unknown> = {
      exception_type: n.exception.type,
      exception_message: n.exception.message,
    };
    if (n.exception.stacktrace) attributes.exception_stacktrace = n.exception.stacktrace;
    span.events = [{ name: 'exception', time: Math.max(start, end - 0.05), attributes }];
  }
  return end;
}

/** Builds a trace; `plan` overrides the planned request (tests, operation lists). */
export function buildTrace(
  traceId: string,
  projectId: string,
  hint?: TraceHint,
  plan: Plan = planTrace(traceId, hint),
): GenTrace {
  const t0 = traceTime(traceId);
  const incident = incidentLevel(t0);
  const load = 0.85 + 0.15 * traffic(t0);
  const c: Ctx = {
    r: rng(mix(hashString(traceId), 2)),
    plan,
    incident,
    load,
    pg: (1 + 2.5 * incident) * load,
  };
  const root = ingress(c);
  let spans: GenSpan[] = [];
  const pin: Pin | undefined =
    hint?.ts !== undefined ? { service: hint.service, at: hint.ts } : undefined;
  layout(root, t0, undefined, spans, new Map(), traceId, pin);
  // The log is earlier than the span's caller even started: run the work
  // before the span faster, so the span starts just before the log.
  if (pin?.naturalStart !== undefined && pin.at < pin.naturalStart && pin.naturalStart > t0) {
    const scale = Math.max(0, (pin.at - 0.1 - t0) / (pin.naturalStart - t0));
    spans = [];
    layout(root, t0, undefined, spans, new Map(), traceId, { ...pin, done: false, scale });
  }
  return { traceId, projectId, start: t0, plan, spans };
}

export const hintOf = (log: GenLog): TraceHint => ({
  service: log.fields.service_name,
  template: log.template,
  fields: log.fields,
  ts: log.ts,
});

/** The traced log a trace was derived from, if any (it is at most 400 ms after the start). */
export function findTraceLog(
  projectId: string,
  traceId: string,
  now = Date.now(),
): GenLog | undefined {
  const t0 = traceTime(traceId);
  for (let slot = slotOf(t0); slot <= slotOf(t0 + 400); slot++) {
    for (const log of slotLogs(slot, projectId, now)) if (log.traceId === traceId) return log;
  }
  return undefined;
}

const TRACE_ID = /^[0-9a-f]{32}$/;

/** Regenerates any trace from its id; undefined for ids outside the demo's data. */
export function getTrace(
  projectId: string,
  traceId: string,
  now = Date.now(),
): GenTrace | undefined {
  if (!TRACE_ID.test(traceId)) return undefined;
  const t0 = traceTime(traceId);
  if (t0 > now || t0 < dataStart(now) - HOUR) return undefined;
  const call = findLlmCall(projectId, traceId, now);
  if (call) return buildLlmTrace(call, projectId);
  const log = findTraceLog(projectId, traceId, now);
  return buildTrace(traceId, projectId, log ? hintOf(log) : undefined);
}

// ---------------------------------------------------------------------------
// LLM calls (gen/aiUsage.ts): each row is the gen_ai span of its own trace.
// ---------------------------------------------------------------------------

/** The LLM call a trace id belongs to (its id carries the call's start time). */
export function findLlmCall(
  projectId: string,
  traceId: string,
  now = Date.now(),
): LlmSpan | undefined {
  const t0 = traceTime(traceId);
  return llmSpansBetween(projectId, t0, t0 + 1, now).find((call) => call.traceId === traceId);
}

const GENAI_SCOPE: Record<string, string> = {
  anthropic: 'opentelemetry.instrumentation.anthropic',
  openai: 'opentelemetry.instrumentation.openai_v2',
};

function genAiNode(c: Ctx, call: LlmSpan): Node {
  const attrs: Record<string, unknown> = {
    scope_name: GENAI_SCOPE[call.provider] ?? 'opentelemetry.instrumentation.openai_v2',
    gen_ai_operation_name: call.operation,
    gen_ai_provider_name: call.provider,
    gen_ai_request_model: call.model,
    server_address: call.serverAddress,
    server_port: 443,
  };
  if (call.operation === 'chat') {
    attrs.gen_ai_request_max_tokens = call.service === 'catalog' ? 512 : 1024;
    attrs.gen_ai_request_temperature = call.service === 'catalog' ? 0.4 : 0.2;
  }
  if (!call.isError) {
    attrs.gen_ai_response_model = call.model;
    attrs.gen_ai_response_id = `${call.provider === 'anthropic' ? 'msg_' : 'chatcmpl-'}${hex(hashString(call.spanId), 24)}`;
    attrs.gen_ai_usage_input_tokens = call.inputTokens;
    if (call.operation !== 'embeddings') attrs.gen_ai_usage_output_tokens = call.outputTokens;
    if (call.cachedTokens > 0) attrs.gen_ai_usage_cache_read_input_tokens = call.cachedTokens;
    if (call.finishReasons.length) attrs.gen_ai_response_finish_reasons = call.finishReasons;
  } else {
    attrs.error_type = call.errorType;
  }
  const message = call.isError
    ? call.errorType === 'APITimeoutError'
      ? 'Request timed out.'
      : call.errorType === 'overloaded_error'
        ? 'Overloaded'
        : 'Rate limit exceeded, please retry after a short wait.'
    : undefined;
  return node(call.service, `${call.operation} ${call.model}`, 'CLIENT', attrs, {
    lead: between(c.r, 0.2, 1.5),
    self: call.durationMs,
    spanId: call.spanId,
    status: call.isError ? 'ERROR' : 'UNSET',
    message,
    exception: call.isError ? { type: call.errorType, message: message! } : undefined,
  });
}

function supportServer(
  c: Ctx,
  call: LlmSpan,
  method: string,
  route: string,
  path: string,
  status: number,
  children: Node[],
): Node {
  return node(
    call.service,
    `${method} ${route}`,
    'SERVER',
    {
      scope_name: scope(call.service, 'server'),
      http_request_method: method,
      http_route: route,
      url_path: path,
      url_scheme: 'http',
      server_address: host(call.service),
      server_port: 8080,
      network_protocol_version: '1.1',
      http_response_status_code: status,
    },
    {
      lead: 0,
      self: between(c.r, 0.5, 3),
      status: status >= 500 ? 'ERROR' : 'UNSET',
      message:
        status >= 500 && call.isError ? `upstream LLM call failed: ${call.errorType}` : undefined,
    },
    children,
  );
}

/** The trace around one LLM call; the call's span keeps its id, start and duration. */
export function buildLlmTrace(call: LlmSpan, projectId: string): GenTrace {
  const traceId = call.traceId;
  const r = rng(mix(hashString(traceId), 3));
  const c: Ctx = {
    r,
    plan: { flow: 'home', mode: 'ok', session: false },
    incident: 0,
    load: 0.85 + 0.15 * traffic(call.timestamp),
    pg: 0.85 + 0.15 * traffic(call.timestamp),
  };
  const llm = genAiNode(c, call);
  let root: Node;
  if (call.service === 'catalog') {
    const id = String(int(r, 1000, 1999));
    const kids = [
      pg(
        c,
        'catalog',
        'SELECT',
        'shop.products',
        'SELECT id, name, attributes FROM shop.products WHERE id = $1',
        1,
      ),
      llm,
    ];
    if (!call.isError)
      kids.push(
        pg(
          c,
          'catalog',
          'UPDATE',
          'shop.products',
          'UPDATE shop.products SET description = $1, enriched_at = now() WHERE id = $2',
          undefined,
          true,
        ),
        valkey(c, 'catalog', 'DEL', `product:${id}`),
      );
    root = node(
      'catalog',
      'catalog.enrich_product',
      'INTERNAL',
      { scope_name: scope('catalog', 'internal'), job_name: 'nightly-enrichment', product_id: id },
      { lead: 0, self: between(r, 0.5, 2), status: call.isError ? 'ERROR' : 'UNSET' },
      kids,
    );
  } else if (call.operation === 'embeddings') {
    const doc = int(r, 100, 2400);
    const kids = [
      node(
        call.service,
        'chunk_document',
        'INTERNAL',
        {
          scope_name: scope(call.service, 'internal'),
          document_id: doc,
          chunk_count: int(r, 2, 14),
        },
        { lead: between(r, 0.2, 1), self: between(r, 2, 12) },
      ),
      llm,
    ];
    if (!call.isError)
      kids.push(
        pg(
          c,
          call.service,
          'INSERT',
          'support.kb_chunks',
          'INSERT INTO support.kb_chunks (document_id, position, content, embedding) VALUES ($1, $2, $3, $4)',
          undefined,
          true,
        ),
      );
    root = supportServer(
      c,
      call,
      'POST',
      '/v1/kb/documents/{document_id}/chunks',
      `/v1/kb/documents/${doc}/chunks`,
      call.isError ? 503 : 201,
      kids,
    );
  } else {
    const conversation = hex(hashString(traceId), 12);
    const kids: Node[] = [
      node(
        call.service,
        'retrieve_context',
        'INTERNAL',
        { scope_name: scope(call.service, 'internal'), retrieval_top_k: 8 },
        { lead: between(r, 0.2, 1), self: between(r, 0.3, 2) },
        [
          valkey(c, call.service, 'GET', `embedding:${hex(mix(r() * 1e9), 16)}`),
          pg(
            c,
            call.service,
            'SELECT',
            'support.kb_chunks',
            'SELECT id, title, content FROM support.kb_chunks ORDER BY embedding <=> $1 LIMIT 8',
            8,
          ),
        ],
      ),
      pg(
        c,
        call.service,
        'SELECT',
        'support.messages',
        'SELECT role, content FROM support.messages WHERE conversation_id = $1 ORDER BY created_at LIMIT 40',
        int(r, 2, 30),
      ),
      llm,
    ];
    if (call.finishReasons[0] === 'tool_use' || call.finishReasons[0] === 'tool_calls') {
      kids.push(
        node(
          call.service,
          'execute_tool lookup_order_status',
          'INTERNAL',
          {
            scope_name: scope(call.service, 'internal'),
            gen_ai_tool_name: 'lookup_order_status',
            gen_ai_operation_name: 'execute_tool',
          },
          { lead: between(r, 0.2, 1), self: between(r, 0.3, 1.5) },
          [
            pg(
              c,
              call.service,
              'SELECT',
              'shop.orders',
              'SELECT id, status, updated_at FROM shop.orders WHERE id = $1',
              1,
            ),
          ],
        ),
      );
    }
    if (!call.isError)
      kids.push(
        pg(
          c,
          call.service,
          'INSERT',
          'support.messages',
          'INSERT INTO support.messages (conversation_id, role, content) VALUES ($1, $2, $3)',
          undefined,
          true,
        ),
      );
    const status = call.isError ? (call.errorType === 'APITimeoutError' ? 504 : 503) : 200;
    root = supportServer(
      c,
      call,
      'POST',
      '/v1/conversations/{conversation_id}/messages',
      `/v1/conversations/${conversation}/messages`,
      status,
      kids,
    );
  }
  const spans: GenSpan[] = [];
  layout(root, 0, undefined, spans, new Map(), traceId);
  // Shift so the LLM span starts exactly at the call's timestamp.
  const offset = call.timestamp - spans.find((span) => span.spanId === call.spanId)!.start;
  for (const span of spans) {
    span.start += offset;
    span.end += offset;
    for (const event of span.events ?? []) event.time += offset;
  }
  return {
    traceId,
    projectId,
    start: spans[0].start,
    plan: c.plan,
    spans,
  };
}

// ---------------------------------------------------------------------------
// API shapes.
// ---------------------------------------------------------------------------

/** RFC 3339 with microseconds, like Go's time.Time JSON. */
export function isoMicro(ms: number): string {
  const whole = Math.floor(ms);
  const micro = Math.min(999, Math.floor((ms - whole) * 1000));
  return `${new Date(whole).toISOString().slice(0, 23)}${String(micro).padStart(3, '0')}Z`;
}

const LANGUAGE: Record<string, { language: string; sdk: string }> = {
  'ingress-nginx': { language: 'cpp', sdk: '1.14.2' },
  storefront: { language: 'nodejs', sdk: '1.28.0' },
  checkout: { language: 'go', sdk: '1.32.0' },
  inventory: { language: 'go', sdk: '1.32.0' },
  auth: { language: 'go', sdk: '1.32.0' },
  payments: { language: 'java', sdk: '1.44.1' },
  catalog: { language: 'python', sdk: '1.28.2' },
  search: { language: 'python', sdk: '1.28.2' },
  'support-assistant': { language: 'python', sdk: '1.28.2' },
};

function resourceFor(service: string, t: number, traceId: string, projectId: string) {
  const workload = workloadByService.get(service);
  const lang = LANGUAGE[service] ?? { language: 'go', sdk: '1.32.0' };
  const resource: Record<string, unknown> = {
    service_name: service,
    service_namespace: 'harborline',
    deployment_environment: projectId === PROJECT_ID ? 'production' : 'staging',
    telemetry_sdk_name: 'opentelemetry',
    telemetry_sdk_language: lang.language,
    telemetry_sdk_version: lang.sdk,
    cloud_provider: 'aws',
    cloud_region: REGION,
  };
  if (service === SUPPORT_ASSISTANT.service) {
    const h = hex(mix(hashString(traceId), 11), 5);
    resource.service_version = SUPPORT_ASSISTANT.version;
    resource.k8s_cluster_name = CLUSTER;
    resource.k8s_namespace_name = SUPPORT_ASSISTANT.namespace;
    resource.k8s_deployment_name = SUPPORT_ASSISTANT.deployment;
    resource.k8s_pod_name = `support-assistant-6d8f9c7b5d-${h}`;
    resource.k8s_node_name = NODES[hashString(h) % 2];
    return resource;
  }
  if (!workload) return resource;
  const pods = podsFor(workload, t);
  const pod = pods[mix(hashString(traceId), hashString(service)) % pods.length];
  resource.service_version = workload.version;
  resource.k8s_cluster_name = CLUSTER;
  resource.k8s_namespace_name = workload.namespace;
  resource.k8s_pod_name = pod.name;
  resource.k8s_node_name = pod.node;
  resource[`k8s_${workload.kind}_name`] = workload.name;
  if (pod.replicaSet) resource.k8s_replicaset_name = pod.replicaSet;
  return resource;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function toSpanDtos(trace: GenTrace): Span[] {
  const resources = new Map<string, Record<string, unknown>>();
  return [...trace.spans]
    .sort((a, b) => a.start - b.start)
    .map((span) => {
      let resource = resources.get(span.service);
      if (!resource) {
        resource = resourceFor(span.service, trace.start, trace.traceId, trace.projectId);
        resources.set(span.service, resource);
      }
      const dto: Span = {
        id: uuidFrom(`${trace.traceId}:${span.spanId}`),
        traceId: trace.traceId,
        spanId: span.spanId,
        name: span.name,
        serviceName: span.service,
        kind: span.kind,
        startTime: isoMicro(span.start),
        endTime: isoMicro(span.end),
        durationMs: round3(span.end - span.start),
        statusCode: span.status,
        attributes: span.attrs,
        resourceAttributes: resource,
      };
      if (span.parentSpanId) dto.parentSpanId = span.parentSpanId;
      if (span.message) dto.statusMessage = span.message;
      if (span.events)
        dto.events = span.events.map((event) => ({
          name: event.name,
          timestamp: isoMicro(event.time),
          attributes: event.attributes,
        }));
      return dto;
    });
}

export function summarize(trace: GenTrace): TraceSummary {
  let end = trace.start;
  let errors = 0;
  const services: string[] = [];
  for (const span of trace.spans) {
    if (span.end > end) end = span.end;
    if (span.status === 'ERROR') errors++;
    if (!services.includes(span.service)) services.push(span.service);
  }
  return {
    traceId: trace.traceId,
    rootName: trace.spans[0].name,
    rootServiceName: trace.spans[0].service,
    startTime: isoMicro(trace.start),
    durationMs: round3(end - trace.start),
    spanCount: trace.spans.length,
    errorCount: errors,
    services,
  };
}

// ---------------------------------------------------------------------------
// Traces in time: one per traced log, keyed by the slot the trace starts in.
// ---------------------------------------------------------------------------

/** A trace to list: from a traced log (hint) or an LLM call (llm). */
export interface Candidate {
  traceId: string;
  t0: number;
  hint?: TraceHint;
  llm?: LlmSpan;
}

/**
 * Traces starting in a slot, newest first: one per traced log (in this slot
 * or the next) plus, unless `withLlm` is false, the slot's LLM calls.
 */
export function candidatesInSlot(
  slot: number,
  projectId: string = PROJECT_ID,
  now = Date.now(),
  withLlm = true,
): Candidate[] {
  const out: Candidate[] = [];
  for (const s of [slot, slot + 1]) {
    for (const log of slotLogs(s, projectId, now)) {
      if (!log.traceId) continue;
      const t0 = traceTime(log.traceId);
      if (slotOf(t0) !== slot) continue;
      out.push({ traceId: log.traceId, t0, hint: hintOf(log) });
    }
  }
  if (withLlm) {
    for (const call of llmSpansBetween(projectId, slot * SLOT_MS, (slot + 1) * SLOT_MS, now))
      out.push({ traceId: call.traceId, t0: call.timestamp, llm: call });
  }
  return out.sort((a, b) => b.t0 - a.t0 || (a.traceId < b.traceId ? 1 : -1));
}

/** What a candidate's trace will contain, known before building it. */
export function candidateInfo(candidate: Candidate): {
  errors: boolean;
  services: string[];
  plan?: Plan;
} {
  if (candidate.llm) return { errors: candidate.llm.isError, services: [candidate.llm.service] };
  const plan = planTrace(candidate.traceId, candidate.hint);
  return { errors: planHasErrors(plan), services: planServices(plan), plan };
}

export function buildCandidate(candidate: Candidate, projectId: string, plan?: Plan): GenTrace {
  return candidate.llm
    ? buildLlmTrace(candidate.llm, projectId)
    : buildTrace(candidate.traceId, projectId, candidate.hint, plan);
}

interface Cached {
  summary: TraceSummary;
  names: string[];
}
const summaryCache = new Map<string, Cached>();

function cachedSummary(candidate: Candidate, projectId: string, plan?: Plan): Cached {
  const key = `${projectId}:${candidate.traceId}`;
  const hit = summaryCache.get(key);
  if (hit) return hit;
  const trace = buildCandidate(candidate, projectId, plan);
  const entry = { summary: summarize(trace), names: trace.spans.map((span) => span.name) };
  if (summaryCache.size > 30_000) summaryCache.clear();
  summaryCache.set(key, entry);
  return entry;
}

export interface TraceFilter {
  from: number;
  to: number;
  serviceName?: string;
  operationName?: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  errorsOnly?: boolean;
  limit: number;
}

/** Trace search, newest first; stops after a build budget, like a scan limit. */
export function listTraces(projectId: string, filter: TraceFilter, now = Date.now()) {
  const results: TraceSummary[] = [];
  const start = Math.max(filter.from, dataStart(now));
  const end = Math.min(filter.to, now);
  if (start > end) return results;
  let built = 0;
  let scanned = 0;
  for (let slot = slotOf(end); slot >= slotOf(start); slot--) {
    for (const candidate of candidatesInSlot(slot, projectId, now)) {
      if (candidate.t0 < filter.from || candidate.t0 > filter.to) continue;
      scanned++;
      const info = candidateInfo(candidate);
      if (filter.errorsOnly && !info.errors) continue;
      if (filter.serviceName && !info.services.includes(filter.serviceName)) continue;
      built++;
      const { summary, names } = cachedSummary(candidate, projectId, info.plan);
      if (filter.operationName && !names.includes(filter.operationName)) continue;
      if (filter.minDurationMs !== undefined && summary.durationMs < filter.minDurationMs) continue;
      if (filter.maxDurationMs !== undefined && summary.durationMs > filter.maxDurationMs) continue;
      results.push(summary);
      if (results.length >= filter.limit) return results;
    }
    if (built > 12_000 || scanned > 150_000) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Sampling, for aggregates over long ranges (service map, panels, stats).
// ---------------------------------------------------------------------------

/**
 * Slots to generate for [from, to], with each slot's weight (how many slots
 * it stands for). Incident windows are sampled separately, so error rates
 * don't depend on whether a stride happens to land in one.
 */
export function sampleSlots(
  from: number,
  to: number,
  budget: number,
): { slot: number; weight: number }[] {
  if (to < from) return [];
  const first = slotOf(from);
  const last = slotOf(to);
  const pieces: { a: number; b: number; incident: boolean }[] = [];
  let cursor = first;
  for (const incident of incidentsBetween(from, to)) {
    const a = Math.max(cursor, slotOf(incident.start));
    const b = Math.min(last, slotOf(incident.end));
    if (a > cursor) pieces.push({ a: cursor, b: a - 1, incident: false });
    if (b >= a) {
      pieces.push({ a, b, incident: true });
      cursor = b + 1;
    }
  }
  if (cursor <= last) pieces.push({ a: cursor, b: last, incident: false });
  const total = last - first + 1;
  const incidentSlots = pieces.reduce((sum, p) => sum + (p.incident ? p.b - p.a + 1 : 0), 0);
  const incidentBudget = incidentSlots
    ? Math.min(
        incidentSlots,
        Math.max(2, Math.round(budget * Math.min(0.5, (3 * incidentSlots) / total))),
      )
    : 0;
  const normalBudget = Math.max(1, budget - incidentBudget);
  const normalSlots = total - incidentSlots;
  const out: { slot: number; weight: number }[] = [];
  for (const piece of pieces) {
    const n = piece.b - piece.a + 1;
    const classBudget = piece.incident ? incidentBudget : normalBudget;
    const classSlots = piece.incident ? incidentSlots : normalSlots;
    const k = Math.min(n, Math.max(1, Math.round((classBudget * n) / Math.max(1, classSlots))));
    const step = n / k;
    for (let j = 0; j < k; j++)
      out.push({ slot: piece.a + Math.floor((j + 0.5) * step), weight: n / k });
  }
  return out;
}

/** Traces of the sampled slots in [from, to], each with its weight. */
export function sampledTraces(
  projectId: string,
  from: number,
  to: number,
  budget: number,
  visit: (trace: GenTrace, weight: number) => void,
  now = Date.now(),
) {
  const start = Math.max(from, dataStart(now));
  const end = Math.min(to, now);
  for (const { slot, weight } of sampleSlots(start, end, budget)) {
    for (const candidate of candidatesInSlot(slot, projectId, now, false)) {
      if (candidate.t0 < start || candidate.t0 > end) continue;
      visit(buildTrace(candidate.traceId, projectId, candidate.hint), weight);
    }
  }
  // LLM calls are sparse (a few a minute): stride over them instead of slots.
  const calls = llmSpansBetween(projectId, start, end + 1, now);
  const stride = Math.max(1, Math.ceil(calls.length / budget));
  for (let i = 0; i < calls.length; i += stride) visit(buildLlmTrace(calls[i], projectId), stride);
}

// ---------------------------------------------------------------------------
// Services, operations, stats.
// ---------------------------------------------------------------------------

export const TRACED_SERVICES = [
  'auth',
  'catalog',
  'checkout',
  'ingress-nginx',
  'inventory',
  'payments',
  'search',
  'storefront',
  'support-assistant',
];

/** Services with spans in a project (only production runs the support assistant). */
export const tracedServices = (projectId: string) =>
  projectId === PROJECT_ID
    ? TRACED_SERVICES
    : TRACED_SERVICES.filter((s) => s !== SUPPORT_ASSISTANT.service);

let operationIndex: Map<string, string[]> | undefined;

/** Every span name per service, from one trace of each request shape. */
export function operationsFor(service: string): string[] {
  if (!operationIndex) {
    const names = new Map<string, Set<string>>();
    const t = Date.UTC(2026, 0, 5, 12);
    let k = 0;
    const add = (plan: Plan) => {
      k++;
      const id = Math.floor(t + k * 997)
        .toString(16)
        .padStart(12, '0')
        .concat(hex(k, 20));
      for (const span of buildTrace(id, PROJECT_ID, undefined, plan).spans) {
        if (!names.has(span.service)) names.set(span.service, new Set());
        names.get(span.service)!.add(span.name);
      }
    };
    const modes: Mode[] = ['ok', 'slow', 'declined', 'pool', 'timeout', 'retry'];
    for (const flow of Object.keys(FLOW_ROUTE) as Flow[]) {
      for (const mode of flow === 'checkout' ? modes : (['ok'] as Mode[])) {
        add({ flow, mode, session: true });
        add({ flow, mode, session: true, leaf: 'auth' });
      }
      add({ flow, mode: 'ok', session: false, leaf: 'catalog' });
    }
    const llmCall = (
      service: string,
      operation: string,
      model: string,
      provider: string,
      finish: string[],
    ): LlmSpan => {
      k++;
      const timestamp = t + k * 997;
      return {
        timestamp,
        service,
        operation,
        model,
        provider,
        durationMs: 800,
        inputTokens: 1000,
        outputTokens: operation === 'chat' ? 200 : 0,
        cachedTokens: 0,
        isError: false,
        errorType: '',
        finishReasons: finish,
        traceId: timestamp.toString(16).padStart(12, '0').concat(hex(k, 20)),
        spanId: hex(k, 16),
        serverAddress: LLM_GATEWAY,
      };
    };
    for (const call of [
      llmCall('support-assistant', 'chat', SONNET, 'anthropic', ['tool_use']),
      llmCall('support-assistant', 'chat', GPT_MINI, 'openai', ['stop']),
      llmCall('support-assistant', 'embeddings', EMBEDDING, 'openai', []),
      llmCall('catalog', 'chat', HAIKU, 'anthropic', ['end_turn']),
    ]) {
      for (const span of buildLlmTrace(call, PROJECT_ID).spans) {
        if (!names.has(span.service)) names.set(span.service, new Set());
        names.get(span.service)!.add(span.name);
      }
    }
    operationIndex = new Map([...names].map(([s, set]) => [s, [...set].sort()]));
  }
  return operationIndex.get(service) ?? [];
}

let spanRatio: { tracesPerLog: number; spansPerTrace: number } | undefined;

/** Measured once from a fixed sample: traces per log and spans per trace. */
function ratios() {
  if (spanRatio) return spanRatio;
  const now = Date.now();
  const base = slotOf(now - 2 * 24 * HOUR);
  let logs = 0;
  let traces = 0;
  let spans = 0;
  for (let i = 0; i < 40; i++) {
    const slot = base + i * 211;
    logs += slotLogs(slot, PROJECT_ID, now).length;
    for (const candidate of candidatesInSlot(slot, PROJECT_ID, now, false)) {
      traces++;
      spans += buildTrace(candidate.traceId, PROJECT_ID, candidate.hint).spans.length;
    }
  }
  spanRatio = {
    tracesPerLog: logs ? traces / logs : 0.4,
    spansPerTrace: traces ? spans / traces : 12,
  };
  return spanRatio;
}

export function spanStats(projectId: string, now = Date.now()) {
  const oldest = dataStart(now);
  const step = 180; // slots (30 min)
  let logs = 0;
  for (let slot = slotOf(oldest); slot <= slotOf(now); slot += step)
    logs += slotMean(slot, projectId) * step;
  const { tracesPerLog, spansPerTrace } = ratios();
  const totalSpans = Math.round(logs * tracesPerLog * spansPerTrace);
  const rawMb = (totalSpans * 640) / 1024 / 1024;
  return {
    totalSpans,
    totalSizeMb: Math.round(rawMb * 0.13 * 10) / 10,
    rawSizeMb: Math.round(rawMb * 10) / 10,
    oldestSpanTime: new Date(oldest).toISOString(),
    newestSpanTime: new Date(now - 2500).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Dashboards: spans-source panels.
// ---------------------------------------------------------------------------

const GROUP_KEY: Record<string, (span: GenSpan) => string> = {
  service_name: (span) => span.service,
  name: (span) => span.name,
  status_code: (span) => span.status,
  kind: (span) => span.kind,
};

interface Acc {
  count: number;
  errors: number;
  durations: [number, number][];
}

function weightedPercentile(values: [number, number][], p: number): number {
  values.sort((a, b) => a[0] - b[0]);
  const total = values.reduce((sum, [, w]) => sum + w, 0);
  let seen = 0;
  for (const [value, weight] of values) {
    seen += weight;
    if (seen >= total * p) return value;
  }
  return values[values.length - 1][0];
}

function metricValue(metric: string | undefined, acc: Acc): number | undefined {
  switch (metric) {
    case 'error_count':
      return Math.round(acc.errors);
    case 'avg_duration_ms': {
      if (!acc.durations.length) return undefined;
      let sum = 0;
      let weight = 0;
      for (const [value, w] of acc.durations) {
        sum += value * w;
        weight += w;
      }
      return Math.round((sum / weight) * 100) / 100;
    }
    case 'p50_duration_ms':
    case 'p95_duration_ms':
    case 'p99_duration_ms': {
      if (!acc.durations.length) return undefined;
      const p = metric === 'p50_duration_ms' ? 0.5 : metric === 'p95_duration_ms' ? 0.95 : 0.99;
      return Math.round(weightedPercentile(acc.durations, p) * 100) / 100;
    }
    default:
      return Math.round(acc.count);
  }
}

/** A spans-source panel's buckets (dashboards and alert previews use this). */
export function aggregateSpanPanel(
  projectId: string,
  panel: Panel,
  range: { from?: string; to?: string } | undefined,
): AggregationBucket[] {
  const { from, to } = resolveRange(range, 24 * HOUR);
  const span = Math.max(to - from, SLOT_MS);
  const auto = Math.max(SLOT_MS, Math.ceil(span / 120 / SLOT_MS) * SLOT_MS);
  const bucketMs =
    panel.bucketMs && panel.bucketMs >= 1000 ? Math.max(panel.bucketMs, SLOT_MS) : auto;
  const timeless = panel.type === 'pie' || panel.type === 'stat' || panel.type === 'table';
  const width = timeless ? span + 1 : bucketMs;
  const groupOf = panel.groupField ? GROUP_KEY[panel.groupField] : undefined;
  const matches = (s: GenSpan) =>
    (!panel.serviceName || s.service === panel.serviceName) &&
    (!panel.operationName || s.name === panel.operationName) &&
    (!panel.rootSpansOnly || !s.parentSpanId);

  const now = Date.now();
  const firstBucket = timeless ? from : Math.floor(from / width) * width;
  const bucketCount = Math.max(1, Math.ceil((to - firstBucket + 1) / width));
  const perBucket = Math.max(1, Math.floor(360 / bucketCount));
  const counts = new Map<number, Map<string, Acc>>();
  for (let bucket = firstBucket; bucket <= to; bucket += width) {
    const groups = new Map<string, Acc>();
    counts.set(bucket, groups);
    const bucketStart = Math.max(bucket, from);
    const bucketEnd = Math.min(bucket + width - 1, to);
    sampledTraces(
      projectId,
      bucketStart,
      bucketEnd,
      perBucket,
      (trace, weight) => {
        for (const s of trace.spans) {
          if (!matches(s)) continue;
          const key = groupOf ? groupOf(s) : '';
          let acc = groups.get(key);
          if (!acc) {
            acc = { count: 0, errors: 0, durations: [] };
            groups.set(key, acc);
          }
          acc.count += weight;
          if (s.status === 'ERROR') acc.errors += weight;
          acc.durations.push([s.end - s.start, weight]);
        }
      },
      now,
    );
  }

  const totals = new Map<string, number>();
  for (const groups of counts.values())
    for (const [key, acc] of groups) totals.set(key, (totals.get(key) ?? 0) + acc.count);
  const keep = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, panel.limit || (timeless ? 20 : 10))
      .map(([key]) => key),
  );
  const out: AggregationBucket[] = [];
  for (const [bucket, groups] of counts) {
    const timestamp = timeless ? undefined : new Date(bucket).toISOString();
    if (!groupOf) {
      const acc = groups.get('') ?? { count: 0, errors: 0, durations: [] };
      const value = metricValue(panel.metric, acc);
      if (value !== undefined) out.push(timestamp ? { timestamp, value } : { value });
      continue;
    }
    for (const [key, acc] of groups) {
      if (!keep.has(key)) continue;
      const value = metricValue(panel.metric, acc);
      if (value === undefined) continue;
      out.push(timestamp ? { timestamp, groupKey: key, value } : { groupKey: key, value });
    }
  }
  if (timeless && groupOf) out.sort((a, b) => b.value - a.value);
  return out;
}
