// Logs › Web analytics: a GoAccess-style report from the access logs the
// ingress controller writes. Requests, status codes and the series follow
// the generated ingress-nginx access logs (so the totals match Logs); the
// top lists (pages, referrers, browsers, countries...) are a fixed, made-up
// mix spread over those counts. Country lookup is shown as DB-IP Lite, and
// every address is a documentation one (RFC 5737 / RFC 3849).
import type {
  WebAnalyticsBucket,
  WebAnalyticsIpMode,
  WebAnalyticsReport,
  WebAnalyticsRow,
  WebAnalyticsSettings,
  WebAnalyticsSettingsUpdate,
  WebAnalyticsSource,
  WebAnalyticsTotals,
} from '../../entity/webAnalytics';
import { type GenLog, countLogs } from '../gen/logs';
import { hashString, hex, mix } from '../lib/rng';
import { DemoError, type Router } from '../router';
import { collection } from '../store';
import { CLUSTER, DATA_DAYS, dataStart } from '../world';
import { requireProject } from './bootstrap';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SHORT_RANGE = 2 * HOUR;
const BOT_SHARE = 0.08;
const STATIC_SHARE = 0.1;
const ATTRIBUTION = 'IP geolocation by DB-IP';
const GEO_DATABASE = 'DB-IP Lite country, November 2026';
const BUILD_DELAY_MINUTES = 5;

const DEFAULT_STATIC =
  'css js mjs map png jpg jpeg gif svg webp avif ico woff woff2 ttf eot otf mp4 webm mp3 pdf txt xml json';

// --- settings ---------------------------------------------------------------------

interface StoredSettings {
  id: string;
  ipMode: WebAnalyticsIpMode;
  retentionDays: number;
  excludeBots: boolean;
  staticExtensions: string;
  geoEnabled: boolean;
  sourceNames: Record<string, string>;
}

const stored = collection<StoredSettings>('webAnalyticsSettings', () => []);

const settingsOf = (projectId: string): StoredSettings =>
  stored.get(projectId) ?? {
    id: projectId,
    ipMode: 'truncate',
    retentionDays: 0,
    excludeBots: true,
    staticExtensions: DEFAULT_STATIC,
    geoEnabled: true,
    sourceNames: {},
  };

// --- the one access-log source: the ingress controller --------------------------------

const INGRESS = {
  namespace: 'ingress-nginx',
  deployment: 'ingress-nginx-controller',
};
const SOURCE_KEY = hex(
  hashString(`k8s\n${CLUSTER}\n${INGRESS.namespace}\ndeployment\n${INGRESS.deployment}`),
  32,
);
const HOSTS: [string, number][] = [
  ['www.harborline.example.com', 0.82],
  ['api.harborline.example.com', 0.16],
  ['auth.harborline.example.com', 0.02],
];

/** Fields the combined format gives, by normalized name: the parsed line's groups. */
const SOURCE_FIELDS: Record<string, string> = {
  client_address: 'client',
  http_request_method: 'method',
  url_path: 'path',
  network_protocol_version: 'proto',
  http_response_status_code: 'status',
  http_response_body_size: 'bytes',
  http_request_header_referer: 'referer',
  user_agent_original: 'ua',
  server_address: 'k8s_ingress_host',
  http_server_request_duration: 'reqtime',
};

function sourceView(
  projectId: string,
  requests: number,
  hosts: string[],
  now: number,
): WebAnalyticsSource {
  const name = settingsOf(projectId).sourceNames[SOURCE_KEY] || INGRESS.deployment;
  return {
    key: SOURCE_KEY,
    name,
    defaultName: INGRESS.deployment,
    identifiedBy: 'k8s_workload',
    identity: [
      { name: 'k8s_cluster_name', value: CLUSTER },
      { name: 'k8s_namespace_name', value: INGRESS.namespace },
      { name: 'k8s_deployment_name', value: INGRESS.deployment },
    ],
    kind: 'Nginx',
    format: 'combined',
    fields: SOURCE_FIELDS,
    where: `${CLUSTER} › ${INGRESS.namespace} › ${INGRESS.deployment}`,
    hosts,
    requests,
    share: requests > 0 ? 1 : 0,
    hasReferrer: true,
    hasUserAgent: true,
    hasDuration: true,
    hasTls: false,
    mergedFrom: [],
    firstSeen: new Date(dataStart(now)).toISOString(),
    lastSeen: new Date(now - 2_000).toISOString(),
  };
}

