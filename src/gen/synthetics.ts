// Synthetic monitor results, generated on demand: what each probe location
// would have measured on every run of every monitor, from a PRNG seeded by
// (monitor, location, run). The synthetics_* metric series, the run history
// (the probe's log lines) and "Run test" all read the same runs, so every
// screen agrees. The recurring checkout incident (world.ts) makes the
// checkout monitors fail from some locations; the auth certificate expires
// in about 12 days.
import type {
  Assertion,
  AssertionResult,
  CheckType,
  Definition,
  HTTPRequest,
  RunResult,
  RunStatus,
  StepResult,
  TLSInfo,
} from '../../entity/synthetics';
import { type Rng, hashString, hex, mix, rng } from '../lib/rng';
import {
  type StoredCheck,
  type StoredProbe,
  checks,
  destinations,
  probes,
  seedAnchor,
} from '../seed/synthetics';
import { BATCH_HOST, dataStart, incidentLevel, traffic } from '../world';
import {
  type LabelMatcher,
  type Labels,
  type MetricInfo,
  type RawSeries,
  matchAll,
  registerSeriesProvider,
} from './metricRegistry';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PROBE_SERVICE = 'obzly-probe';

/** What a run needs to know about its monitor (a saved one, or an editor's draft under test). */
export interface SimCheck {
  id: string;
  name: string;
  type: CheckType;
  definition: Definition;
}

// --- where the probes are ----------------------------------------------------------

/** Round trip from each probe location to the shop's load balancer in eu-west-1. */
const LOCATION_RTT: Record<string, number> = {
  'aws-eu-west-1': 1.6,
  'office-london': 11,
  'aws-us-east-1': 68,
  'aws-ap-southeast-1': 162,
};

/** How much of the incident's failing traffic each location's route lands on. */
const INCIDENT_EXPOSURE: Record<string, number> = {
  'aws-eu-west-1': 0.95,
  'aws-us-east-1': 0.85,
  'office-london': 0.6,
  'aws-ap-southeast-1': 0.22,
};

const rttFor = (location: string) => LOCATION_RTT[location] ?? 25 + (hashString(location) % 60);

// --- what the endpoints look like -----------------------------------------------

interface Cert {
  host: string;
  /** Days left at the anchor (start of today) plus 9.5 h. */
  days: number;
  issuer: string;
  sans: string[];
}

const ISSUER = 'CN=Example Trust RSA CA 2025,O=Example Trust Services,C=GB';
const CERTS: Record<string, Cert> = {
  'www.harborline.example.com': {
    host: 'www.harborline.example.com',
    days: 71,
    issuer: ISSUER,
    sans: ['www.harborline.example.com', 'harborline.example.com'],
  },
  'api.harborline.example.com': {
    host: 'api.harborline.example.com',
    days: 64,
    issuer: ISSUER,
    sans: ['api.harborline.example.com'],
  },
  'auth.harborline.example.com': {
    host: 'auth.harborline.example.com',
    days: 12,
    issuer: ISSUER,
    sans: ['auth.harborline.example.com'],
  },
  'status.harborline.example.com': {
    host: 'status.harborline.example.com',
    days: 45,
    issuer: 'CN=E6,O=Example Encrypt,C=US',
    sans: ['status.harborline.example.com'],
  },
};

const certFor = (host: string): Cert =>
  CERTS[host] ?? {
    host,
    days: 30 + (hashString(host) % 60),
    issuer: ISSUER,
    sans: [host],
  };

const daysLeft = (cert: Cert, t: number) => (seedAnchor() + cert.days * DAY + 9.5 * HOUR - t) / DAY;

interface Endpoint {
  serverMs: number;
  bytes: number;
  redirects: number;
  contentType: string;
  incident?: 'fail' | 'slow';
  ips: string[];
  body: string;
}

const LB_IPS = ['203.0.113.10', '203.0.113.11'];

