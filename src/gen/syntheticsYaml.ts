// The monitors file (apiVersion obzly.com/synthetics/v1, kind MonitorList):
// export writes it the way the control plane does (backend spec/yaml.go);
// import reads it back into monitors and maintenance windows, reporting
// every problem with its line.
import { LineCounter, type Node as YamlNode, isMap, isSeq, parseDocument, stringify } from 'yaml';

import type {
  Assertion,
  Definition,
  HTTPRequest,
  ImportError,
  MaintenanceSchedule,
  Step,
} from '../../entity/synthetics';
import { normalizeSchedule, validTimeZone, wallToUtc } from './maintenance';

export const API_VERSION = 'obzly.com/synthetics/v1';
export const KIND = 'MonitorList';

/** A monitor in file form: names instead of ids. */
export interface FileMonitor {
  name: string;
  enabled: boolean;
  intervalSeconds: number;
  locations: string[];
  destination: string;
  downLocations: number;
  definition: Definition;
  folder: string;
  parents: string[];
  alerts?: { channels: string[]; notify: string; certDays: number; repeatSeconds: number };
}

export interface FileWindow {
  name: string;
  reason: string;
  enabled: boolean;
  all: boolean;
  monitors: string[];
  folders: string[];
  schedule: MaintenanceSchedule;
}

export interface MonitorFile {
  prune: boolean;
  monitors: FileMonitor[];
  hasMaintenance: boolean;
  maintenance: FileWindow[];
}

type Obj = Record<string, unknown>;

// --- export -------------------------------------------------------------------------

const seconds = (value: number) => `${value}s`;

function assertionYaml(a: Assertion): Obj {
  if (a.kind === 'status' && a.op === 'equals' && a.severity !== 'warn') {
    return { status: Number(a.value) };
  }
  const options: Obj = {};
  if (a.op === 'in') options.in = a.values ?? [];
  else if (a.op === 'below') options.below = a.number ?? 0;
  else if (a.op === 'exists') options.exists = true;
  else options[a.op] = a.value ?? '';
  if (a.name) options.name = a.name;
  if (a.path) options.path = a.path;
  if (a.severity === 'warn') options.severity = 'warn';
  // Go encodes maps with sorted keys.
  const sorted = Object.fromEntries(Object.entries(options).sort(([x], [y]) => x.localeCompare(y)));
  return { [a.kind]: sorted };
}

function requestYaml(r: HTTPRequest): Obj {
  const out: Obj = {};
  if (r.method) out.method = r.method;
  out.url = r.url;
  if (r.headers && Object.keys(r.headers).length) out.headers = r.headers;
  if (r.body) out.body = r.body;
  if (r.followRedirects !== undefined) out.follow_redirects = r.followRedirects;
  return out;
}

function stepYaml(step: Step): Obj {
  const out: Obj = { name: step.name, request: requestYaml(step.request) };
  if (step.assertions?.length) out.assertions = step.assertions.map(assertionYaml);
  if (step.extract?.length) {
    out.extract = step.extract.map((e) => {
      const item: Obj = { name: e.name, from: e.from };
      if (e.path) item.path = e.path;
      if (e.secret) item.secret = true;
      return item;
    });
  }
  if (step.continueOnFailure) out.continue_on_failure = true;
  if (step.timeoutSeconds && step.timeoutSeconds !== 10) out.timeout = seconds(step.timeoutSeconds);
  return out;
}