// --- the made-up mix the top lists follow ---------------------------------------------------

type Mix = [key: string, share: number, extra?: Partial<WebAnalyticsRow>][];

const PAGES: Mix = [
  ['/products', 0.19],
  ['/search', 0.15],
  ['/', 0.12],
  ['/cart', 0.09],
  ['/cart/items', 0.07],
  ['/account', 0.04],
  ['/login', 0.04],
  ['/checkout', 0.035],
  ['/products/1042', 0.014],
  ['/products/1187', 0.012],
  ['/products/1311', 0.01],
  ['/products/1499', 0.009],
  ['/products/1650', 0.008],
  ['/products/1733', 0.007],
  ['/products/1876', 0.006],
  ['/account/orders', 0.006],
];
const NOT_FOUND: Mix = [
  ['/wp-login.php', 0.22, { tag: 'scanner' }],
  ['/.env', 0.15, { tag: 'scanner' }],
  ['/products/1999', 0.14, { tag: 'broken link' }],
  ['/collections/summer-2025', 0.12, { tag: 'broken link' }],
  ['/xmlrpc.php', 0.09, { tag: 'scanner' }],
  ['/apple-touch-icon.png', 0.08],
  ['/.git/config', 0.07, { tag: 'scanner' }],
  ['/blog/rain-jacket-care', 0.06, { tag: 'broken link' }],
  ['/admin', 0.04, { tag: 'scanner' }],
  ['/static/app.4f2c1e.js', 0.03, { tag: 'broken link' }],
];
const STATIC: Mix = [
  ['/static/app.js', 0.4],
  ['/static/app.css', 0.22],
  ['/static/img/hero.webp', 0.14],
  ['/favicon.ico', 0.09],
  ['/static/fonts/inter.woff2', 0.08],
  ['/static/img/logo.svg', 0.07],
];
const REFERRERS: Mix = [
  ['(direct or none)', 0.52],
  ['search.example.com', 0.21, { tag: 'search' }],
  ['search.example.org', 0.06, { tag: 'search' }],
  ['webmail.example.net', 0.06],
  ['blog.contoso.com', 0.05],
  ['deals.fabrikam.com', 0.04],
  ['social.example.net', 0.04],
  ['forum.example.org', 0.02],
];
const BROWSERS: Mix = [
  ['Chrome', 0.46],
  ['Safari', 0.27],
  ['Firefox', 0.08],
  ['Edge', 0.07],
  ['Samsung Internet', 0.04],
  ['Other', 0.08],
];
const SYSTEMS: Mix = [
  ['iOS', 0.29],
  ['Windows', 0.25],
  ['Android', 0.2],
  ['macOS', 0.18],
  ['Linux', 0.05],
  ['Other', 0.03],
];
const DEVICES: Mix = [
  ['Mobile', 0.52],
  ['Desktop', 0.43],
  ['Tablet', 0.05],
];
const COUNTRIES: Mix = [
  ['IE', 0.19],
  ['GB', 0.17],
  ['DE', 0.14],
  ['FR', 0.1],
  ['NL', 0.08],
  ['ES', 0.07],
  ['US', 0.06],
  ['IT', 0.05],
  ['SE', 0.04],
  ['BE', 0.03],
  ['PL', 0.03],
  ['PT', 0.02],
  ['??', 0.02],
];
const METHODS: Mix = [
  ['GET', 0.86],
  ['POST', 0.12],
  ['HEAD', 0.015],
  ['OPTIONS', 0.005],
];