/** The host of a URL or of a host:port target. */
function hostOf(target: string): string {
  if (target.includes('://')) {
    try {
      return new URL(target).hostname;
    } catch {
      /* a template the probe would fill in */
    }
  }
  return target.replace(/^[a-z]+:\/\//, '').split(/[/:]/)[0] ?? target;
}

function endpointFor(url: string, method = 'GET'): Endpoint {
  const host = hostOf(url);
  let path = '/';
  try {
    path = new URL(url.replace(/\{\{[^}]*\}\}/g, 'x')).pathname;
  } catch {
    /* a template the probe would fill in */
  }
  const json = 'application/json; charset=utf-8';
  if (host === 'www.harborline.example.com') {
    return {
      serverMs: 135,
      bytes: 48_200,
      redirects: path === '/' ? 1 : 0,
      contentType: 'text/html; charset=utf-8',
      ips: LB_IPS,
      body: '<!doctype html><html lang="en-GB"><head><title>Harborline - lanterns, rope and boat things</title>',
    };
  }
  if (host === 'api.harborline.example.com') {
    if (path.startsWith('/checkout/health')) {
      return {
        serverMs: 34,
        bytes: 142,
        redirects: 0,
        contentType: json,
        incident: 'fail',
        ips: LB_IPS,
        body: '{"status":"ok","checks":{"postgres":"ok","payments":"ok","valkey":"ok"}}',
      };
    }
    if (path.startsWith('/checkout/orders')) {
      return {
        serverMs: method === 'DELETE' ? 48 : 210,
        bytes: method === 'DELETE' ? 0 : 412,
        redirects: 0,
        contentType: json,
        incident: method === 'POST' ? 'fail' : 'slow',
        ips: LB_IPS,
        body: '{"id":"ord_7f3a9c21d4","state":"pending","total":{"amount":2899,"currency":"GBP"}}',
      };
    }
    if (path.startsWith('/cart')) {
      return {
        serverMs: 46,
        bytes: 820,
        redirects: 0,
        contentType: json,
        incident: 'slow',
        ips: LB_IPS,
        body: '{"cartId":"cart_51c0e7aa","items":[{"sku":"LANTERN-BRASS-S","qty":1}]}',
      };
    }
    if (path.startsWith('/auth')) {
      return {
        serverMs: 88,
        bytes: 640,
        redirects: 0,
        contentType: json,
        ips: LB_IPS,
        body: '{"accessToken":"[redacted]","expiresIn":900}',
      };
    }
    if (path.startsWith('/search')) {
      return {
        serverMs: 92,
        bytes: 6_240,
        redirects: 0,
        contentType: json,
        ips: LB_IPS,
        body: '{"results":[{"sku":"LANTERN-BRASS-S","name":"Brass storm lantern, small"}],"total":31}',
      };
    }
    return {
      serverMs: 60,
      bytes: 900,
      redirects: 0,
      contentType: json,
      ips: LB_IPS,
      body: '{"ok":true}',
    };
  }
  if (host === 'auth.harborline.example.com') {
    return {
      serverMs: 64,
      bytes: 9_120,
      redirects: 0,
      contentType: 'text/html; charset=utf-8',
      ips: ['203.0.113.12'],
      body: '<!doctype html><html><head><title>Sign in - Harborline</title></head><body><h1>Sign in</h1>',
    };
  }
  if (host === 'status.harborline.example.com' || host.startsWith('status')) {
    return {
      serverMs: 48,
      bytes: 21_400,
      redirects: 0,
      contentType: 'text/html; charset=utf-8',
      ips: ['198.51.100.140'],
      body: '<!doctype html><html><head><title>Harborline status</title></head><body>All systems operational',
    };
  }
  if (host.startsWith('staging.')) {
    return {
      serverMs: 190,
      bytes: 47_800,
      redirects: 0,
      contentType: 'text/html; charset=utf-8',
      ips: ['203.0.113.40'],
      body: '<!doctype html><html lang="en-GB"><head><title>Harborline (staging)</title>',
    };
  }
  return {
    serverMs: 110,
    bytes: 12_000,
    redirects: 0,
    contentType: 'text/html; charset=utf-8',
    ips: [`198.51.100.${10 + (hashString(host) % 200)}`],
    body: '<!doctype html><html><head><title>OK</title></head><body>',
  };
}

// --- one run -------------------------------------------------------------------------