function monitorYaml(m: FileMonitor): Obj {
  const d = m.definition;
  const out: Obj = { name: m.name, type: d.type };
  if (!m.enabled) out.enabled = false;
  out.interval = seconds(m.intervalSeconds);
  out.timeout = seconds(d.timeoutSeconds);
  if (m.locations.length) out.locations = m.locations;
  if (m.destination) out.destination = m.destination;
  if (m.downLocations > 0) out.down_locations = m.downLocations;
  if (d.target) out.target = d.target;
  if (d.request) out.request = requestYaml(d.request);
  if (d.assertions?.length) out.assertions = d.assertions.map(assertionYaml);
  if (d.tls) {
    const tls: Obj = {};
    if (d.tls.verify !== undefined) tls.verify = d.tls.verify;
    if (d.tls.warnDays) tls.warn_days = d.tls.warnDays;
    if (d.tls.failDays) tls.fail_days = d.tls.failDays;
    if (d.tls.minProtocol) tls.min_protocol = d.tls.minProtocol;
    if (d.tls.verifyHostname !== undefined) tls.verify_hostname = d.tls.verifyHostname;
    out.tls = tls;
  }
  if (d.dns) {
    const dns: Obj = {};
    if (d.dns.recordType) dns.record_type = d.dns.recordType;
    if (d.dns.resolver) dns.resolver = d.dns.resolver;
    if (d.dns.expectAnyOf?.length) dns.expect_any_of = d.dns.expectAnyOf;
    out.dns = dns;
  }
  if (d.icmp) {
    const icmp: Obj = {};
    if (d.icmp.count) icmp.count = d.icmp.count;
    if (d.icmp.maxLossRatio) icmp.max_loss_ratio = d.icmp.maxLossRatio;
    if (d.icmp.rttWarnMs) icmp.rtt_warn_ms = d.icmp.rttWarnMs;
    out.icmp = icmp;
  }
  if (m.folder) out.folder = m.folder;
  if (m.parents.length) out.depends_on = m.parents;
  if (m.alerts) {
    const alerts: Obj = {};
    if (m.alerts.channels.length) alerts.channels = m.alerts.channels;
    if (m.alerts.notify) alerts.notify = m.alerts.notify;
    if (m.alerts.certDays) alerts.cert_days = m.alerts.certDays;
    if (m.alerts.repeatSeconds) alerts.repeat = seconds(m.alerts.repeatSeconds);
    out.alerts = alerts;
  }
  if (d.variables && Object.keys(d.variables).length) out.variables = d.variables;
  if (d.cookies === false) out.cookies = false;
  if (d.steps?.length) out.steps = d.steps.map(stepYaml);
  return out;
}

function durationText(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes > 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${minutes}m`;
}

function windowYaml(w: FileWindow): Obj {
  const out: Obj = { name: w.name };
  if (w.reason) out.reason = w.reason;
  if (!w.enabled) out.enabled = false;
  if (w.all) out.all = true;
  if (w.monitors.length) out.monitors = w.monitors;
  if (w.folders.length) out.folders = w.folders;
  const s = w.schedule;
  const schedule: Obj = {};
  if (s.kind === 'once') {
    schedule.repeat = 'once';
    if (s.startsAt) schedule.start = new Date(s.startsAt).toISOString().replace('.000Z', 'Z');
    if (s.endsAt) schedule.end = new Date(s.endsAt).toISOString().replace('.000Z', 'Z');
  } else {
    schedule.repeat = s.kind === 'daily' || s.kind === 'weekly' ? s.kind : 'monthly';
    schedule.at = s.startTime;
    schedule.duration = durationText(s.durationMinutes ?? 0);
    if (s.kind === 'weekly') schedule.days = s.weekdays ?? [];
    if (s.kind === 'monthly_day') schedule.day = s.dayOfMonth;
    if (s.kind === 'monthly_weekday') {
      schedule.week = s.weekOfMonth === -1 ? 'last' : String(s.weekOfMonth);
      schedule.weekday = s.weekday;
    }
  }
  if (s.timeZone && s.timeZone !== 'UTC') schedule.time_zone = s.timeZone;
  if (s.kind !== 'once') {
    if (s.startDate) schedule.from = s.startDate;
    if (s.endDate) schedule.until = s.endDate;
  }
  out.schedule = schedule;
  return out;
}

/** The export: monitors sorted by name, then windows (only when exporting everything). */
export function exportFile(monitors: FileMonitor[], windows?: FileWindow[]): string {
  const byName = <T extends { name: string }>(items: T[]) =>
    [...items].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const out: Obj = {
    apiVersion: API_VERSION,
    kind: KIND,
    monitors: byName(monitors).map(monitorYaml),
  };
  if (windows?.length) out.maintenance = byName(windows).map(windowYaml);
  return stringify(out, { indent: 2, lineWidth: 0 });
}

// --- import -------------------------------------------------------------------------

class Problem extends Error {}

function parseSeconds(value: unknown, what: string): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?$/.exec(text);
  if (!match || !text) {
    throw new Problem(`${what}: "${text}" isn't a duration like 180s or 5m`);
  }
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

