// Synthetics: monitors, destinations, probe groups, maintenance windows,
// YAML import/export and "Run test". Config is stored like any demo
// change (localStorage); results come from ../gen/synthetics, which also
// registers the synthetics_* metrics the charts query.
import type {
  CheckAlerts,
  CheckRequest,
  CheckView,
  Definition,
  DestinationRequest,
  ImportPreview,
  MaintenanceRequest,
  MaintenanceSchedule,
  Probe,
  ProbeMember,
  TestRequest,
  TestRun,
} from '../../entity/synthetics';
import {
  currentOccurrence,
  nextOccurrence,
  occurrencesBetween,
  previewSchedule,
  windowView,
  withOverride,
} from '../gen/maintenance';
import { type SimCheck, locationsOf, simulate } from '../gen/synthetics';
import { type FileMonitor, type FileWindow, exportFile, parseFile } from '../gen/syntheticsYaml';
import { text } from '../lib/http';
import { hashString, hex, mix, rng, uuidFrom } from '../lib/rng';
import { DemoError, type DemoRequest, type Router } from '../router';
import { cloudConnections } from '../seed/inventory';
import {
  DEMO_SITE_ID,
  type StoredCheck,
  type StoredProbe,
  type StoredWindow,
  checks,
  destinations,
  maintenanceWindows,
  probes,
} from '../seed/synthetics';
import { newId } from '../store';
import { DEMO_USER_ID } from '../world';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ONLINE_WITHIN = 3 * MINUTE;

const nowIso = () => new Date().toISOString();
const notFound = (what: string): never => {
  throw new DemoError(404, `${what} not found`);
};
const conflict = (message: string): never => {
  throw new DemoError(409, message);
};
const bad = (message: string): never => {
  throw new DemoError(400, message);
};

// --- probe groups -------------------------------------------------------------------

/** A seeded member's last contact: a few seconds ago while live. */
function lastSeen(member: StoredProbe['members'][number], now: number): number {
  if (member.silentForMs !== undefined) return now - member.silentForMs;
  return now - ((hashString(member.name) + Math.floor(now / 15_000)) % 14) * 1000 - 2000;
}

function enabledChecksAt(location: string): number {
  return checks.all().filter((check) => check.enabled && locationsOf(check).includes(location))
    .length;
}

export function probeView(probe: StoredProbe, now = Date.now()): Probe {
  const total = probe.created ? 0 : enabledChecksAt(probe.location);
  const recent = probe.members.filter((member) => now - lastSeen(member, now) < DAY);
  const live = recent.filter((member) => now - lastSeen(member, now) < MINUTE);
  const members: ProbeMember[] = recent.map((member) => {
    const isLive = now - lastSeen(member, now) < MINUTE;
    return {
      name: member.name,
      version: member.version,
      checks: isLive ? Math.ceil(total / Math.max(1, live.length)) : 0,
      firstSeen: new Date(now - member.firstSeenDays * DAY).toISOString(),
      lastSeenAt: new Date(lastSeen(member, now)).toISOString(),
      live: isLive,
    };
  });
  const latest = Math.max(...probe.members.map((member) => lastSeen(member, now)), -Infinity);
  const newest = [...members].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
  const online = Number.isFinite(latest) && now - latest < ONLINE_WITHIN;
  return {
    id: probe.id,
    name: probe.name,
    location: probe.location,
    description: probe.description,
    version: newest?.version ?? '',
    lastSeenAt: Number.isFinite(latest) ? new Date(latest).toISOString() : null,
    createdAt: probe.createdAt,
    online,
    checks: total,
    members,
  };
}

const newProbeToken = () => `obz_prb_${hex(mix(hashString(newId()), Date.now()), 48)}`;

// --- monitors -----------------------------------------------------------------------

const PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function placeholders(definition: Definition): string[] {
  const names = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER)) names.add(m[1]);
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  scan(definition);
  return [...names].sort();
}

export function checkView(check: StoredCheck): CheckView {
  const { destinationId, storedSecrets, ...rest } = check;
  const destination = destinations.get(destinationId);
  return {
    ...rest,
    destination: {
      id: destinationId,
      name: destination?.name ?? '',
      siteId: destination?.siteId ?? DEMO_SITE_ID,
      projectId: destination?.projectId ?? '',
    },
    secrets: placeholders(check.definition).map((name) => ({
      name,
      stored: storedSecrets.includes(name),
    })),
  };
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase());