/** exp(sigma * N(0,1)): latency noise with a long right tail. */
function lognormal(r: Rng, sigma: number): number {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function describe(a: Assertion): string {
  switch (a.kind) {
    case 'status':
      return a.op === 'in'
        ? `Status is one of ${(a.values ?? []).join(', ')}`
        : `Status equals ${a.value ?? ''}`;
    case 'response_time_ms':
      return `Response time below ${a.number ?? 0} ms`;
    case 'header':
      return a.op === 'exists'
        ? `Header ${a.name ?? ''} is present`
        : `Header ${a.name ?? ''} ${a.op} ${JSON.stringify(a.value ?? '')}`;
    case 'body':
      return a.op === 'matches'
        ? `Body matches /${a.value ?? ''}/`
        : `Body contains ${JSON.stringify(a.value ?? '')}`;
    case 'json':
      return a.op === 'exists'
        ? `${a.path ?? ''} exists`
        : `${a.path ?? ''} ${a.op} ${JSON.stringify(a.value ?? '')}`;
  }
}

interface Response {
  status: number;
  durationMs: number;
  contentType: string;
  bytes: number;
  failed: boolean;
}

function compare(op: string, actual: string, expected = ''): boolean {
  switch (op) {
    case 'equals':
      return actual === expected;
    case 'contains':
      return actual.includes(expected);
    case 'matches':
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
    case 'exists':
      return true;
    default:
      return false;
  }
}

function evaluate(assertions: Assertion[] | undefined, response: Response): AssertionResult[] {
  return (assertions ?? []).map((a) => {
    const result: AssertionResult = {
      description: describe(a),
      severity: a.severity === 'warn' ? 'warn' : 'fail',
      passed: true,
    };
    switch (a.kind) {
      case 'status':
        result.actual = String(response.status);
        result.passed =
          a.op === 'in'
            ? (a.values ?? []).includes(response.status)
            : a.value === String(response.status);
        break;
      case 'response_time_ms':
        result.actual = `${Math.round(response.durationMs)} ms`;
        result.passed = response.durationMs < (a.number ?? Infinity);
        break;
      case 'header': {
        const value =
          (a.name ?? '').toLowerCase() === 'content-type' ? response.contentType : (a.value ?? '');
        result.actual = value;
        result.passed = compare(a.op, value, a.value);
        break;
      }
      case 'body':
        result.actual = `${response.bytes} bytes`;
        result.passed = !response.failed;
        break;
      case 'json':
        result.actual = response.failed ? '' : a.op === 'exists' ? 'true' : (a.value ?? '');
        result.passed = !response.failed;
        break;
    }
    return result;
  });
}

/** Red on a failed fail-severity assertion, amber on a failed warn one. */
function statusFrom(error: string | undefined, assertions: AssertionResult[]): RunStatus {
  if (error) return 'down';
  let status: RunStatus = 'up';
  for (const a of assertions) {
    if (a.passed) continue;
    if (a.severity === 'warn') status = 'warn';
    else return 'down';
  }
  return status;
}

function expectedStatus(assertions: Assertion[] | undefined, method: string): number {
  const status = assertions?.find((a) => a.kind === 'status');
  if (status?.op === 'in' && status.values?.length) return status.values[0];
  if (status?.value && /^\d{3}$/.test(status.value)) return Number(status.value);
  return method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200;
}

interface RequestRun {
  status: number;
  durationMs: number;
  phases: Record<string, number>;
  bytes: number;
  redirects: number;
  error?: string;
  failed: boolean;
  endpoint: Endpoint;
  snippet?: string;
  assertions: AssertionResult[];
  host: string;
}

/** One HTTP request; fresh is a new connection (DNS, connect and TLS paid). */
function runRequest(
  request: HTTPRequest,
  assertions: Assertion[] | undefined,
  location: string,
  t: number,
  r: Rng,
  fresh: boolean,
  timeoutMs: number,
  incidentOn: boolean,
): RequestRun {
  const method = (request.method || 'GET').toUpperCase();
  const endpoint = endpointFor(request.url, method);
  const host = hostOf(request.url);
  const https = request.url.startsWith('https://');
  const rtt = rttFor(location) * (0.9 + 0.2 * r());
  const dns = fresh ? round1(0.8 + r() * 6 + (r() < 0.05 ? 18 : 0)) : 0;
  const connect = fresh ? round1(rtt + 0.3 + r()) : 0;
  const tls = fresh && https ? round1(rtt * 1.05 + 3 + r() * 4) : 0;
  const level = incidentOn && endpoint.incident ? incidentLevel(t) : 0;
  let server = endpoint.serverMs * (0.8 + 0.3 * traffic(t)) * lognormal(r, 0.22);
  if (level > 0) server *= endpoint.incident === 'fail' ? 1 + 7 * level : 1 + 2.5 * level;
  let status = expectedStatus(assertions, method);
  let bytes = Math.round(endpoint.bytes * (0.97 + 0.06 * r()));
  let error: string | undefined;
  let failed = false;
  let snippet: string | undefined;
  const failRoll = r();
  const flakeRoll = r();
  const exposure = INCIDENT_EXPOSURE[location] ?? 0.5;
  if (level > 0 && endpoint.incident === 'fail' && failRoll < level * exposure) {
    failed = true;
    if (failRoll < level * exposure * 0.22) {
      error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
    } else {
      status = failRoll < level * exposure * 0.7 ? 503 : 502;
      server = 1_400 + 2_600 * r();
      bytes = 96;
      snippet =
        status === 503
          ? '{"error":"payments unavailable: database connection pool exhausted (30/30 in use)"}'
          : '<html><body><h1>502 Bad Gateway</h1></body></html>';
    }
  } else if (flakeRoll < 0.0009) {
    failed = true;
    error = `dial tcp ${endpoint.ips[0]}:443: connect: connection timed out`;
  }
  const ttfb = round1(server + rtt);
  const transfer = round1((bytes / 2_600) * (rtt > 50 ? 2.2 : 1) + r() * 2);
  const redirects = request.followRedirects === false ? 0 : endpoint.redirects;
  const redirectMs = redirects * (rtt + endpoint.serverMs * 0.15);
  let durationMs = round1(dns + connect + tls + ttfb + transfer + redirectMs);
  if (error) durationMs = error.startsWith('timed out') ? timeoutMs : Math.min(timeoutMs, 10_000);
  const phases: Record<string, number> = { dns, connect, ttfb, transfer };
  if (tls > 0) phases.tls = tls;
  const response: Response = {
    status,
    durationMs,
    contentType: endpoint.contentType,
    bytes,
    failed,
  };
  return {
    status,
    durationMs,
    phases,
    bytes,
    redirects,
    error,
    failed,
    endpoint,
    snippet,
    assertions: error ? [] : evaluate(assertions, response),
    host,
  };
}

function tlsInfo(host: string, t: number): TLSInfo {
  const cert = certFor(host);
  const left = daysLeft(cert, t);
  return {
    subject: `CN=${host}`,
    issuer: cert.issuer,
    sans: cert.sans,
    notAfter: new Date(seedAnchor() + cert.days * DAY + 9.5 * HOUR).toISOString(),
    daysLeft: Math.round(left * 100) / 100,
    protocol: 'TLS 1.3',
    cipher: 'TLS_AES_128_GCM_SHA256',
    verified: true,
  };
}

/** Amber inside the certificate's warning window, red inside its fail window. */
function certStatus(
  definition: Definition,
  tls: TLSInfo,
  status: RunStatus,
): { status: RunStatus; error?: string } {
  if (status === 'down') return { status };
  const warnDays = definition.tls?.warnDays || 21;
  const failDays = definition.tls?.failDays ?? 0;
  if (tls.daysLeft <= 0) return { status: 'down', error: 'certificate has expired' };
  if (failDays > 0 && tls.daysLeft < failDays) {
    return {
      status: 'down',
      error: `certificate expires in ${Math.round(tls.daysLeft)} days (fail below ${failDays})`,
    };
  }
  if (tls.daysLeft < warnDays) return { status: 'warn' };
  return { status };
}

function dnsAnswers(host: string): string[] {
  if (host === 'harborline.example.com') return [...LB_IPS];
  if (host.endsWith('harborline.example.com')) return [LB_IPS[0]];
  return [`198.51.100.${10 + (hashString(host) % 200)}`];
}

/**
 * A run of check from location at t. r drives the noise; the same (check,
 * location, run) always gets the same r, so every screen sees the same run.
 */
export function simulate(
  check: SimCheck,
  location: string,
  probe: string,
  t: number,
  r: Rng,
): RunResult {
  const d = check.definition;
  const timeoutMs = (d.timeoutSeconds || (check.type === 'multi' ? 60 : 10)) * 1000;
  const result: RunResult = {
    checkId: check.id,
    check: check.name,
    type: check.type,
    target: targetLabel(d),
    location,
    probe,
    startedAt: new Date(t).toISOString(),
    status: 'up',
    durationMs: 0,
  };
  const rtt = rttFor(location);
  switch (check.type) {
    case 'http': {
      if (!d.request?.url) break;
      const run = runRequest(d.request, d.assertions, location, t, r, true, timeoutMs, true);
      result.durationMs = run.durationMs;
      result.phasesMs = run.phases;
      result.resolvedIps = run.endpoint.ips;
      result.error = run.error;
      result.assertions = run.assertions;
      if (!run.error) {
        result.httpStatus = run.status;
        result.responseBytes = run.bytes;
        result.redirects = run.redirects;
        result.headers = {
          'content-type': run.endpoint.contentType,
          server: 'envoy',
          'x-request-id': hex(mix(hashString(check.id), t), 32),
        };
        if (run.failed || run.assertions.some((a) => !a.passed)) result.bodySnippet = run.snippet;
      }
      result.status = statusFrom(run.error, run.assertions);
      if (d.request.url.startsWith('https://') && !run.error) {
        result.tls = tlsInfo(run.host, t);
        const settled = certStatus(d, result.tls, result.status);
        result.status = settled.status;
        result.error ??= settled.error;
      }
      break;
    }
    case 'multi':
      runSteps(check, location, t, r, timeoutMs, result);
      break;
    case 'tls': {
      const host = hostOf(d.target ?? '');
      const dns = round1(0.8 + r() * 6);
      const connect = round1(rtt + 0.4 + r());
      const tls = round1(rtt * 1.05 + 3 + r() * 4);
      result.phasesMs = { dns, connect, tls };
      result.durationMs = round1(dns + connect + tls);
      result.resolvedIps = dnsAnswers(host);
      result.tls = tlsInfo(host, t);
      result.assertions = evaluate(d.assertions, {
        status: 0,
        durationMs: result.durationMs,
        contentType: '',
        bytes: 0,
        failed: false,
      });
      const settled = certStatus(d, result.tls, statusFrom(undefined, result.assertions));
      result.status = settled.status;
      result.error = settled.error;
      break;
    }
    case 'tcp': {
      const host = hostOf(d.target ?? '');
      const dns = round1(0.8 + r() * 6);
      const connect = round1(rtt + 0.4 + r() * 1.5);
      result.phasesMs = { dns, connect };
      result.durationMs = round1(dns + connect);
      result.resolvedIps =
        host === 'sftp.harborline.example.com' ? ['203.0.113.30'] : dnsAnswers(host);
      if (r() < 0.0006) {
        result.error = `dial tcp ${result.resolvedIps[0]}:${(d.target ?? '').split(':')[1] ?? ''}: connect: connection refused`;
        result.status = 'down';
      }
      break;
    }
    case 'dns': {
      const host = hostOf(d.target ?? '');
      const ms = round1(4 + r() * 18 + (location.startsWith('office') ? 6 : 0));
      result.phasesMs = { dns: ms };
      result.durationMs = ms;
      result.dnsAnswers = dnsAnswers(host);
      const expected = d.dns?.expectAnyOf ?? [];
      if (expected.length && !result.dnsAnswers.some((answer) => expected.includes(answer))) {
        result.error = `no answer is one of ${expected.join(', ')} (got ${result.dnsAnswers.join(', ')})`;
      }
      result.status = result.error ? 'down' : 'up';
      break;
    }
    case 'icmp': {
      const sent = d.icmp?.count || 3;
      const roll = r();
      const lost = roll < 0.0035 ? 2 : roll < 0.025 ? 1 : 0;
      const received = sent - lost;
      const base = d.target === BATCH_HOST ? rtt + 0.9 : rtt;
      const avg = round1(base * (0.95 + 0.15 * r()) + (r() < 0.03 ? 25 : 0));
      const jitter = round1(0.1 + r() * Math.max(0.4, base * 0.06));
      const lossRatio = Math.round((lost / sent) * 100) / 100;
      result.icmp = { sent, received, lossRatio, rttAvgMs: avg, jitterMs: jitter };
      result.durationMs = avg;
      result.resolvedIps = [
        d.target === BATCH_HOST ? '198.51.100.24' : dnsAnswers(d.target ?? '')[0],
      ];
      result.assertions = [];
      const warnMs = d.icmp?.rttWarnMs ?? 0;
      if (warnMs > 0) {
        result.assertions.push({
          description: `Round trip below ${warnMs} ms`,
          severity: 'warn',
          passed: avg < warnMs,
          actual: `${avg.toFixed(1)} ms`,
        });
      }
      const max = d.icmp?.maxLossRatio ?? 0;
      if (received === 0) result.error = `no reply to ${sent} pings`;
      else if (lossRatio > max) {
        result.error = `lost ${lost} of ${sent} packets (${Math.round(lossRatio * 100)}%), above ${Math.round(max * 100)}%`;
      }
      result.status = statusFrom(result.error, result.assertions);
      break;
    }
  }
  return result;
}

function runSteps(
  check: SimCheck,
  location: string,
  t: number,
  r: Rng,
  timeoutMs: number,
  result: RunResult,
) {
  const steps = check.definition.steps ?? [];
  const seen = new Set<string>();
  const extracted = new Map<string, string>();
  let failed = false;
  let total = 0;
  const phases: Record<string, number> = {};
  result.steps = steps.map((step, i): StepResult => {
    const method = (step.request.method || 'GET').toUpperCase();
    const fill = (text: string) =>
      text.replace(/\{\{([^}]+)\}\}/g, (whole, name: string) => extracted.get(name) ?? whole);
    const url = fill(step.request.url);
    if (failed && !step.continueOnFailure) {
      return { index: i + 1, name: step.name, status: 'skipped', method, url, durationMs: 0 };
    }
    const host = hostOf(url);
    const fresh = !seen.has(host);
    seen.add(host);
    const stepTimeout = (step.timeoutSeconds || 10) * 1000;
    const run = runRequest(
      { ...step.request, url },
      step.assertions,
      location,
      t + total,
      r,
      fresh,
      Math.min(stepTimeout, timeoutMs),
      true,
    );
    let status = run.status;
    let assertions = run.assertions;
    // A clean-up after a failure finds nothing to clean up.
    if (failed && run.endpoint.incident !== 'fail' && url.includes('{{')) {
      status = 404;
      assertions = evaluate(step.assertions, {
        status,
        durationMs: run.durationMs,
        contentType: run.endpoint.contentType,
        bytes: 0,
        failed: false,
      });
    }
    const stepStatus = statusFrom(run.error, assertions);
    total += run.durationMs;
    for (const [phase, ms] of Object.entries(run.phases)) {
      phases[phase] = round1((phases[phase] ?? 0) + ms);
    }
    const out: StepResult = {
      index: i + 1,
      name: step.name,
      status: stepStatus,
      method,
      url,
      durationMs: run.durationMs,
      phasesMs: run.phases,
      error: run.error,
      assertions,
    };
    if (!run.error) {
      out.httpStatus = status;
      out.responseBytes = run.bytes;
      out.redirects = run.redirects;
    }
    if (stepStatus === 'down' && run.snippet) out.bodySnippet = run.snippet;
    if (failed) out.afterFailure = true;
    if (stepStatus !== 'down' && step.extract?.length) {
      out.extracted = step.extract.map((e) => {
        if (e.secret) return { name: e.name, secret: true };
        const value = `${e.name.replace(/Id$/, '').slice(0, 4)}_${hex(mix(hashString(check.id), t, i), 10)}`;
        extracted.set(e.name, value);
        return { name: e.name, value };
      });
      for (const e of step.extract) if (e.secret) extracted.set(e.name, '[secret]');
    }
    if (stepStatus === 'down') failed = true;
    return out;
  });
  result.durationMs = round1(total);
  result.phasesMs = phases;
  const first = result.steps.find((s) => s.status === 'down' && !s.afterFailure);
  result.status = first
    ? 'down'
    : result.steps.some((s) => s.status === 'warn')
      ? 'warn'
      : result.steps.some((s) => s.status === 'down')
        ? 'down'
        : 'up';
  if (first) result.error = first.error ?? `step ${first.index} (${first.name}) failed`;
  if (!first && check.definition.steps?.[0]?.request.url.startsWith('https://')) {
    result.tls = tlsInfo(hostOf(check.definition.steps[0].request.url), t);
  }
}