const MONITOR_FIELDS = new Set([
  'name',
  'type',
  'enabled',
  'interval',
  'timeout',
  'locations',
  'destination',
  'down_locations',
  'target',
  'request',
  'assertions',
  'tls',
  'dns',
  'icmp',
  'folder',
  'depends_on',
  'alerts',
  'variables',
  'cookies',
  'steps',
]);
const TOP_FIELDS = new Set(['apiVersion', 'kind', 'prune', 'defaults', 'monitors', 'maintenance']);
const DEFAULT_FIELDS = new Set([
  'interval',
  'timeout',
  'locations',
  'destination',
  'down_locations',
  'enabled',
]);
const WINDOW_FIELDS = new Set([
  'name',
  'reason',
  'enabled',
  'all',
  'monitors',
  'folders',
  'schedule',
]);

function known(value: Obj, fields: Set<string>, where: string) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new Problem(`field ${key} not found in ${where}`);
  }
}

const asObj = (value: unknown, what: string): Obj => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Problem(`${what} must be a mapping`);
  }
  return value as Obj;
};

const asStrings = (value: unknown, what: string): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Problem(`${what} must be a list`);
  return value.map((item) => String(item));
};

const asString = (value: unknown) => (value === undefined || value === null ? '' : String(value));

function parseAssertion(item: unknown, index: number): Assertion {
  const entry = asObj(item, `assertion ${index + 1}`);
  const keys = Object.keys(entry);
  if (keys.length !== 1) throw new Problem('each assertion is one `kind: value` entry');
  const kind = keys[0] as Assertion['kind'];
  if (!['status', 'response_time_ms', 'header', 'json', 'body'].includes(kind)) {
    throw new Problem(`assertion ${index + 1}: unknown kind "${kind}"`);
  }
  const value = entry[kind];
  if (typeof value !== 'object' || value === null) {
    if (kind !== 'status') throw new Problem(`${kind} needs options, e.g. {below: 800}`);
    return { kind, op: 'equals', value: String(value) };
  }
  const assertion: Assertion = { kind, op: 'equals' };
  let op: Assertion['op'] | undefined;
  for (const [key, option] of Object.entries(value as Obj)) {
    switch (key) {
      case 'severity':
        assertion.severity = String(option) === 'warn' ? 'warn' : 'fail';
        break;
      case 'name':
        assertion.name = String(option);
        break;
      case 'path':
        assertion.path = String(option);
        break;
      case 'in':
        assertion.values = asStrings(option, 'in').map(Number);
        op = 'in';
        break;
      case 'below': {
        const number = Number(option);
        if (!Number.isFinite(number)) {
          throw new Problem(`below must be a number (got "${String(option)}")`);
        }
        assertion.number = number;
        op = 'below';
        break;
      }
      case 'equals':
      case 'contains':
      case 'matches':
        assertion.value = String(option);
        op = key;
        break;
      case 'exists':
        if (option !== true) throw new Problem('exists only supports true');
        op = 'exists';
        break;
      default:
        throw new Problem(`unknown option "${key}"`);
    }
  }
  if (!op) {
    throw new Problem(`${kind} needs an operator (equals, in, below, contains, matches or exists)`);
  }
  assertion.op = op;
  return assertion;
}