const hostPort = /^[^\s:/]+:\d{1,5}$/;

/** Validates a monitor like the control plane's Normalize; returns the cleaned definition. */
function normalizeDefinition(input: Definition | undefined, intervalSeconds: number): Definition {
  if (!input) return bad('the check definition is required');
  const definition: Definition = structuredClone(input);
  definition.type = String(definition.type ?? '')
    .trim()
    .toLowerCase() as Definition['type'];
  const multi = definition.type === 'multi';
  const max = multi ? 120 : 60;
  definition.timeoutSeconds ||= multi ? 60 : 10;
  if (definition.timeoutSeconds < 1 || definition.timeoutSeconds > max) {
    bad(`timeout must be between 1s and ${max}s`);
  }
  if (definition.timeoutSeconds > intervalSeconds) {
    bad('timeout must not be longer than the interval');
  }
  const target = (definition.target ?? '').trim();
  switch (definition.type) {
    case 'http': {
      const request = definition.request;
      if (!request?.url?.trim()) return bad('request.url is required');
      request.url = request.url.trim();
      request.method = (request.method || 'GET').toUpperCase();
      break;
    }
    case 'tls':
    case 'tcp':
      if (!hostPort.test(target)) bad('target must be host:port, e.g. db.example.com:5432');
      break;
    case 'dns':
      if (!target) bad('target is required');
      definition.dns = { ...definition.dns, recordType: definition.dns?.recordType || 'A' };
      break;
    case 'icmp':
      if (!target) bad('target is required');
      break;
    case 'multi': {
      const steps = definition.steps ?? [];
      if (!steps.length || steps.length > 10) bad('a multi-step check needs 1 to 10 steps');
      steps.forEach((step, i) => {
        if (!step.request?.url?.trim()) bad(`step ${i + 1}: request.url is required`);
      });
      break;
    }
    default:
      bad(`type must be one of http, multi, tls, tcp, dns, icmp (got "${definition.type}")`);
  }
  if (target) definition.target = target;
  return definition;
}

function normalizeAlerts(alerts: CheckAlerts | undefined): CheckAlerts {
  if (!alerts?.channelIds?.length) {
    return { channelIds: [], notify: '', certDays: 0, repeatSeconds: 0 };
  }
  if (alerts.certDays < 0 || alerts.certDays > 365) {
    bad('alerts.cert_days must be between 0 and 365');
  }
  return { ...alerts, notify: alerts.notify || 'down' };
}