export function targetLabel(d: Definition): string {
  if (d.request) return d.request.url;
  if (d.steps?.length) return d.steps[0].request.url;
  return d.target ?? '';
}

/** "Checkout API health from aws-eu-west-1: up in 212 ms (HTTP 200)", like the probe's log line. */
export function summary(result: RunResult): string {
  let text = `${result.check} from ${result.location}: ${result.status} in ${Math.round(result.durationMs)} ms`;
  if (result.httpStatus) text += ` (HTTP ${result.httpStatus})`;
  if (result.error) text += `: ${result.error}`;
  else {
    const failed = result.assertions?.find((a) => !a.passed);
    if (failed) text += `: ${failed.description} failed (got ${failed.actual ?? ''})`;
  }
  for (const step of result.steps ?? []) {
    text += `\n${step.index}. ${step.name}: `;
    if (step.status === 'skipped') {
      text += `skipped (${step.method} ${step.url})`;
      continue;
    }
    text += `${step.method} ${step.url}`;
    if (step.httpStatus) text += ` → ${step.httpStatus}`;
    text += ` in ${Math.round(step.durationMs)} ms, ${step.status}`;
    if (step.afterFailure) text += ', ran after a failure';
    if (step.assertions?.length) {
      const passed = step.assertions.filter((a) => a.passed).length;
      text += `; assertions ${passed}/${step.assertions.length} passed`;
    }
    if (step.error) text += `; ${step.error}`;
  }
  return text;
}