/** Client networks (documentation ranges), each with an address in it and its country. */
const NETWORKS: { cidr: string; address: string; country: string; share: number }[] = [
  { cidr: '203.0.113.0/24', address: '203.0.113.45', country: 'IE', share: 0.16 },
  { cidr: '198.51.100.0/24', address: '198.51.100.23', country: 'GB', share: 0.13 },
  { cidr: '192.0.2.0/24', address: '192.0.2.31', country: 'DE', share: 0.1 },
  { cidr: '2001:db8:4a1c::/48', address: '2001:db8:4a1c:12::7', country: 'FR', share: 0.07 },
  { cidr: '2001:db8:7f20::/48', address: '2001:db8:7f20:3::1a', country: 'NL', share: 0.06 },
  { cidr: '2001:db8:1b3e::/48', address: '2001:db8:1b3e:40::5', country: 'ES', share: 0.05 },
  { cidr: '2001:db8:9c41::/48', address: '2001:db8:9c41:2::c', country: 'US', share: 0.045 },
  { cidr: '2001:db8:2d05::/48', address: '2001:db8:2d05:8::21', country: 'IT', share: 0.04 },
  { cidr: '2001:db8:6e77::/48', address: '2001:db8:6e77:1::3', country: 'SE', share: 0.03 },
  { cidr: '2001:db8:3a90::/48', address: '2001:db8:3a90:5::9', country: 'BE', share: 0.025 },
  { cidr: '2001:db8:58d2::/48', address: '2001:db8:58d2:7::e', country: 'PL', share: 0.02 },
  { cidr: '2001:db8:0c1f::/48', address: '2001:db8:c1f:2::4', country: 'PT', share: 0.015 },
];

/** A share nudged by up to 15% per range, so two ranges don't show identical mixes. */
const jitter = (key: string, seed: number) =>
  0.85 + ((mix(hashString(key), seed) % 1000) / 1000) * 0.3;

function spread(
  mixes: Mix,
  total: number,
  seed: number,
  row: (key: string, hits: number, extra?: Partial<WebAnalyticsRow>) => WebAnalyticsRow,
): WebAnalyticsRow[] {
  const weights = mixes.map(([key, share]) => share * jitter(key, seed));
  const sum = weights.reduce((a, b) => a + b, 0);
  return mixes
    .map(([key, , extra], i) => row(key, Math.round((total * weights[i]) / sum), extra))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);
}

// --- counting the access logs -------------------------------------------------------------

const isAccess = (log: GenLog) => log.template.startsWith('nginx.access');
const statusOf = (log: GenLog) => log.fields.http_status_code ?? '200';

/** Access-log requests per bucket start and status code. */
function requestsByStatus(
  projectId: string,
  from: number,
  to: number,
  bucketMs: number,
  samples = 24,
) {
  return countLogs(projectId, from, to - 1, bucketMs, isAccess, statusOf, samples);
}

interface Tally {
  requests: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  notFound: number;
  statuses: Map<string, number>;
}

const emptyTally = (): Tally => ({
  requests: 0,
  s2: 0,
  s3: 0,
  s4: 0,
  s5: 0,
  notFound: 0,
  statuses: new Map(),
});

function addStatuses(tally: Tally, groups: Map<string, number>, scale: number) {
  for (const [status, raw] of groups) {
    const count = Math.round(raw * scale);
    tally.requests += count;
    tally.statuses.set(status, (tally.statuses.get(status) ?? 0) + count);
    if (status.startsWith('2')) tally.s2 += count;
    else if (status.startsWith('3')) tally.s3 += count;
    else if (status.startsWith('4')) tally.s4 += count;
    else if (status.startsWith('5')) tally.s5 += count;
    if (status === '404') tally.notFound += count;
  }
}

const AVG_BYTES = 24_150;
const VISITORS_PER_REQUEST = 0.115;

function totalsOf(tally: Tally, bots: number): WebAnalyticsTotals {
  const share5xx = tally.requests ? tally.s5 / tally.requests : 0;
  return {
    requests: tally.requests,
    visitors: Math.round(tally.requests * VISITORS_PER_REQUEST),
    failed: tally.s5,
    notFound: tally.notFound,
    bytes: Math.round(tally.requests * AVG_BYTES),
    botRequests: bots,
    p95Ms: tally.requests ? Math.round(171 + 4000 * Math.min(0.75, share5xx * 15)) : null,
    durationSources: tally.requests ? [SOURCE_KEY] : [],
  };
}