function fromRequest(request: CheckRequest, existing?: StoredCheck): StoredCheck {
  const name = (request.name ?? '').trim();
  if (!name) bad('name is required');
  if (name.length > 200) bad('name is longer than 200 characters');
  const clash = checks
    .all()
    .find((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== existing?.id);
  if (clash) conflict(`a monitor named "${name}" already exists`);
  const intervalSeconds = request.intervalSeconds || 180;
  if (intervalSeconds < 30) bad('interval must be at least 30s');
  if ((request.downLocations ?? 0) < 0) bad("down_locations can't be negative");
  if (!destinations.get(request.destinationId)) bad('pick where results go (a destination)');
  const definition = normalizeDefinition(request.definition, intervalSeconds);
  const parentIds = [...new Set(request.parentIds ?? [])];
  if (existing && parentIds.includes(existing.id)) bad("a monitor can't depend on itself");
  const names = placeholders(definition);
  let stored = (existing?.storedSecrets ?? []).filter((secret) => names.includes(secret));
  for (const [secret, value] of Object.entries(request.secrets ?? {})) {
    if (!names.includes(secret)) continue;
    stored = value ? [...new Set([...stored, secret])] : stored.filter((s) => s !== secret);
  }
  const now = nowIso();
  return {
    id: existing?.id ?? newId(),
    name,
    type: definition.type,
    enabled: !!request.enabled,
    folder: (request.folder ?? '')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('/'),
    parentIds,
    alerts: normalizeAlerts(request.alerts),
    intervalSeconds,
    downLocations: request.downLocations ?? 0,
    locations: [...new Set((request.locations ?? []).filter((l) => l && l !== 'all'))],
    destinationId: request.destinationId,
    definition,
    storedSecrets: stored,
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function requireCheck(id: string): StoredCheck {
  return checks.get(id) ?? notFound('Monitor');
}

/** A monitor name that isn't taken: "X (copy)", "X (copy 2)"... */
function freeName(base: string): string {
  const taken = new Set(checks.all().map((check) => check.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = base.replace(/\(copy\)$/, `(copy ${i})`);
    if (!taken.has(name.toLowerCase())) return name;
  }
}

// --- import / export ----------------------------------------------------------------

function toFileMonitor(check: StoredCheck, names: Map<string, string>): FileMonitor {
  return {
    name: check.name,
    enabled: check.enabled,
    intervalSeconds: check.intervalSeconds,
    locations: check.locations,
    destination: destinations.get(check.destinationId)?.name ?? '',
    downLocations: check.downLocations,
    definition: check.definition,
    folder: check.folder,
    parents: check.parentIds.map((id) => names.get(id)).filter((n): n is string => !!n),
  };
}

function toFileWindow(window: StoredWindow, names: Map<string, string>): FileWindow {
  return {
    name: window.name,
    reason: window.reason,
    enabled: window.enabled,
    all: window.scope.all,
    monitors: window.scope.monitorIds.map((id) => names.get(id)).filter((n): n is string => !!n),
    folders: window.scope.folders,
    schedule: window.schedule,
  };
}

/** JSON with sorted keys and no undefined values, so equal values compare equal. */
const json = (value: unknown): string =>
  JSON.stringify(value ?? null, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

function describeChanges(old: StoredCheck, next: StoredCheck, secrets: Record<string, string>) {
  const changes: string[] = [];
  const locationsText = (l: string[]) => (l.length ? l.join(', ') : 'all');
  if (old.enabled !== next.enabled) changes.push(next.enabled ? 'enabled' : 'disabled');
  if (old.intervalSeconds !== next.intervalSeconds) {
    changes.push(`interval ${old.intervalSeconds}s → ${next.intervalSeconds}s`);
  }
  if (old.downLocations !== next.downLocations) {
    changes.push(`down_locations ${old.downLocations} → ${next.downLocations}`);
  }
  if (json(old.locations) !== json(next.locations)) {
    changes.push(`locations ${locationsText(old.locations)} → ${locationsText(next.locations)}`);
  }
  if (old.destinationId !== next.destinationId) changes.push('destination changed');
  const a = old.definition;
  const b = next.definition;
  if (a.type !== b.type) changes.push(`type ${a.type} → ${b.type}`);
  if (a.timeoutSeconds !== b.timeoutSeconds) {
    changes.push(`timeout ${a.timeoutSeconds}s → ${b.timeoutSeconds}s`);
  }
  const target = (d: Definition) => d.request?.url ?? d.steps?.[0]?.request.url ?? d.target ?? '';
  if (target(a) !== target(b)) changes.push(`target ${target(a)} → ${target(b)}`);
  else if (json(a.request) !== json(b.request)) changes.push('request changed');
  if (json(a.assertions ?? []) !== json(b.assertions ?? [])) {
    changes.push(`assertions ${a.assertions?.length ?? 0} → ${b.assertions?.length ?? 0}`);
  }
  if ((a.steps?.length ?? 0) !== (b.steps?.length ?? 0)) {
    changes.push(`steps ${a.steps?.length ?? 0} → ${b.steps?.length ?? 0}`);
  } else if (json(a.steps) !== json(b.steps)) changes.push('steps changed');
  if (json(a.variables) !== json(b.variables)) changes.push('variables changed');
  for (const part of ['tls', 'dns', 'icmp'] as const) {
    if (json(a[part]) !== json(b[part])) changes.push(`${part} options changed`);
  }
  if (placeholders(b).some((name) => secrets[name])) changes.push('secret values updated');
  if (old.folder !== next.folder) changes.push(`folder "${old.folder}" → "${next.folder}"`);
  if (json(old.parentIds) !== json(next.parentIds)) {
    changes.push(`depends_on ${old.parentIds.length} → ${next.parentIds.length}`);
  }
  return changes;
}

const emptyPreview = (): ImportPreview => ({
  create: [],
  update: [],
  unchanged: [],
  delete: [],
  secrets: [],
  errors: [],
  applied: false,
  maintenance: { create: [], update: [], unchanged: [], delete: [] },
});

function planImport(yaml: string, secrets: Record<string, string>, apply: boolean): ImportPreview {
  const preview = emptyPreview();
  const maintenance = preview.maintenance!;
  const { file, errors } = parseFile(yaml ?? '');
  if (!file) {
    preview.errors = errors;
    return preview;
  }
  const allDestinations = destinations.all();
  const existing = checks.all();
  const existingByName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
  const ids = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  for (const monitor of file.monitors) {
    if (!ids.has(monitor.name.toLowerCase())) ids.set(monitor.name.toLowerCase(), newId());
  }
  const now = nowIso();
  const creates: StoredCheck[] = [];
  const updates: StoredCheck[] = [];
  const secretStates = new Map<string, boolean>();
  for (const monitor of file.monitors) {
    const destination = monitor.destination
      ? allDestinations.find((d) => d.name.toLowerCase() === monitor.destination.toLowerCase())
      : allDestinations.length === 1
        ? allDestinations[0]
        : undefined;
    if (!destination) {
      preview.errors.push({
        monitor: monitor.name,
        message: monitor.destination
          ? `destination "${monitor.destination}" doesn't exist; create it under Synthetics → Destinations first`
          : "destination is required (there isn't exactly one to default to)",
      });
      continue;
    }
    const parentIds: string[] = [];
    let problem = '';
    for (const parent of monitor.parents) {
      const id = ids.get(parent.toLowerCase());
      if (!id) problem = `depends_on: no monitor named "${parent}"`;
      else parentIds.push(id);
    }
    if (monitor.alerts?.channels.length) {
      problem ||= `alerts: no channel named "${monitor.alerts.channels[0]}" in Obzly settings`;
    }
    if (problem) {
      preview.errors.push({ monitor: monitor.name, message: problem });
      continue;
    }
    const previous = existingByName.get(monitor.name.toLowerCase());
    const names = placeholders(monitor.definition);
    const stored = names.filter(
      (name) => !!secrets[name] || (previous?.storedSecrets.includes(name) ?? false),
    );
    for (const name of names) {
      secretStates.set(name, (secretStates.get(name) ?? false) || stored.includes(name));
    }
    const check: StoredCheck = {
      id: ids.get(monitor.name.toLowerCase())!,
      name: monitor.name,
      type: monitor.definition.type,
      enabled: monitor.enabled,
      folder: monitor.folder,
      parentIds,
      alerts: previous?.alerts ?? { channelIds: [], notify: '', certDays: 0, repeatSeconds: 0 },
      intervalSeconds: monitor.intervalSeconds,
      downLocations: monitor.downLocations,
      locations: monitor.locations,
      destinationId: destination.id,
      definition: monitor.definition,
      storedSecrets: stored,
      version: previous ? previous.version + 1 : 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (!previous) {
      creates.push(check);
      preview.create.push(check.name);
      continue;
    }
    const changes = describeChanges(previous, check, secrets);
    if (!changes.length) preview.unchanged.push(check.name);
    else {
      updates.push(check);
      preview.update.push({ name: check.name, changes });
    }
  }
  const inFile = new Set(file.monitors.map((m) => m.name.toLowerCase()));
  const deletes = file.prune ? existing.filter((c) => !inFile.has(c.name.toLowerCase())) : [];
  preview.delete = deletes.map((c) => c.name);

  // Maintenance windows, only when the file has a list.
  const windowCreates: StoredWindow[] = [];
  const windowUpdates: StoredWindow[] = [];
  let windowDeletes: StoredWindow[] = [];
  if (file.hasMaintenance) {
    const windows = maintenanceWindows.all();
    const byWindowName = new Map(windows.map((w) => [w.name.toLowerCase(), w]));
    const pruned = new Set(deletes.map((c) => c.name.toLowerCase()));
    for (const item of file.maintenance) {
      const monitorIds: string[] = [];
      let problem = '';
      for (const name of item.monitors) {
        const id = ids.get(name.toLowerCase());
        if (!id || pruned.has(name.toLowerCase())) problem = `no monitor named "${name}"`;
        else monitorIds.push(id);
      }
      if (problem) {
        preview.errors.push({ window: item.name, message: problem });
        continue;
      }
      const previous = byWindowName.get(item.name.toLowerCase());
      const window: StoredWindow = {
        id: previous?.id ?? newId(),
        name: item.name,
        reason: item.reason,
        scope: { all: item.all, monitorIds, folders: item.folders },
        schedule: item.schedule,
        enabled: item.enabled,
        version: previous ? previous.version + 1 : 1,
        createdBy: previous?.createdBy ?? DEMO_USER_ID,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        adjustments: [],
      };
      if (!previous) {
        windowCreates.push(window);
        maintenance.create.push(window.name);
        continue;
      }
      const changes: string[] = [];
      if (previous.reason !== window.reason) changes.push('reason changed');
      if (previous.enabled !== window.enabled) changes.push(window.enabled ? 'enabled' : 'paused');
      const scope = (s: StoredWindow['scope']) =>
        json({ all: s.all, ids: [...s.monitorIds].sort(), folders: [...s.folders].sort() });
      if (scope(previous.scope) !== scope(window.scope)) changes.push('monitors covered changed');
      // A file leaves the first date out when it has none; compare without it then.
      const comparable = (s: MaintenanceSchedule) =>
        json(item.schedule.startDate ? s : { ...s, startDate: undefined });
      const sameSchedule = comparable(previous.schedule) === comparable(window.schedule);
      if (!sameSchedule) changes.push('schedule changed');
      if (!changes.length) {
        maintenance.unchanged.push(window.name);
        continue;
      }
      if (sameSchedule) {
        window.schedule = previous.schedule;
        window.adjustments = previous.adjustments;
      }
      windowUpdates.push(window);
      maintenance.update.push({ name: window.name, changes });
    }
    if (file.prune) {
      const named = new Set(file.maintenance.map((w) => w.name.toLowerCase()));
      windowDeletes = windows.filter((w) => !named.has(w.name.toLowerCase()));
      maintenance.delete = windowDeletes.map((w) => w.name);
    }
  }
  preview.secrets = [...secretStates.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, stored]) => ({ name, stored }));
  if (!apply || preview.errors.length) return preview;

  const deleted = new Set(deletes.map((c) => c.id));
  const updated = new Map(updates.map((c) => [c.id, c]));
  checks.replaceAll([
    ...existing.filter((c) => !deleted.has(c.id)).map((c) => updated.get(c.id) ?? c),
    ...creates,
  ]);
  if (file.hasMaintenance) {
    const gone = new Set(windowDeletes.map((w) => w.id));
    const changed = new Map(windowUpdates.map((w) => [w.id, w]));
    maintenanceWindows.replaceAll([
      ...maintenanceWindows
        .all()
        .filter((w) => !gone.has(w.id))
        .map((w) => changed.get(w.id) ?? w),
      ...windowCreates,
    ]);
  }
  preview.applied = true;
  return preview;
}

// --- tests --------------------------------------------------------------------------

interface PendingTest {
  run: TestRun;
  created: number;
  check: SimCheck;
}

const tests = new Map<string, PendingTest>();
/** How long a probe takes to pick a test up and answer. */
export const TEST_DELAY_MS = 1_500;

function startTest(request: TestRequest): TestRun {
  const check = request.check;
  if (!check) return bad('the check to test is required');
  const definition = normalizeDefinition(check.definition, check.intervalSeconds || 180);
  const sim: SimCheck = {
    id: request.checkId ?? uuidFrom(`test:${check.name}`),
    name: (check.name ?? '').trim() || 'Untitled monitor',
    type: definition.type,
    definition,
  };
  const id = newId();
  const created = Date.now();
  let tasks: TestRun['tasks'];
  if (request.fromControlPlane) {
    const result = simulate(sim, 'control-plane', 'control-plane', created, rng(hashString(id)));
    result.fromControlPlane = true;
    tasks = [
      { id: newId(), location: 'control-plane', probe: 'control-plane', status: 'done', result },
    ];
  } else {
    const online = probes
      .all()
      .map((probe) => probeView(probe, created))
      .filter((probe) => probe.online);
    const locations = (
      request.locations?.length
        ? request.locations
        : [...new Set(online.map((probe) => probe.location))].sort()
    ).filter((location) => location && location !== 'all');
    if (!locations.length) bad('no probe is online; start one, or test from the control plane');
    tasks = locations.map((location) => {
      const probe = online.find((p) => p.location === location);
      return probe
        ? { id: newId(), location, probe: probe.name, status: 'queued' as const }
        : { id: newId(), location, probe: '', status: 'no_probe' as const };
    });
  }
  const run: TestRun = { id, tasks };
  tests.set(id, { run, created, check: sim });
  for (const [key, test] of tests) if (created - test.created > 10 * MINUTE) tests.delete(key);
  return run;
}

function getTest(id: string, now = Date.now()): TestRun {
  const test = tests.get(id);
  if (!test) return notFound('Test');
  const tasks = test.run.tasks.map((task, i) => {
    // Locations answer one after another.
    const ready = now - test.created >= TEST_DELAY_MS + i * 300;
    if (task.status !== 'queued' || !ready) return task;
    const result = simulate(
      test.check,
      task.location,
      task.probe,
      test.created + 400 + i * 120,
      rng(mix(hashString(id), hashString(task.location))),
    );
    return { ...task, status: 'done' as const, result };
  });
  return { id, tasks };
}

// --- maintenance --------------------------------------------------------------------

function requireWindow(id: string): StoredWindow {
  return maintenanceWindows.get(id) ?? notFound('Maintenance window');
}

function windowFrom(request: MaintenanceRequest, existing?: StoredWindow): StoredWindow {
  const name = (request.name ?? '').trim();
  const reason = (request.reason ?? '').trim();
  if (!name) bad('name is required');
  if (name.length > 200 || reason.length > 500) {
    bad('the name can be at most 200 characters and the reason 500');
  }
  const clash = maintenanceWindows
    .all()
    .find((w) => w.name.toLowerCase() === name.toLowerCase() && w.id !== existing?.id);
  if (clash) conflict(`a maintenance window named "${name}" already exists`);
  const scope = request.scope ?? { all: false, monitorIds: [], folders: [] };
  const folders = [
    ...new Set(
      (scope.folders ?? [])
        .map((f) =>
          f
            .split('/')
            .map((p) => p.trim())
            .filter(Boolean)
            .join('/'),
        )
        .filter(Boolean),
    ),
  ];
  const monitorIds = [...new Set(scope.monitorIds ?? [])];
  if (!scope.all && !monitorIds.length && !folders.length) {
    bad('choose the monitors, folders or all monitors it covers');
  }
  if (!request.schedule) bad('schedule is required');
  const schedule = previewSchedule(request.schedule).schedule;
  const now = nowIso();
  const sameSchedule = !!existing && JSON.stringify(existing.schedule) === JSON.stringify(schedule);
  return {
    id: existing?.id ?? newId(),
    name,
    reason,
    scope: scope.all
      ? { all: true, monitorIds: [], folders: [] }
      : { all: false, monitorIds, folders },
    schedule,
    enabled: !!request.enabled,
    version: existing ? existing.version + 1 : 1,
    createdBy: existing?.createdBy ?? DEMO_USER_ID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    adjustments: sameSchedule && existing ? existing.adjustments : [],
  };
}

const viewOf = (window: StoredWindow) => windowView(window, checks.all());

// --- routes -------------------------------------------------------------------------

const body = <T>(req: DemoRequest) => (req.body ?? {}) as T;

export function register(r: Router) {
  // Monitors.
  r.get('/synthetics/checks', () => checks.all().sort(byName).map(checkView));
  r.post('/synthetics/checks', (req) =>
    checkView(checks.insert(fromRequest(body<CheckRequest>(req)))),
  );
  r.get('/synthetics/checks/export', (req) => {
    const ids = (req.query.get('ids') ?? '').split(',').filter(Boolean);
    const all = checks.all();
    const names = new Map(all.map((c) => [c.id, c.name]));
    const selected = all.filter((check) => !ids.length || ids.includes(check.id));
    const yaml = exportFile(
      selected.map((check) => toFileMonitor(check, names)),
      // A selection leaves windows out: they may name monitors not in it.
      ids.length ? undefined : maintenanceWindows.all().map((w) => toFileWindow(w, names)),
    );
    return text(yaml, 'application/yaml');
  });
  r.post('/synthetics/checks/import/preview', (req) => {
    const { yaml, secrets } = body<{ yaml: string; secrets?: Record<string, string> }>(req);
    return planImport(yaml, secrets ?? {}, false);
  });
  r.post('/synthetics/checks/import', (req) => {
    const { yaml, secrets } = body<{ yaml: string; secrets?: Record<string, string> }>(req);
    return planImport(yaml, secrets ?? {}, true);
  });
  r.get('/synthetics/checks/:id', (req) => checkView(requireCheck(req.params.id)));
  r.put('/synthetics/checks/:id', (req) => {
    const existing = requireCheck(req.params.id);
    const request = body<CheckRequest>(req);
    if (request.version !== undefined && request.version !== existing.version) {
      conflict('this monitor was changed by someone else; reload it to see their changes');
    }
    const check = fromRequest(request, existing);
    checks.update(check.id, check);
    return checkView(check);
  });
  r.delete('/synthetics/checks/:id', (req) => {
    const id = requireCheck(req.params.id).id;
    checks.remove(id);
    // Monitors forget it as a parent, windows as a monitor they cover.
    for (const check of checks.all()) {
      if (check.parentIds.includes(id)) {
        checks.update(check.id, { parentIds: check.parentIds.filter((p) => p !== id) });
      }
    }
    for (const window of maintenanceWindows.all()) {
      if (window.scope.monitorIds.includes(id)) {
        maintenanceWindows.update(window.id, {
          scope: { ...window.scope, monitorIds: window.scope.monitorIds.filter((m) => m !== id) },
        });
      }
    }
    return { message: 'Monitor deleted' };
  });
  r.post('/synthetics/checks/:id/enabled', (req) => {
    const existing = requireCheck(req.params.id);
    const { enabled, version } = body<{ enabled: boolean; version?: number }>(req);
    if (version !== undefined && version !== existing.version) {
      conflict('this monitor was changed by someone else; reload it to see their changes');
    }
    const updated = checks.update(existing.id, {
      enabled: !!enabled,
      version: existing.version + 1,
      updatedAt: nowIso(),
    });
    return checkView(updated!);
  });
  r.post('/synthetics/checks/:id/clone', (req) => {
    const original = requireCheck(req.params.id);
    const now = nowIso();
    return checkView(
      checks.insert({
        ...structuredClone(original),
        id: newId(),
        name: freeName(`${original.name} (copy)`),
        enabled: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
  });

  // Destinations.
  r.get('/synthetics/destinations', () => destinations.all().sort(byName));
  r.post('/synthetics/destinations', (req) => {
    const request = body<DestinationRequest>(req);
    const name = (request.name ?? '').trim();
    if (!name) bad('name is required');
    if (!request.siteId || !request.projectId) bad('pick the Site and project results go to');
    if (!/^https?:\/\//.test(request.otlpUrl ?? '')) bad('the OTLP URL must start with https://');
    if (!request.apiKey) bad('an ingest API key is required');
    if (destinations.all().some((d) => d.name.toLowerCase() === name.toLowerCase())) {
      conflict(`a destination named "${name}" already exists`);
    }
    return destinations.insert({
      id: newId(),
      name,
      siteId: request.siteId,
      projectId: request.projectId,
      otlpUrl: request.otlpUrl.trim(),
      apiKeyHint: `${request.apiKey.slice(0, 4)}…${request.apiKey.slice(-4)}`,
      createdAt: nowIso(),
    });
  });
  r.put('/synthetics/destinations/:id', (req) => {
    const existing = destinations.get(req.params.id) ?? notFound('Destination');
    const request = body<DestinationRequest>(req);
    return destinations.update(existing.id, {
      name: (request.name ?? '').trim() || existing.name,
      siteId: request.siteId || existing.siteId,
      projectId: request.projectId || existing.projectId,
      otlpUrl: request.otlpUrl?.trim() || existing.otlpUrl,
      apiKeyHint: request.apiKey
        ? `${request.apiKey.slice(0, 4)}…${request.apiKey.slice(-4)}`
        : existing.apiKeyHint,
    });
  });
  r.delete('/synthetics/destinations/:id', (req) => {
    const id = (destinations.get(req.params.id) ?? notFound('Destination')).id;
    if (checks.all().some((check) => check.destinationId === id)) {
      conflict('monitors still send results to this destination');
    }
    if (cloudConnections.all().some((c) => c.destinationId === id)) {
      conflict('a cloud connection still uses it; change or delete the connection first');
    }
    destinations.remove(id);
    return { message: 'Destination deleted' };
  });

  // Probe groups.
  r.get('/synthetics/probes', () => {
    const now = Date.now();
    return probes
      .all()
      .sort(byName)
      .map((probe) => probeView(probe, now));
  });
  r.post('/synthetics/probes', (req) => {
    const request = body<{ name: string; location: string; description?: string }>(req);
    const name = (request.name ?? '').trim();
    const location = (request.location ?? '').trim();
    if (!name || !location) bad('a probe group needs a name and a location label');
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(location)) {
      bad('the location label is lower-case letters, digits, dots, dashes or underscores');
    }
    if (probes.all().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      conflict(`a probe group named "${name}" already exists`);
    }
    const probe = probes.insert({
      id: newId(),
      name,
      location,
      description: (request.description ?? '').trim(),
      createdAt: nowIso(),
      members: [],
      created: true,
    });
    return { probe: probeView(probe), token: newProbeToken() };
  });
  r.post('/synthetics/probes/:id/token', (req) => {
    const probe = probes.get(req.params.id) ?? notFound('Probe group');
    return { probe: probeView(probe), token: newProbeToken() };
  });
  r.delete('/synthetics/probes/:id', (req) => {
    const id = (probes.get(req.params.id) ?? notFound('Probe group')).id;
    if (cloudConnections.all().some((c) => c.probeId === id)) {
      conflict('a cloud connection still uses it; change or delete the connection first');
    }
    probes.remove(id);
    return { message: 'Probe group deleted' };
  });

  // Run test.
  r.post('/synthetics/tests', (req) => startTest(body<TestRequest>(req)));
  r.get('/synthetics/tests/:id', (req) => getTest(req.params.id));

  // Maintenance windows.
  r.get('/synthetics/maintenance', () => maintenanceWindows.all().sort(byName).map(viewOf));
  r.post('/synthetics/maintenance', (req) =>
    viewOf(maintenanceWindows.insert(windowFrom(body<MaintenanceRequest>(req)))),
  );
  r.get('/synthetics/maintenance/occurrences', (req) => {
    const from = Date.parse(req.query.get('from') ?? '');
    const to = Date.parse(req.query.get('to') ?? '');
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 93 * DAY) {
      bad('from must be before to, at most 93 days apart');
    }
    return occurrencesBetween(maintenanceWindows.all(), checks.all(), from, to);
  });
  r.post('/synthetics/maintenance/preview', (req) => {
    const { schedule } = body<{ schedule?: MaintenanceSchedule }>(req);
    if (!schedule) return bad('schedule is required');
    return previewSchedule(schedule);
  });
  r.get('/synthetics/maintenance/:id', (req) => viewOf(requireWindow(req.params.id)));
  r.put('/synthetics/maintenance/:id', (req) => {
    const existing = requireWindow(req.params.id);
    const request = body<MaintenanceRequest>(req);
    if (request.version !== undefined && request.version !== existing.version) {
      conflict(
        'this maintenance window was changed by someone else; reload it to see their changes',
      );
    }
    const window = windowFrom(request, existing);
    maintenanceWindows.update(window.id, window);
    return viewOf(window);
  });
  r.delete('/synthetics/maintenance/:id', (req) => {
    maintenanceWindows.remove(requireWindow(req.params.id).id);
    return { message: 'Maintenance window deleted' };
  });
  r.post('/synthetics/maintenance/:id/end', (req) => {
    const window = requireWindow(req.params.id);
    const now = Date.now();
    const current = currentOccurrence(window, now) ?? bad("this window isn't in progress");
    const adjustments = withOverride(window, { ...current, end: now }, now);
    const updated = maintenanceWindows.update(window.id, {
      adjustments,
      version: window.version + 1,
      updatedAt: nowIso(),
    });
    return viewOf(updated!);
  });
  r.post('/synthetics/maintenance/:id/start', (req) => {
    const window = requireWindow(req.params.id);
    if (!window.enabled) bad('this window is paused; enable it first');
    const now = Date.now();
    if (currentOccurrence(window, now)) bad('this window is already in progress');
    const next = nextOccurrence(window, now) ?? bad('this window has no upcoming occurrence');
    const adjustments = withOverride(
      window,
      { scheduled: next.scheduled, start: now, end: now + (next.end - next.start) },
      now,
    );
    const updated = maintenanceWindows.update(window.id, {
      adjustments,
      version: window.version + 1,
      updatedAt: nowIso(),
    });
    return viewOf(updated!);
  });
}
