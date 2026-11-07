// Maintenance schedules the way the control plane expands them
// (backend spec/maintenance.go): one-off windows, and daily, weekly or
// monthly ones at a wall-clock time in their time zone, with "end now" /
// "start now" overrides moving single occurrences.
import type {
  MaintenanceOccurrence,
  MaintenanceSchedule,
  MaintenanceWindow,
  Occurrence,
  Weekday,
} from '../../entity/synthetics';
import { DemoError } from '../router';
import type { StoredCheck, StoredWindow } from '../seed/synthetics';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEK_ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_ONE_OFF = 31 * DAY;
const MAX_EXPAND_DAYS = 800;
const PREVIEW_COUNT = 3;

// --- time zones -----------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = formatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, dtf);
  }
  return dtf;
}

export function validTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}

function wallOf(ms: number, timeZone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute };
}

/** How far the zone's clock is ahead of UTC at ms. */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallOf(ms, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  return asUtc - Math.floor(ms / MINUTE) * MINUTE;
}

/** The instant the zone's clock reads the wall time (a skipped time keeps the earlier offset). */
export function wallToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = offsetAt(guess, timeZone);
  const at = guess - first;
  const second = offsetAt(at, timeZone);
  return second === first ? at : guess - Math.max(first, second);
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateText = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function clock(text: string | undefined): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec((text ?? '').trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!(hour >= 0 && hour < 24 && minute >= 0 && minute < 60)) {
    throw new DemoError(400, `the start time must look like 22:00, not "${text ?? ''}"`);
  }
  return [hour, minute];
}

// --- schedules ------------------------------------------------------------------

/** Validates and fills a schedule like the backend's Normalize; throws a 400. */
export function normalizeSchedule(
  input: MaintenanceSchedule,
  now = Date.now(),
): MaintenanceSchedule {
  const kind = String(input.kind ?? '')
    .trim()
    .toLowerCase() as MaintenanceSchedule['kind'];
  const timeZone = (input.timeZone ?? '').trim() || 'UTC';
  if (!validTimeZone(timeZone)) throw new DemoError(400, `unknown time zone "${timeZone}"`);
  if (kind === 'once') {
    const start = Date.parse(input.startsAt ?? '');
    const end = Date.parse(input.endsAt ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new DemoError(400, 'a one-off window needs a start and an end');
    }
    if (end <= start) throw new DemoError(400, 'a window must end after it starts');
    if (end - start > MAX_ONE_OFF) {
      throw new DemoError(400, 'a one-off window can last at most 31 days');
    }
    return {
      kind,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      timeZone,
    };
  }
  let startTime = (input.startTime ?? '').trim();
  clock(startTime);
  if (startTime.length === 4) startTime = `0${startTime}`;
  const out: MaintenanceSchedule = {
    kind,
    timeZone,
    startTime,
    durationMinutes: input.durationMinutes,
  };
  let maxMinutes = 7 * 24 * 60;
  switch (kind) {
    case 'daily':
      maxMinutes = 24 * 60;
      break;
    case 'weekly': {
      const days = [
        ...new Set((input.weekdays ?? []).map((day) => day.trim().toLowerCase())),
      ] as Weekday[];
      if (days.length === 0) throw new DemoError(400, 'pick at least one weekday');
      const unknown = days.find((day) => !WEEK_ORDER.includes(day));
      if (unknown) throw new DemoError(400, `unknown weekday "${unknown}" (use mon to sun)`);
      out.weekdays = WEEK_ORDER.filter((day) => days.includes(day));
      break;
    }
    case 'monthly_day':
      if (!(Number(input.dayOfMonth) >= 1 && Number(input.dayOfMonth) <= 31)) {
        throw new DemoError(400, 'the day of the month must be 1 to 31');
      }
      out.dayOfMonth = Number(input.dayOfMonth);
      break;
    case 'monthly_weekday': {
      const week = Number(input.weekOfMonth);
      if (!((week >= 1 && week <= 4) || week === -1)) {
        throw new DemoError(400, 'the week of the month must be 1 to 4, or last');
      }
      const day = (input.weekday ?? '').trim().toLowerCase() as Weekday;
      if (!WEEK_ORDER.includes(day)) {
        throw new DemoError(400, `unknown weekday "${input.weekday ?? ''}" (use mon to sun)`);
      }
      out.weekOfMonth = week;
      out.weekday = day;
      break;
    }
    default:
      throw new DemoError(
        400,
        `unknown schedule "${String(input.kind)}" (once, daily, weekly, monthly_day or monthly_weekday)`,
      );
  }
  const minutes = Number(input.durationMinutes);
  if (!(minutes >= 1 && minutes <= maxMinutes)) {
    throw new DemoError(
      400,
      `the duration must be 1 minute to ${maxMinutes === 1440 ? '24 hours' : '7 days'}`,
    );
  }
  out.durationMinutes = Math.round(minutes);
  const dateOk = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text);
  let startDate = (input.startDate ?? '').trim();
  if (!startDate) {
    const w = wallOf(now, timeZone);
    startDate = dateText(w.y, w.m, w.d);
  }
  if (!dateOk(startDate)) {
    throw new DemoError(400, `the first date must look like 2026-11-02, not "${startDate}"`);
  }
  out.startDate = startDate;
  const endDate = (input.endDate ?? '').trim();
  if (endDate) {
    if (!dateOk(endDate)) {
      throw new DemoError(400, `the end date must look like 2026-11-02, not "${endDate}"`);
    }
    if (endDate < startDate) throw new DemoError(400, 'the end date is before the first date');
    out.endDate = endDate;
  }
  return out;
}