function seriesBucket(length: number): number {
  if (length <= 20 * MINUTE) return MINUTE;
  if (length < SHORT_RANGE) return 5 * MINUTE;
  if (length <= 48 * HOUR) return HOUR;
  if (length <= 8 * DAY) return 6 * HOUR;
  return DAY;
}

// --- the report ---------------------------------------------------------------------------

function report(projectId: string, query: URLSearchParams, now = Date.now()): WebAnalyticsReport {
  const settings = settingsOf(projectId);
  const toParam = query.get('to');
  const fromParam = query.get('from');
  let to = toParam ? Date.parse(toParam) : now;
  if (!Number.isFinite(to) || to > now) to = now;
  let from = fromParam ? Date.parse(fromParam) : to - DAY;
  if (!Number.isFinite(from) || from >= to || to - from > 400 * DAY)
    throw new DemoError(400, 'from must be before to, and the range at most 400 days');
  const wanted = (query.get('sources') ?? '').split(',').filter(Boolean);
  const host = query.get('host') ?? '';
  const included = !wanted.length || wanted.includes(SOURCE_KEY);
  const hostShare = host ? (HOSTS.find(([h]) => h === host)?.[1] ?? 0) : 1;
  const keep = (included ? hostShare : 0) * (settings.excludeBots ? 1 - BOT_SHARE : 1);
  const botScale = (included ? hostShare : 0) * BOT_SHARE;

  const length = to - from;
  const short = length < SHORT_RANGE;
  const bucketMs = seriesBucket(length);
  const liveStart = Math.floor(now / HOUR) * HOUR;
  if (short) from = Math.floor(from / bucketMs) * bucketMs;
  else from = Math.min(Math.ceil(from / HOUR) * HOUR, liveStart);
  const span = to - from;
  const seed = Math.floor(from / HOUR);

  // Series and totals from the access logs.
  const seriesStart = Math.floor(from / bucketMs) * bucketMs;
  const counted = requestsByStatus(projectId, seriesStart, to, bucketMs);
  const tally = emptyTally();
  let allRequests = 0;
  const series: WebAnalyticsBucket[] = [];
  for (let start = seriesStart; start < now && start < to; start += bucketMs) {
    const groups = counted.get(start) ?? new Map<string, number>();
    const bucket = emptyTally();
    addStatuses(bucket, groups, keep);
    for (const raw of groups.values()) allRequests += raw;
    addStatuses(tally, groups, keep);
    series.push({
      start: new Date(start).toISOString(),
      live: !short && start + bucketMs > liveStart,
      requests: bucket.requests,
      status2xx: bucket.s2,
      status3xx: bucket.s3,
      status4xx: bucket.s4,
      status5xx: bucket.s5,
      other: 0,
      bytes: Math.round(bucket.requests * AVG_BYTES),
      visitors: Math.round(bucket.requests * VISITORS_PER_REQUEST * (bucketMs >= DAY ? 1 : 1.6)),
    });
  }
  const bots = Math.round(allRequests * botScale);
  const totals = totalsOf(tally, bots);

  // The window before, when the logs reach back that far.
  let previous: WebAnalyticsTotals | null = null;
  if (from - span >= dataStart(now)) {
    const prev = emptyTally();
    let prevAll = 0;
    for (const groups of requestsByStatus(projectId, from - span, from, span + 1, 48).values()) {
      addStatuses(prev, groups, keep);
      for (const raw of groups.values()) prevAll += raw;
    }
    previous = totalsOf(prev, Math.round(prevAll * botScale));
  }

  // The week's requests per hour (the heatmap), always the last 7 days.
  const heatmap: { hour: string; requests: number }[] = [];
  const weekEnd = liveStart + HOUR;
  for (const [hour, groups] of requestsByStatus(projectId, weekEnd - 7 * DAY, now, HOUR, 6)) {
    let requests = 0;
    for (const raw of groups.values()) requests += Math.round(raw * keep);
    if (requests > 0) heatmap.push({ hour: new Date(hour).toISOString(), requests });
  }
  heatmap.sort((a, b) => a.hour.localeCompare(b.hour));

  // Top lists, spread over the totals.
  const requests = totals.requests;
  const staticHits = Math.round(requests * STATIC_SHARE);
  const pageHits = Math.max(0, requests - staticHits - totals.notFound);
  const visitorsOf = (hits: number, ratio: number) => Math.max(1, Math.round(hits * ratio));
  const minutesAgo = (key: string) =>
    new Date(Math.min(to, now) - (1 + (hashString(key) % 50)) * MINUTE).toISOString();
  const pages = spread(PAGES, pageHits, seed, (key, hits) => ({
    key,
    hits,
    visitors: visitorsOf(hits, 0.42),
    bytes: hits * (key.startsWith('/products') ? 38_400 : 21_700),
    errors5xx: key === '/checkout' ? totals.failed : 0,
  }));
  const notFound = spread(NOT_FOUND, totals.notFound, seed, (key, hits, extra) => ({
    key,
    hits,
    visitors: visitorsOf(hits, extra?.tag === 'scanner' ? 0.05 : 0.6),
    bytes: hits * 548,
    errors5xx: 0,
    lastSeen: minutesAgo(key),
    ...extra,
  }));
  const statics = spread(STATIC, staticHits, seed, (key, hits) => ({
    key,
    hits,
    visitors: visitorsOf(hits, 0.7),
    bytes: hits * (key.endsWith('.js') ? 182_000 : key.endsWith('.webp') ? 96_000 : 14_000),
    errors5xx: 0,
  }));
  const visitors = totals.visitors ?? 0;
  const byVisitors = (list: Mix) =>
    spread(list, visitors, seed, (key, hits, extra) => ({
      key,
      hits: Math.round(hits / VISITORS_PER_REQUEST),
      visitors: hits,
      bytes: Math.round((hits / VISITORS_PER_REQUEST) * AVG_BYTES),
      errors5xx: 0,
      ...extra,
    }));
  const browsers = byVisitors(BROWSERS);
  if (!settings.excludeBots && bots > 0) {
    browsers.push({ key: 'Crawlers', hits: bots, visitors: 9, bytes: bots * 7_200, errors5xx: 0 });
    browsers.sort((a, b) => (b.visitors ?? 0) - (a.visitors ?? 0));
  }
  const ipKey = (n: (typeof NETWORKS)[number]) =>
    settings.ipMode === 'full'
      ? n.address
      : settings.ipMode === 'hash'
        ? hex(mix(hashString(n.address), hashString(projectId)), 16)
        : n.cidr;
  const ips = spread(
    NETWORKS.map((n) => [ipKey(n), n.share, { country: n.country }] as Mix[number]),
    requests,
    seed,
    (key, hits, extra) => ({
      key,
      hits,
      bytes: hits * AVG_BYTES,
      errors5xx: 0,
      ...(settings.geoEnabled ? extra : {}),
    }),
  );
  const hostRows = HOSTS.filter(([h]) => !host || h === host).map(([key, share]) => {
    const hits = Math.round((requests * share) / (host ? share : 1));
    return {
      key,
      hits,
      visitors: visitorsOf(hits, VISITORS_PER_REQUEST),
      bytes: hits * AVG_BYTES,
      errors5xx: key === 'www.harborline.example.com' ? totals.failed : 0,
    };
  });
  const statusRows = [...tally.statuses.entries()]
    .filter(([, hits]) => hits > 0)
    .map(([key, hits]) => ({
      key,
      hits,
      bytes: hits * (key === '200' ? AVG_BYTES : 600),
      errors5xx: key.startsWith('5') ? hits : 0,
    }))
    .sort((a, b) => b.hits - a.hits);
  const geo = {
    enabled: settings.geoEnabled,
    available: true,
    databaseType: GEO_DATABASE,
    attribution: ATTRIBUTION,
  };
  const closedHours = short ? 0 : Math.max(0, Math.floor((liveStart - from) / HOUR));
  const builtAt =
    liveStart + BUILD_DELAY_MINUTES * MINUTE <= now
      ? liveStart + BUILD_DELAY_MINUTES * MINUTE
      : liveStart - HOUR + BUILD_DELAY_MINUTES * MINUTE;
  const liveFrom = short ? from - span : liveStart;
  let liveRows = 0;
  for (const b of series) if (Date.parse(b.start) >= liveFrom) liveRows += b.requests;
  const hosts = included
    ? HOSTS.filter(([h]) => !host || h === host).map(([h, share]) => ({
        host: h,
        requests: Math.round((requests * share) / (host ? share : 1)),
      }))
    : [];

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    bucketSeconds: bucketMs / 1000,
    rollups: {
      used: !short,
      hours: closedHours,
      from: closedHours ? new Date(from).toISOString() : null,
      to: closedHours ? new Date(liveStart).toISOString() : null,
      lastBuiltAt: closedHours ? new Date(builtAt).toISOString() : null,
      missing: 0,
    },
    live: {
      from: new Date(liveFrom).toISOString(),
      to: new Date(to).toISOString(),
      rows: liveRows,
      durationMs: 180 + (hashString(String(seed)) % 420),
      cached: false,
    },
    sources: [
      sourceView(
        projectId,
        requests,
        HOSTS.map(([h]) => h),
        now,
      ),
    ],
    selected: included ? [SOURCE_KEY] : [],
    hosts,
    totals,
    previous,
    series,
    heatmap,
    panels: {
      pages,
      notFound,
      static: statics,
      referrers: spread(REFERRERS, pageHits, seed, (key, hits, extra) => ({
        key,
        hits,
        visitors: visitorsOf(hits, 0.3),
        bytes: hits * 21_700,
        errors5xx: 0,
        ...extra,
      })),
      ips,
      browsers,
      systems: byVisitors(SYSTEMS),
      devices: byVisitors(DEVICES),
      countries: settings.geoEnabled ? byVisitors(COUNTRIES) : [],
      vhosts: included ? hostRows : [],
      methods: spread(METHODS, requests, seed, (key, hits) => ({
        key,
        hits,
        bytes: hits * (key === 'GET' ? AVG_BYTES : 1_900),
        errors5xx: key === 'POST' ? totals.failed : 0,
      })),
      protocols: requests
        ? [{ key: 'HTTP/1.1', hits: requests, bytes: totals.bytes, errors5xx: totals.failed }]
        : [],
      tls: [],
      status: statusRows,
    },
    geo,
    ipMode: settings.ipMode,
    excludeBots: settings.excludeBots,
  };
}