// --- the schedule: which runs happened -----------------------------------------------

/** The probe group that serves a location (the demo has one per location). */
export const probeForLocation = (location: string): StoredProbe | undefined =>
  probes.all().find((probe) => probe.location === location && !probe.created);

/** Locations a monitor runs from: its list, or every location with a connected probe group. */
export function locationsOf(check: Pick<StoredCheck, 'locations'>): string[] {
  const live = probes
    .all()
    .filter((probe) => !probe.created)
    .map((probe) => probe.location);
  const wanted = check.locations.length ? check.locations : live;
  return [...new Set(wanted)].filter((location) => live.includes(location)).sort();
}

/** The probe instance that ran a location's runs at t (probe-sg-01 before it was replaced). */
export function memberAt(probe: StoredProbe, t: number, now = Date.now()): string {
  let best: { name: string; since: number } | undefined;
  for (const member of probe.members) {
    const since = now - member.firstSeenDays * DAY;
    const until = member.silentForMs === undefined ? Infinity : now - member.silentForMs;
    if (since <= t && t <= until && (!best || since > best.since)) {
      best = { name: member.name, since };
    }
  }
  return best?.name ?? probe.members[0]?.name ?? probe.name;
}

const phaseOf = (checkId: string, location: string, intervalMs: number) =>
  mix(hashString(checkId), hashString(location)) % intervalMs;