function parseRequest(value: unknown): HTTPRequest {
  const raw = asObj(value, 'request');
  known(raw, new Set(['method', 'url', 'headers', 'body', 'follow_redirects']), 'request');
  const request: HTTPRequest = {
    method: asString(raw.method).toUpperCase() || 'GET',
    url: asString(raw.url).trim(),
  };
  if (!request.url) throw new Problem('request.url is required');
  if (raw.headers) {
    request.headers = Object.fromEntries(
      Object.entries(asObj(raw.headers, 'headers')).map(([k, v]) => [k, String(v)]),
    );
  }
  if (raw.body !== undefined) request.body = asString(raw.body);
  if (raw.follow_redirects !== undefined) request.followRedirects = raw.follow_redirects === true;
  return request;
}

const TYPES = ['http', 'multi', 'tls', 'tcp', 'dns', 'icmp'];
const hostPort = /^[^\s:/]+:\d{1,5}$/;

interface Defaults {
  interval: number;
  timeout: number;
  locations: string[];
  destination: string;
  downLocations: number;
  enabled: boolean;
}

function parseMonitor(raw: Obj, defaults: Defaults): FileMonitor {
  known(raw, MONITOR_FIELDS, 'a monitor');
  const name = asString(raw.name).trim();
  if (!name) throw new Problem('name is required');
  if (name.length > 200) throw new Problem('name is longer than 200 characters');
  const type = asString(raw.type).trim().toLowerCase();
  if (!TYPES.includes(type)) {
    throw new Problem(`type must be one of http, multi, tls, tcp, dns, icmp (got "${type}")`);
  }
  const intervalSeconds = parseSeconds(raw.interval, 'interval') || defaults.interval || 180;
  if (intervalSeconds < 30) throw new Problem('interval must be at least 30s');
  const timeoutSeconds =
    parseSeconds(raw.timeout, 'timeout') || defaults.timeout || (type === 'multi' ? 60 : 10);
  const max = type === 'multi' ? 120 : 60;
  if (timeoutSeconds < 1 || timeoutSeconds > max) {
    throw new Problem(`timeout must be between 1s and ${max}s`);
  }
  if (timeoutSeconds > intervalSeconds) {
    throw new Problem('timeout must not be longer than the interval');
  }
  const definition: Definition = { type: type as Definition['type'], timeoutSeconds };
  const target = asString(raw.target).trim();
  if (target) definition.target = target;
  if (raw.request !== undefined) definition.request = parseRequest(raw.request);
  if (raw.assertions !== undefined) {
    if (!Array.isArray(raw.assertions)) throw new Problem('assertions must be a list');
    definition.assertions = raw.assertions.map(parseAssertion);
  }
  if (raw.tls !== undefined) {
    const tls = asObj(raw.tls, 'tls');
    known(
      tls,
      new Set(['verify', 'warn_days', 'fail_days', 'min_protocol', 'verify_hostname']),
      'tls',
    );
    definition.tls = {
      verify: tls.verify === undefined ? undefined : tls.verify === true,
      warnDays: Number(tls.warn_days ?? 0) || undefined,
      failDays: Number(tls.fail_days ?? 0) || undefined,
      minProtocol: tls.min_protocol ? asString(tls.min_protocol).toUpperCase() : undefined,
      verifyHostname: tls.verify_hostname === undefined ? undefined : tls.verify_hostname === true,
    };
  }
  if (raw.dns !== undefined) {
    const dns = asObj(raw.dns, 'dns');
    known(dns, new Set(['record_type', 'resolver', 'expect_any_of']), 'dns');
    definition.dns = {
      recordType: asString(dns.record_type).toUpperCase() || 'A',
      resolver: asString(dns.resolver) || undefined,
      expectAnyOf: dns.expect_any_of ? asStrings(dns.expect_any_of, 'expect_any_of') : undefined,
    };
  }
  if (raw.icmp !== undefined) {
    const icmp = asObj(raw.icmp, 'icmp');
    known(icmp, new Set(['count', 'max_loss_ratio', 'rtt_warn_ms']), 'icmp');
    definition.icmp = {
      count: Number(icmp.count ?? 0) || undefined,
      maxLossRatio: Number(icmp.max_loss_ratio ?? 0) || undefined,
      rttWarnMs: Number(icmp.rtt_warn_ms ?? 0) || undefined,
    };
  }
  if (raw.variables !== undefined) {
    definition.variables = Object.fromEntries(
      Object.entries(asObj(raw.variables, 'variables')).map(([k, v]) => [k, String(v)]),
    );
  }
  if (raw.cookies !== undefined) definition.cookies = raw.cookies === true;
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) throw new Problem('steps must be a list');
    definition.steps = raw.steps.map((item, i) => {
      const step = asObj(item, `step ${i + 1}`);
      known(
        step,
        new Set(['name', 'request', 'assertions', 'extract', 'continue_on_failure', 'timeout']),
        'a step',
      );
      if (step.request === undefined) throw new Problem(`step ${i + 1}: request is required`);
      const out: Step = {
        name: asString(step.name) || `Step ${i + 1}`,
        request: parseRequest(step.request),
      };
      if (Array.isArray(step.assertions)) out.assertions = step.assertions.map(parseAssertion);
      if (Array.isArray(step.extract)) {
        out.extract = step.extract.map((e) => {
          const extract = asObj(e, 'extract');
          return {
            name: asString(extract.name),
            from: asString(extract.from) as NonNullable<Step['extract']>[number]['from'],
            path: extract.path === undefined ? undefined : asString(extract.path),
            secret: extract.secret === true || undefined,
          };
        });
      }
      if (step.continue_on_failure === true) out.continueOnFailure = true;
      const timeout = parseSeconds(step.timeout, `step ${i + 1} timeout`);
      if (timeout) out.timeoutSeconds = timeout;
      return out;
    });
  }
  if (
    type !== 'multi' &&
    (definition.steps || definition.variables || definition.cookies !== undefined)
  ) {
    throw new Problem('steps, variables and cookies apply to multi-step checks only');
  }
  switch (type) {
    case 'http':
      if (!definition.request) throw new Problem('request.url is required');
      break;
    case 'tls':
    case 'tcp':
      if (!hostPort.test(target)) throw new Problem('target must be host:port');
      break;
    case 'dns':
    case 'icmp':
      if (!target) throw new Problem('target is required');
      break;
    case 'multi':
      if (!definition.steps?.length) throw new Problem('a multi-step check needs 1 to 10 steps');
      if (definition.steps.length > 10)
        throw new Problem('a multi-step check has at most 10 steps');
      break;
  }
  const downLocations =
    raw.down_locations === undefined ? defaults.downLocations : Number(raw.down_locations);
  if (!(downLocations >= 0)) throw new Problem("down_locations can't be negative");
  const locations = (
    raw.locations === undefined ? defaults.locations : asStrings(raw.locations, 'locations')
  )
    .map((location) => location.trim())
    .filter((location) => location && location !== 'all');
  const folder = asString(raw.folder)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/');
  const parents = [
    ...new Set(
      asStrings(raw.depends_on, 'depends_on')
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
  if (parents.some((parent) => parent.toLowerCase() === name.toLowerCase())) {
    throw new Problem("a monitor can't depend on itself");
  }
  const monitor: FileMonitor = {
    name,
    enabled: raw.enabled === undefined ? defaults.enabled : raw.enabled === true,
    intervalSeconds,
    locations,
    destination: asString(raw.destination) || defaults.destination,
    downLocations,
    definition,
    folder,
    parents,
  };
  if (raw.alerts !== undefined) {
    const alerts = asObj(raw.alerts, 'alerts');
    known(alerts, new Set(['channels', 'notify', 'cert_days', 'repeat']), 'alerts');
    const notify = asString(alerts.notify).toLowerCase() || 'down';
    if (notify !== 'down' && notify !== 'degraded') {
      throw new Problem('alerts.notify must be "down" or "degraded"');
    }
    monitor.alerts = {
      channels: asStrings(alerts.channels, 'alerts.channels'),
      notify,
      certDays: Number(alerts.cert_days ?? 0),
      repeatSeconds: parseSeconds(alerts.repeat, 'alerts.repeat'),
    };
  }
  return monitor;
}

function parseInstant(text: string, timeZone: string): string {
  const value = text.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return new Date(value).toISOString();
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
  if (local) {
    const [, y, m, d, h, mi] = local.map(Number);
    return new Date(wallToUtc(y, m, d, h, mi, timeZone)).toISOString();
  }
  throw new Problem(`"${value}" isn't a time like 2026-11-02T22:00:00Z or 2026-11-02 22:00`);
}

function parseWindow(raw: Obj): FileWindow {
  known(raw, WINDOW_FIELDS, 'a maintenance window');
  const name = asString(raw.name).trim();
  if (!name) throw new Problem('name is required');
  const s = asObj(raw.schedule, 'schedule');
  known(
    s,
    new Set([
      'repeat',
      'start',
      'end',
      'at',
      'duration',
      'days',
      'day',
      'week',
      'weekday',
      'time_zone',
      'from',
      'until',
    ]),
    'a schedule',
  );
  const timeZone = asString(s.time_zone).trim() || 'UTC';
  if (!validTimeZone(timeZone)) throw new Problem(`schedule: unknown time zone "${timeZone}"`);
  const repeat = asString(s.repeat).trim().toLowerCase();
  const schedule: MaintenanceSchedule = { kind: 'once', timeZone };
  if (repeat === 'once' || repeat === '') {
    schedule.startsAt = parseInstant(asString(s.start), timeZone);
    schedule.endsAt = parseInstant(asString(s.end), timeZone);
  } else {
    schedule.startTime = asString(s.at);
    schedule.startDate = asString(s.from) || undefined;
    schedule.endDate = asString(s.until) || undefined;
    if (repeat === 'daily') schedule.kind = 'daily';
    else if (repeat === 'weekly') {
      schedule.kind = 'weekly';
      schedule.weekdays = asStrings(s.days, 'days') as MaintenanceSchedule['weekdays'];
    } else if (repeat === 'monthly') {
      const week = asString(s.week).trim();
      if (Number(s.day) > 0 && !week) {
        schedule.kind = 'monthly_day';
        schedule.dayOfMonth = Number(s.day);
      } else if (!s.day && week) {
        schedule.kind = 'monthly_weekday';
        schedule.weekday = asString(s.weekday) as MaintenanceSchedule['weekday'];
        schedule.weekOfMonth = week.toLowerCase() === 'last' ? -1 : Number(week);
        if (!Number.isInteger(schedule.weekOfMonth)) {
          throw new Problem(`week must be 1 to 4 or last, not "${week}"`);
        }
      } else {
        throw new Problem('a monthly window needs day (1-31), or week (1-4 or last) and weekday');
      }
    } else {
      throw new Problem(`repeat must be once, daily, weekly or monthly, not "${repeat}"`);
    }
    const duration = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(asString(s.duration).trim());
    if (!duration || !asString(s.duration).trim()) {
      throw new Problem(
        `duration must be whole minutes like 1h or 90m, not "${asString(s.duration)}"`,
      );
    }
    schedule.durationMinutes = Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0);
  }
  const all = raw.all === true;
  const monitors = all ? [] : asStrings(raw.monitors, 'monitors');
  const folders = all
    ? []
    : [
        ...new Set(
          asStrings(raw.folders, 'folders').map((f) =>
            f
              .split('/')
              .map((p) => p.trim())
              .filter(Boolean)
              .join('/'),
          ),
        ),
      ];
  if (!all && !monitors.length && !folders.length) {
    throw new Problem('choose the monitors, folders or all monitors it covers');
  }
  let normalized: MaintenanceSchedule;
  try {
    normalized = normalizeSchedule(schedule);
  } catch (error) {
    throw new Problem(error instanceof Error ? error.message : String(error));
  }
  // A file without `from` keeps no first date (the backend normalizes with a zero now).
  if (!schedule.startDate) delete normalized.startDate;
  return {
    name,
    reason: asString(raw.reason).trim(),
    enabled: raw.enabled === undefined || raw.enabled === true,
    all,
    monitors,
    folders,
    schedule: normalized,
  };
}