// --- settings routes ----------------------------------------------------------------------

const SCHEMA = [
  {
    name: 'client_address',
    label: 'Client IP',
    aliases: ['client_address', 'remote_addr', 'c_ip'],
  },
  { name: 'http_request_method', label: 'Method', aliases: ['http_request_method', 'method'] },
  { name: 'url_path', label: 'Path', aliases: ['url_path', 'path', 'request_uri'] },
  {
    name: 'network_protocol_version',
    label: 'Protocol',
    aliases: ['network_protocol_version', 'protocol'],
  },
  {
    name: 'http_response_status_code',
    label: 'Status',
    aliases: ['http_response_status_code', 'status', 'http_status_code'],
  },
  {
    name: 'http_response_body_size',
    label: 'Bytes',
    aliases: ['http_response_body_size', 'body_bytes_sent'],
  },
  {
    name: 'http_request_header_referer',
    label: 'Referrer',
    aliases: ['http_request_header_referer', 'referer'],
  },
  {
    name: 'user_agent_original',
    label: 'User agent',
    aliases: ['user_agent_original', 'user_agent'],
  },
  { name: 'server_address', label: 'Host', aliases: ['server_address', 'host', 'vhost'] },
  { name: 'tls_protocol_version', label: 'TLS', aliases: ['tls_protocol_version', 'ssl_protocol'] },
  {
    name: 'http_server_request_duration',
    label: 'Duration',
    aliases: ['http_server_request_duration', 'duration_ms', 'request_time'],
  },
];