/** The window in which a monitor ran at all. */
function activeRange(check: StoredCheck, now: number): [number, number] {
  const start = Math.max(dataStart(now), Date.parse(check.createdAt));
  const end = check.enabled ? now : Math.min(now, Date.parse(check.updatedAt));
  return [start, end];
}

const outcomeCache = new Map<string, RunResult>();

/** Run k of a saved monitor from a location (run k starts at k * interval + the pair's phase). */
export function runOf(check: StoredCheck, location: string, k: number): RunResult {
  const key = `${check.id}:${check.version}|${location}|${k}`;
  const hit = outcomeCache.get(key);
  if (hit) return hit;
  const intervalMs = check.intervalSeconds * 1000;
  const t = k * intervalMs + phaseOf(check.id, location, intervalMs);
  const probe = probeForLocation(location);
  const r = rng(mix(hashString(check.id), hashString(location), k));
  const result = simulate(check, location, probe?.name ?? location, t, r);
  if (outcomeCache.size > 250_000) outcomeCache.clear();
  outcomeCache.set(key, result);
  return result;
}

/** Run indices of a monitor from a location inside [from, to], oldest first. */
export function runIndices(
  check: StoredCheck,
  location: string,
  from: number,
  to: number,
  now = Date.now(),
): [number, number] {
  const [start, end] = activeRange(check, now);
  const lo = Math.max(from, start);
  const hi = Math.min(to, end);
  const intervalMs = check.intervalSeconds * 1000;
  const phase = phaseOf(check.id, location, intervalMs);
  return [Math.ceil((lo - phase) / intervalMs), Math.floor((hi - phase) / intervalMs)];
}

export const runTime = (check: StoredCheck, location: string, k: number) => {
  const intervalMs = check.intervalSeconds * 1000;
  return k * intervalMs + phaseOf(check.id, location, intervalMs);
};

/** The latest run of each location, for the probe and monitor overviews. */
export function latestRuns(check: StoredCheck, now = Date.now()): RunResult[] {
  return locationsOf(check).flatMap((location) => {
    const [, last] = runIndices(check, location, now - 2 * check.intervalSeconds * 1000, now, now);
    const [first] = runIndices(check, location, -Infinity, now, now);
    return last >= first ? [runOf(check, location, last)] : [];
  });
}

// --- the synthetics_* metrics ------------------------------------------------------

const GAUGES: [string, string, string?][] = [
  ['synthetics_up', '1 when the run passed (amber counts), 0 when it failed'],
  ['synthetics_warn', '1 when the run passed with a warning'],
  [
    'synthetics_duration_seconds',
    'Run time, by phase (total, dns, connect, tls, ttfb, transfer)',
    's',
  ],
  ['synthetics_http_status', 'HTTP status of the response'],
  ['synthetics_response_bytes', 'Response body size', 'By'],
  ['synthetics_redirects', 'Redirects followed'],
  ['synthetics_cert_expiry_seconds', 'Seconds until the certificate expires', 's'],
  ['synthetics_tls_info', 'TLS details: issuer, protocol and cipher as labels'],
  ['synthetics_dns_answers', 'Number of DNS answers'],
  ['synthetics_icmp_rtt_seconds', 'Average ping round trip', 's'],
  ['synthetics_icmp_jitter_seconds', 'Ping jitter', 's'],
  ['synthetics_icmp_loss_ratio', 'Share of pings lost'],
  ['synthetics_step_up', '1 when a multi-step check step passed'],
  ['synthetics_step_duration_seconds', 'Time of a multi-step check step', 's'],
];