function onDay(s: MaintenanceSchedule, y: number, m: number, d: number): boolean {
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  switch (s.kind) {
    case 'daily':
      return true;
    case 'weekly':
      return (s.weekdays ?? []).includes(weekday);
    case 'monthly_day':
      return d === Math.min(s.dayOfMonth ?? 0, daysIn(y, m));
    case 'monthly_weekday':
      if (weekday !== s.weekday) return false;
      if (s.weekOfMonth === -1) return d + 7 > daysIn(y, m);
      return Math.floor((d - 1) / 7) + 1 === s.weekOfMonth;
    default:
      return false;
  }
}

export interface Span {
  start: number;
  end: number;
}

/** Occurrences overlapping [from, to), in order. */
export function occurrences(s: MaintenanceSchedule, from: number, to: number): Span[] {
  if (to <= from) return [];
  if (s.kind === 'once') {
    const start = Date.parse(s.startsAt ?? '');
    const end = Date.parse(s.endsAt ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= from || start >= to) return [];
    return [{ start, end }];
  }
  const timeZone = s.timeZone || 'UTC';
  if (!validTimeZone(timeZone)) return [];
  let hour: number;
  let minute: number;
  try {
    [hour, minute] = clock(s.startTime);
  } catch {
    return [];
  }
  const duration = (s.durationMinutes ?? 0) * MINUTE;
  if (duration <= 0) return [];
  const first = wallOf(from - duration, timeZone);
  const last = wallOf(to, timeZone);
  let day = Date.UTC(first.y, first.m - 1, first.d) - DAY;
  const lastDay = Date.UTC(last.y, last.m - 1, last.d);
  const out: Span[] = [];
  for (let i = 0; day <= lastDay && i < MAX_EXPAND_DAYS; i++, day += DAY) {
    const date = new Date(day);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const text = dateText(y, m, d);
    if (s.startDate && text < s.startDate) continue;
    if (s.endDate && text > s.endDate) continue;
    if (!onDay(s, y, m, d)) continue;
    const start = wallToUtc(y, m, d, hour, minute, timeZone);
    const end = start + duration;
    if (end > from && start < to) out.push({ start, end });
  }
  return out;
}

/** The next few occurrences, for the editor's preview. */
export function previewSchedule(schedule: MaintenanceSchedule, now = Date.now()) {
  const normalized = normalizeSchedule(schedule, now);
  let list: Span[];
  if (normalized.kind === 'once') {
    list = [{ start: Date.parse(normalized.startsAt!), end: Date.parse(normalized.endsAt!) }];
  } else {
    list = occurrences(normalized, now, now + 40 * DAY);
    if (list.length < PREVIEW_COUNT) list = occurrences(normalized, now, now + 400 * DAY);
    list = list.slice(0, PREVIEW_COUNT);
  }
  return { schedule: normalized, occurrences: list.map(toOccurrence) };
}