function settingsView(projectId: string, now = Date.now()): WebAnalyticsSettings {
  const settings = settingsOf(projectId);
  const liveStart = Math.floor(now / HOUR) * HOUR;
  const builtHour = liveStart - HOUR;
  let rowsRead = 0;
  for (const groups of requestsByStatus(projectId, builtHour, liveStart, HOUR + 1).values())
    for (const raw of groups.values()) rowsRead += raw;
  const hours = Math.floor((liveStart - dataStart(now)) / HOUR);
  const geo = {
    enabled: settings.geoEnabled,
    available: true,
    databaseType: GEO_DATABASE,
    attribution: ATTRIBUTION,
  };
  return {
    ipMode: settings.ipMode,
    retentionDays: settings.retentionDays,
    logRetentionDays: 30,
    excludeBots: settings.excludeBots,
    staticExtensions: settings.staticExtensions,
    geoEnabled: settings.geoEnabled,
    geo,
    sources: [
      sourceView(
        projectId,
        0,
        HOSTS.map(([h]) => h),
        now,
      ),
    ],
    build: {
      hour: new Date(builtHour).toISOString(),
      builtAt: new Date(
        Math.min(now, liveStart + BUILD_DELAY_MINUTES * MINUTE + 12_000),
      ).toISOString(),
      durationMs: 840 + (rowsRead % 400),
      rowsRead: Math.round(rowsRead),
    },
    storage: { hours, bytes: hours * 41_000 + DATA_DAYS * 220_000 },
    schema: SCHEMA,
    canManage: true,
    buildDelayMinutes: BUILD_DELAY_MINUTES,
  };
}