/** Reads a monitors file, or every problem in it (so the preview shows them all at once). */
export function parseFile(text: string): { file?: MonitorFile; errors: ImportError[] } {
  if (text.length > 2 * 1024 * 1024)
    return { errors: [{ message: 'the file is larger than 2 MB' }] };
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  if (doc.errors.length) {
    const first = doc.errors[0];
    return {
      errors: [
        {
          line: first.linePos?.[0]?.line,
          message: `invalid YAML: ${first.message.split('\n')[0]}`,
        },
      ],
    };
  }
  const lineOf = (node: unknown) => {
    const range = (node as YamlNode | undefined)?.range;
    return range ? lines.linePos(range[0]).line : undefined;
  };
  const root = doc.toJS() as Obj | null;
  if (!root || typeof root !== 'object' || root.apiVersion !== API_VERSION || root.kind !== KIND) {
    return {
      errors: [{ line: 1, message: `expected apiVersion ${API_VERSION} and kind ${KIND}` }],
    };
  }
  const errors: ImportError[] = [];
  try {
    known(root, TOP_FIELDS, 'the file');
  } catch (error) {
    return { errors: [{ message: (error as Error).message }] };
  }
  let defaults: Defaults;
  try {
    const raw = asObj(root.defaults, 'defaults');
    known(raw, DEFAULT_FIELDS, 'defaults');
    defaults = {
      interval: parseSeconds(raw.interval, 'interval'),
      timeout: parseSeconds(raw.timeout, 'timeout'),
      locations: asStrings(raw.locations, 'locations'),
      destination: asString(raw.destination),
      downLocations: Number(raw.down_locations ?? 0),
      enabled: raw.enabled === undefined || raw.enabled === true,
    };
  } catch (error) {
    return { errors: [{ message: `defaults: ${(error as Error).message}` }] };
  }
  const monitorNodes = doc.get('monitors', true);
  const monitorItems = isSeq(monitorNodes) ? monitorNodes.items : [];
  const rawMonitors = Array.isArray(root.monitors) ? root.monitors : [];
  const file: MonitorFile = {
    prune: root.prune === true,
    monitors: [],
    hasMaintenance: root.maintenance !== undefined,
    maintenance: [],
  };
  const seen = new Map<string, number | undefined>();
  rawMonitors.forEach((item, i) => {
    const line = lineOf(monitorItems[i]);
    const name = isMap(monitorItems[i]) ? asString((item as Obj | null)?.name) : '';
    try {
      const monitor = parseMonitor(asObj(item, 'a monitor'), defaults);
      const key = monitor.name.toLowerCase();
      if (seen.has(key)) {
        errors.push({
          line,
          monitor: monitor.name,
          message: `duplicate name (first on line ${seen.get(key) ?? '?'})`,
        });
        return;
      }
      seen.set(key, line);
      file.monitors.push(monitor);
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      errors.push({ line, monitor: name || undefined, message: error.message });
    }
  });
  if (Array.isArray(root.maintenance)) {
    const windowNodes = doc.get('maintenance', true);
    const windowItems = isSeq(windowNodes) ? windowNodes.items : [];
    root.maintenance.forEach((item, i) => {
      try {
        file.maintenance.push(parseWindow(asObj(item, 'a maintenance window')));
      } catch (error) {
        if (!(error instanceof Problem)) throw error;
        errors.push({
          line: lineOf(windowItems[i]),
          window: asString((item as Obj | null)?.name) || undefined,
          message: error.message,
        });
      }
    });
  }
  return errors.length ? { errors } : { file, errors };
}