const toOccurrence = (span: Span): Occurrence => ({
  start: new Date(span.start).toISOString(),
  end: new Date(span.end).toISOString(),
});

// --- windows --------------------------------------------------------------------

interface Moved extends Span {
  scheduled: number;
}

/** A window's occurrences with its overrides applied; none while it's paused. */
export function windowOccurrences(window: StoredWindow, from: number, to: number): Moved[] {
  if (!window.enabled) return [];
  const moved = new Set(window.adjustments.map((a) => a.occurrence));
  const out: Moved[] = occurrences(window.schedule, from, to)
    .filter((span) => !moved.has(span.start))
    .map((span) => ({ ...span, scheduled: span.start }));
  for (const a of window.adjustments) {
    if (a.end > a.start && a.end > from && a.start < to) {
      out.push({ start: a.start, end: a.end, scheduled: a.occurrence });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function currentOccurrence(window: StoredWindow, now = Date.now()): Moved | undefined {
  return windowOccurrences(window, now, now + 1000).find(
    (item) => item.start <= now && item.end > now,
  );
}

export function nextOccurrence(window: StoredWindow, now = Date.now()): Moved | undefined {
  for (const horizon of [3 * DAY, 40 * DAY, 400 * DAY]) {
    const found = windowOccurrences(window, now, now + horizon).find((item) => item.start > now);
    if (found) return found;
  }
  return undefined;
}

export function covers(window: StoredWindow, check: StoredCheck): boolean {
  const scope = window.scope;
  if (scope.all || scope.monitorIds.includes(check.id)) return true;
  return scope.folders.some(
    (folder) => check.folder === folder || check.folder.startsWith(`${folder}/`),
  );
}

export function windowView(
  window: StoredWindow,
  checks: StoredCheck[],
  now = Date.now(),
): MaintenanceWindow {
  const current = currentOccurrence(window, now);
  const next = nextOccurrence(window, now);
  const past = windowOccurrences(window, now - 120 * DAY, now).filter((item) => item.end <= now);
  const lastEnded = past.length ? past[past.length - 1].end : undefined;
  const state: MaintenanceWindow['state'] = !window.enabled
    ? 'paused'
    : current
      ? 'active'
      : next
        ? 'upcoming'
        : 'past';
  return {
    id: window.id,
    name: window.name,
    reason: window.reason,
    scope: {
      all: window.scope.all,
      monitorIds: window.scope.monitorIds ?? [],
      folders: window.scope.folders ?? [],
    },
    schedule: window.schedule,
    enabled: window.enabled,
    version: window.version,
    createdBy: window.createdBy,
    createdAt: window.createdAt,
    updatedAt: window.updatedAt,
    state,
    current: current && toOccurrence(current),
    next: next && toOccurrence(next),
    lastEnded: lastEnded === undefined ? undefined : new Date(lastEnded).toISOString(),
    monitorIds: checks.filter((check) => covers(window, check)).map((check) => check.id),
  };
}

/** Occurrences of enabled windows in [from, to), with the monitors each covers. */
export function occurrencesBetween(
  windows: StoredWindow[],
  checks: StoredCheck[],
  from: number,
  to: number,
): MaintenanceOccurrence[] {
  const out: MaintenanceOccurrence[] = [];
  for (const window of windows) {
    const monitorIds = checks.filter((check) => covers(window, check)).map((check) => check.id);
    for (const item of windowOccurrences(window, from, to)) {
      out.push({
        windowId: window.id,
        name: window.name,
        reason: window.reason,
        start: new Date(item.start).toISOString(),
        end: new Date(item.end).toISOString(),
        monitorIds,
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Sets the override for its occurrence, forgetting old ones. */
export function withOverride(window: StoredWindow, next: Moved, now = Date.now()) {
  const kept = window.adjustments.filter(
    (a) => a.occurrence !== next.scheduled && a.end > now - 400 * DAY,
  );
  return [...kept, { occurrence: next.scheduled, start: next.start, end: next.end }];
}