function updateSettings(projectId: string, update: WebAnalyticsSettingsUpdate) {
  const next = { ...settingsOf(projectId) };
  if (update.ipMode !== undefined) {
    if (!['truncate', 'hash', 'full'].includes(update.ipMode))
      throw new DemoError(400, 'ipMode must be truncate, hash or full');
    next.ipMode = update.ipMode;
  }
  if (update.retentionDays !== undefined) {
    if (update.retentionDays < 0 || update.retentionDays > 400)
      throw new DemoError(400, 'retentionDays must be between 0 and 400');
    next.retentionDays = update.retentionDays;
  }
  if (update.excludeBots !== undefined) next.excludeBots = update.excludeBots;
  if (update.geoEnabled !== undefined) next.geoEnabled = update.geoEnabled;
  if (update.staticExtensions !== undefined) {
    next.staticExtensions = [
      ...new Set(
        update.staticExtensions
          .toLowerCase()
          .split(/[\s,]+/)
          .map((e) => e.replace(/^\./, ''))
          .filter((e) => /^[a-z0-9]{1,10}$/.test(e)),
      ),
    ].join(' ');
  }
  for (const source of update.sources ?? []) {
    if (source.key !== SOURCE_KEY) throw new DemoError(404, 'Unknown source');
    if (source.mergedInto && source.mergedInto !== '')
      throw new DemoError(400, "A source can't be merged into itself");
    const names = { ...next.sourceNames };
    if (source.name.trim() && source.name.trim() !== INGRESS.deployment)
      names[source.key] = source.name.trim().slice(0, 100);
    else delete names[source.key];
    next.sourceNames = names;
  }
  if (stored.get(projectId)) stored.update(projectId, next);
  else stored.insert(next);
  return settingsView(projectId);
}

export function register(r: Router) {
  r.get('/projects/:pid/web-analytics/report', (req) =>
    report(requireProject(req.params.pid).id, req.query),
  );
  r.get('/projects/:pid/web-analytics/settings', (req) =>
    settingsView(requireProject(req.params.pid).id),
  );
  r.put('/projects/:pid/web-analytics/settings', (req) =>
    updateSettings(
      requireProject(req.params.pid).id,
      (req.body ?? {}) as WebAnalyticsSettingsUpdate,
    ),
  );
}