const METRICS: MetricInfo[] = GAUGES.map(([name, help, unit]) => ({
  name,
  type: 'gauge',
  help,
  unit,
}));
const METRIC_NAMES = new Set(METRICS.map((metric) => metric.name));

/** Monitors whose results go to a project. */
export function checksForProject(projectId: string): StoredCheck[] {
  const ids = new Set(
    destinations
      .all()
      .filter((destination) => destination.projectId === projectId)
      .map((destination) => destination.id),
  );
  return checks.all().filter((check) => ids.has(check.destinationId));
}

/** The points one run adds to a metric: extra labels and value. */
function pointsOf(name: string, run: RunResult): { extra: Labels; value: number }[] {
  const ok = run.status !== 'down';
  switch (name) {
    case 'synthetics_up':
      return [{ extra: {}, value: ok ? 1 : 0 }];
    case 'synthetics_warn':
      return [{ extra: {}, value: run.status === 'warn' ? 1 : 0 }];
    case 'synthetics_duration_seconds': {
      if (!ok) return [];
      const out = [{ extra: { phase: 'total' }, value: run.durationMs / 1000 }];
      for (const [phase, ms] of Object.entries(run.phasesMs ?? {})) {
        if (phase !== 'total') out.push({ extra: { phase }, value: ms / 1000 });
      }
      return out;
    }
    case 'synthetics_http_status':
      return run.httpStatus ? [{ extra: {}, value: run.httpStatus }] : [];
    case 'synthetics_response_bytes':
      return run.httpStatus ? [{ extra: {}, value: run.responseBytes ?? 0 }] : [];
    case 'synthetics_redirects':
      return run.httpStatus ? [{ extra: {}, value: run.redirects ?? 0 }] : [];
    case 'synthetics_cert_expiry_seconds':
      return run.tls
        ? [
            {
              extra: { tls_verified: String(run.tls.verified) },
              value: Math.round(run.tls.daysLeft * 86_400),
            },
          ]
        : [];
    case 'synthetics_tls_info':
      return run.tls
        ? [
            {
              extra: {
                tls_verified: String(run.tls.verified),
                issuer: run.tls.issuer,
                protocol: run.tls.protocol,
                cipher: run.tls.cipher,
              },
              value: 1,
            },
          ]
        : [];
    case 'synthetics_dns_answers':
      return run.type === 'dns' ? [{ extra: {}, value: run.dnsAnswers?.length ?? 0 }] : [];
    case 'synthetics_icmp_rtt_seconds':
      return run.icmp && run.icmp.received > 0
        ? [{ extra: {}, value: run.icmp.rttAvgMs / 1000 }]
        : [];
    case 'synthetics_icmp_jitter_seconds':
      return run.icmp && run.icmp.received > 0
        ? [{ extra: {}, value: run.icmp.jitterMs / 1000 }]
        : [];
    case 'synthetics_icmp_loss_ratio':
      return run.icmp ? [{ extra: {}, value: run.icmp.lossRatio }] : [];
    case 'synthetics_step_up':
    case 'synthetics_step_duration_seconds':
      return (run.steps ?? []).flatMap((step) => {
        if (step.status === 'skipped') return [];
        const extra = { step: step.name, step_index: String(step.index) };
        if (name === 'synthetics_step_up') {
          return [{ extra, value: step.status === 'down' ? 0 : 1 }];
        }
        return step.status === 'down' ? [] : [{ extra, value: step.durationMs / 1000 }];
      });
    default:
      return [];
  }
}

/** Runs read per series and query; a 14-day range of a 1-minute monitor reads every 9th. */
const MAX_RUNS_PER_SERIES = 2_400;

const BASE_LABELS = new Set([
  '__name__',
  'check_id',
  'check',
  'type',
  'location',
  'probe',
  'target',
  'service_name',
]);

export function syntheticsSeries(
  projectId: string,
  name: string,
  matchers: LabelMatcher[],
  from: number,
  to: number,
  scrapeMs: number,
  now = Date.now(),
): RawSeries[] {
  if (!METRIC_NAMES.has(name)) return [];
  const early = matchers.filter((matcher) => BASE_LABELS.has(matcher.name));
  const out = new Map<string, RawSeries>();
  for (const check of checksForProject(projectId)) {
    if (name.startsWith('synthetics_step_') && check.type !== 'multi') continue;
    for (const location of locationsOf(check)) {
      const probe = probeForLocation(location);
      if (!probe) continue;
      const base: Labels = {
        __name__: name,
        check_id: check.id,
        check: check.name,
        type: check.type,
        location,
        probe: probe.name,
        target: targetLabel(check.definition),
        service_name: PROBE_SERVICE,
      };
      if (!matchAll(base, early)) continue;
      const [first, last] = runIndices(check, location, from, to, now);
      // Long ranges read every n-th run (aligned, so a shorter range sees the same runs).
      const stride = Math.max(
        1,
        Math.floor(scrapeMs / (check.intervalSeconds * 1000)),
        Math.ceil((last - first + 1) / MAX_RUNS_PER_SERIES),
      );
      for (let k = Math.ceil(first / stride) * stride; k <= last; k += stride) {
        const run = runOf(check, location, k);
        const points = pointsOf(name, run);
        if (!points.length) continue;
        const t = runTime(check, location, k);
        const host = memberAt(probe, t, now);
        for (const point of points) {
          const key = `${check.id}|${location}|${host}|${JSON.stringify(point.extra)}`;
          let series = out.get(key);
          if (!series) {
            const labels = { ...base, ...point.extra, host_name: host };
            if (!matchAll(labels, matchers)) continue;
            series = { labels, timestamps: [], values: [] };
            out.set(key, series);
          }
          series.timestamps.push(t);
          series.values.push(point.value);
        }
      }
    }
  }
  return [...out.values()];
}

registerSeriesProvider({
  metrics: (projectId) => (checksForProject(projectId).length ? METRICS : []),
  series: (projectId, name, matchers, from, to, scrapeMs) =>
    syntheticsSeries(projectId, name, matchers, from, to, scrapeMs),
});

// --- run history: the probe's log lines --------------------------------------------

interface Condition {
  field?: string;
  operator?: string;
  value?: unknown;
}

interface Node {
  type?: string;
  condition?: Condition;
  logic?: { operator?: string; children?: Node[] };
}

function conditionsOf(node: Node | null | undefined, out: Condition[] = []): Condition[] {
  if (!node) return out;
  if (node.type === 'condition' && node.condition) out.push(node.condition);
  for (const child of node.logic?.children ?? []) conditionsOf(child, out);
  return out;
}

export interface RunLogQuery {
  query?: Node | null;
  timeRange?: { from?: string; to?: string };
  limit?: number;
  sortOrder?: 'asc' | 'desc';
}

const LEVEL: Record<RunStatus, string> = { up: 'info', warn: 'warn', down: 'error' };

/** A run as the probe's log line (service obzly-probe, the whole result in synthetics_run). */
export function runLog(check: StoredCheck, location: string, k: number, projectId: string) {
  const run = runOf(check, location, k);
  const t = runTime(check, location, k);
  const probe = probeForLocation(location);
  const fields: Record<string, string> = {
    service_name: PROBE_SERVICE,
    service_version: probe?.members[0]?.version ?? '',
    host_name: probe ? memberAt(probe, t) : location,
    check_id: check.id,
    check: check.name,
    type: check.type,
    location,
    probe: run.probe,
    target: run.target,
    status: run.status,
    duration_ms: String(run.durationMs),
    synthetics_run: JSON.stringify(run),
  };
  if (run.tls) fields.tls_verified = String(run.tls.verified);
  if (run.httpStatus) fields.http_status = String(run.httpStatus);
  if (run.error) fields.error = run.error;
  return {
    id: `syn-${hex(mix(hashString(check.id), hashString(location), k), 24)}`,
    projectId,
    timestamp: new Date(t).toISOString(),
    level: LEVEL[run.status],
    message: summary(run),
    fields,
    createdAt: new Date(t + Math.max(800, run.durationMs) + 400).toISOString(),
  };
}

/**
 * Answers a log search for a monitor's run history (service_name =
 * obzly-probe and check_id = ..., optionally level != info), or undefined
 * when the search isn't one.
 */
export function probeRunLogs(projectId: string, body: RunLogQuery) {
  const conditions = conditionsOf(body.query);
  const is = (field: string, op: string) =>
    conditions.find((c) => c.field === field && c.operator === op);
  if (is('service_name', 'equals')?.value !== PROBE_SERVICE) return undefined;
  const checkIdValue = is('check_id', 'equals')?.value;
  const failuresOnly = is('level', 'not_equals')?.value === 'info';
  const now = Date.now();
  const to = Math.min(now, body.timeRange?.to ? Date.parse(body.timeRange.to) : now);
  const from = body.timeRange?.from ? Date.parse(body.timeRange.from) : to - DAY;
  const limit = Math.min(Math.max(body.limit ?? 100, 1), 1000);
  const wanted = checksForProject(projectId).filter(
    (check) => checkIdValue === undefined || check.id === checkIdValue,
  );
  type Hit = { check: StoredCheck; location: string; k: number; t: number };
  const hits: Hit[] = [];
  for (const check of wanted) {
    for (const location of locationsOf(check)) {
      const [first, last] = runIndices(check, location, from, to, now);
      let found = 0;
      for (let k = last; k >= first && found < limit; k--) {
        if (failuresOnly && runOf(check, location, k).status === 'up') continue;
        hits.push({ check, location, k, t: runTime(check, location, k) });
        found++;
      }
    }
  }
  const asc = body.sortOrder === 'asc';
  hits.sort((a, b) => (asc ? a.t - b.t : b.t - a.t));
  const logs = hits.slice(0, limit).map((hit) => runLog(hit.check, hit.location, hit.k, projectId));
  return {
    logs,
    total: hits.length,
    limit,
    offset: 0,
    executedIn: `${(4 + Math.random() * 20).toFixed(1)}ms`,
  };
}
