// Logs insights: the Patterns tab (pattern trends with new / spiking /
// dropping ones), "Explain this spike", Volume & noise and the Health map,
// all counted from the generated logs the way the server reads its
// per-minute counts.
import type {
  ExplainRequest,
  HealthMapGroupBy,
  HealthMapRequest,
  PatternTrendChange,
  PatternTrendsRequest,
  QueryNode,
} from '../../entity/query';
import {
  ALL_TEMPLATES,
  type GenLog,
  countLogs,
  patternHashOf,
  sampleMessage,
  templateFor,
  totalLogs,
} from '../gen/logs';
import { fieldValue, matcher } from '../query/evalNode';
import { DemoError, type Router } from '../router';
import { requireProject } from './bootstrap';
import { logStats, resolveRange } from './logs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TREND_BUCKETS = [1, 5, 15, 30, 60, 180, 360, 720, 1440].map((m) => m * MINUTE);
const TREND_MAX_BUCKETS = 60;
const TREND_MIN_COUNT = 5;
const EXPLAIN_MAX_FIELDS = 12;
const VOLUME_TOP_SERVICES = 6;
const VOLUME_NOISY = 10;
const HEALTH_MAX_TILES = 150;
const SEP = '\u0001';

const templateServices = new Map(ALL_TEMPLATES.map((t) => [t.id, t.service]));

/** A range cut to whole minutes, at least one minute long (the server's wholeMinuteRange). */
function wholeMinutes(range: { from?: string; to?: string } | undefined) {
  const { from, to } = resolveRange(range);
  const start = Math.floor(from / MINUTE) * MINUTE;
  const end = Math.max(Math.floor(to / MINUTE) * MINUTE, start + MINUTE);
  if (end - start > 31 * DAY) throw new DemoError(400, 'The range can be at most 31 days');
  return { from: start, to: end };
}

function trendBucket(requested: number | undefined, span: number): number {
  if (requested && requested > 0) {
    const rounded = Math.ceil(requested / MINUTE) * MINUTE;
    if (span / rounded <= TREND_MAX_BUCKETS) return rounded;
  }
  return TREND_BUCKETS.find((b) => span / b <= TREND_MAX_BUCKETS) ?? DAY;
}

/** Lines per key over [from, to), summed over buckets of bucketMs. */
function totalsBy(
  projectId: string,
  from: number,
  to: number,
  bucketMs: number,
  predicate: (log: GenLog) => boolean,
  keyOf: (log: GenLog) => string,
  samples = 24,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const groups of countLogs(
    projectId,
    from,
    to - 1,
    bucketMs,
    predicate,
    keyOf,
    samples,
  ).values()) {
    for (const [key, count] of groups) out.set(key, (out.get(key) ?? 0) + count);
  }
  return out;
}

function trendChange(current: number, yesterday: number, week: number): PatternTrendChange {
  if (yesterday === 0 && week === 0 && current >= TREND_MIN_COUNT) return 'new';
  if (yesterday > 0 && current >= TREND_MIN_COUNT && current >= 2 * yesterday) return 'spike';
  if (yesterday >= TREND_MIN_COUNT && 2 * current <= yesterday) return 'drop';
  return '';
}

function patternTrends(projectId: string, body: PatternTrendsRequest) {
  const { from, to } = wholeMinutes(body.timeRange);
  const span = to - from;
  const bucketMs = trendBucket(body.bucketMs, span);
  const limit = Math.min(Math.max(body.limit || 30, 1), 50);
  const predicate = matcher(body.query);
  const first = Math.floor(from / bucketMs) * bucketMs;
  const buckets: number[] = [];
  for (let b = first; b < to; b += bucketMs) buckets.push(b);
  const index = new Map(buckets.map((b, i) => [b, i]));

  const perBucket = countLogs(projectId, from, to - 1, bucketMs, predicate, (log) => log.template);
  const current = new Map<string, number>();
  const series = new Map<string, number[]>();
  const totals = new Array<number>(buckets.length).fill(0);
  for (const [bucket, groups] of perBucket) {
    const i = index.get(bucket);
    if (i === undefined) continue;
    for (const [template, count] of groups) {
      current.set(template, (current.get(template) ?? 0) + count);
      const row = series.get(template) ?? new Array<number>(buckets.length).fill(0);
      row[i] += count;
      series.set(template, row);
      totals[i] += count;
    }
  }
  const yesterday = totalsBy(
    projectId,
    from - DAY,
    to - DAY,
    bucketMs,
    predicate,
    (log) => log.template,
  );
  const week = totalsBy(
    projectId,
    from - 7 * DAY,
    from,
    6 * HOUR,
    predicate,
    (log) => log.template,
    36,
  );

  const ranked = [...current.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const changes = new Map<string, PatternTrendChange>();
  for (const [template, count] of ranked) {
    changes.set(
      template,
      trendChange(count, yesterday.get(template) ?? 0, week.get(template) ?? 0),
    );
  }
  const listed = ranked.slice(0, limit).map(([template]) => template);
  const other = [...totals];
  const patterns = listed.map((template) => {
    const row = series.get(template) ?? [];
    row.forEach((count, i) => (other[i] -= count));
    const meta = templateFor(template);
    return {
      hash: patternHashOf(template),
      pattern: meta?.pattern ?? template,
      sample: sampleMessage(template, to),
      level: meta?.level ?? 'info',
      services: [templateServices.get(template) ?? 'unknown'],
      count: current.get(template) ?? 0,
      series: row,
      yesterday: yesterday.get(template) ?? 0,
      previousWeek: week.get(template) ?? 0,
      change: changes.get(template) ?? '',
    };
  });
  const count = (kind: PatternTrendChange) =>
    [...changes.values()].filter((c) => c === kind).length;
  return {
    bucketMs,
    buckets: buckets.map((b) => new Date(b).toISOString()),
    total: totals.reduce((a, b) => a + b, 0),
    distinct: ranked.length,
    other: other.map((v) => Math.max(0, v)),
    newCount: count('new'),
    spikeCount: count('spike'),
    dropCount: count('drop'),
    patterns,
    partial: false,
  };
}

const EXPLAIN_FIELDS = [
  'service_name',
  'k8s_namespace_name',
  'k8s_container_name',
  'k8s_pod_name',
  'level',
];

function explain(projectId: string, body: ExplainRequest) {
  const current = wholeMinutes(body.current);
  const baseline = wholeMinutes(body.baseline);
  const predicate = matcher(body.query);
  const minCount = body.minCount && body.minCount > 0 ? body.minCount : 20;
  const keyOf = (log: GenLog) =>
    [
      ...EXPLAIN_FIELDS.map((f) => fieldValue(log, f) ?? ''),
      log.fields.k8s_replicaset_name ?? '',
    ].join(SEP);
  const marginals = (range: { from: number; to: number }) => {
    const span = range.to - range.from;
    const counts = totalsBy(projectId, range.from, range.to, span + 1, predicate, keyOf, 60);
    const values = new Map<string, number>();
    let total = 0;
    for (const [key, count] of counts) {
      total += count;
      const parts = key.split(SEP);
      [...EXPLAIN_FIELDS, 'k8s_replicaset'].forEach((field, i) => {
        if (parts[i]) {
          const id = `${field}${SEP}${parts[i]}`;
          values.set(id, (values.get(id) ?? 0) + count);
        }
      });
    }
    return { values, total };
  };
  const cur = marginals(current);
  const base = marginals(baseline);
  const fields = [];
  for (const [id, count] of cur.values) {
    if (count < minCount || cur.total === 0) continue;
    const [field, value] = id.split(SEP);
    const baselineCount = base.values.get(id) ?? 0;
    const currentShare = count / cur.total;
    const baselineShare = base.total ? baselineCount / base.total : 0;
    if (currentShare - baselineShare <= 0) continue;
    fields.push({
      field,
      value,
      current: count,
      baseline: baselineCount,
      currentShare,
      baselineShare,
      gain: currentShare - baselineShare,
    });
  }
  fields.sort(
    (a, b) => b.gain - a.gain || a.field.localeCompare(b.field) || a.value.localeCompare(b.value),
  );
  return {
    currentTotal: cur.total,
    baselineTotal: base.total,
    fields: fields.slice(0, EXPLAIN_MAX_FIELDS).map(({ gain: _gain, ...f }) => (void _gain, f)),
    partial: false,
  };
}

function volume(projectId: string, requestedDays: number | undefined) {
  const days = Math.min(Math.max(Math.floor(requestedDays || 14), 1), 31);
  const now = Math.floor(Date.now() / MINUTE) * MINUTE;
  const today = Math.floor(now / DAY) * DAY;
  const start = today - (days - 1) * DAY;
  const all = () => true;
  const dayList: number[] = [];
  for (let i = 0; i < days; i++) dayList.push(start + i * DAY);

  const perService = new Map<string, number[]>();
  const perDay = new Array<number>(days).fill(0);
  for (const [bucket, groups] of countLogs(
    projectId,
    start,
    now,
    DAY,
    all,
    (log) => log.fields.service_name ?? '',
    96,
  )) {
    const i = Math.round((bucket - start) / DAY);
    if (i < 0 || i >= days) continue;
    for (const [service, count] of groups) {
      const row = perService.get(service) ?? new Array<number>(days).fill(0);
      row[i] += count;
      perService.set(service, row);
      perDay[i] += count;
    }
  }
  const ranked = [...perService.entries()]
    .map(([name, counts]) => ({ name, counts, total: counts.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const services: { name: string; counts: number[]; total: number; other?: boolean }[] = [];
  const other = { name: 'other', counts: new Array<number>(days).fill(0), total: 0, other: true };
  ranked.forEach((row, rank) => {
    if (rank < VOLUME_TOP_SERVICES && row.name) services.push(row);
    else {
      other.total += row.total;
      row.counts.forEach((c, i) => (other.counts[i] += c));
    }
  });
  if (other.total > 0) services.push(other);

  const weekAgo = now - 7 * DAY;
  const levels = [
    ...totalsBy(projectId, weekAgo, now, 6 * HOUR, all, (log) => log.level, 36).entries(),
  ]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const stats = logStats(projectId);
  const noisyCounts = totalsBy(projectId, weekAgo, now, 6 * HOUR, all, (log) => log.template, 48);
  const activeDays = Math.max(1, perDay.slice(-7).filter((c) => c > 0).length);
  const noisy = [...noisyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, VOLUME_NOISY)
    .map(([template, count]) => {
      const meta = templateFor(template);
      return {
        hash: patternHashOf(template),
        pattern: meta?.pattern ?? template,
        sample: sampleMessage(template, now),
        service: templateServices.get(template) ?? '',
        level: meta?.level ?? 'info',
        count,
        perDay: count / activeDays,
      };
    });
  const storedBytes = Math.round(stats.totalSizeMb * 1024 * 1024);
  return {
    days: dayList.map((d) => new Date(d).toISOString()),
    services,
    levels,
    today: totalLogs(projectId, today, now, all),
    yesterdaySoFar: totalLogs(projectId, today - DAY, now - DAY, all),
    bytesPerLine: stats.totalLogs ? storedBytes / stats.totalLogs : 0,
    rawBytesPerLine: stats.totalLogs ? (stats.rawSizeMb * 1024 * 1024) / stats.totalLogs : 0,
    storedBytes,
    noisy,
    partial: false,
  };
}

/** A pod's workload, or the service outside Kubernetes. */
function workloadOf(log: GenLog): string {
  const f = log.fields;
  return (
    f.k8s_deployment_name ??
    f.k8s_statefulset_name ??
    f.k8s_daemonset_name ??
    f.service_name ??
    '(unknown)'
  );
}

const PLACE: Record<HealthMapGroupBy, (log: GenLog) => [string, string]> = {
  k8s: (log) => [log.fields.k8s_namespace_name ?? '(outside Kubernetes)', workloadOf(log)],
  // Collectors on the nodes set host.name to the node.
  host: (log) => [
    log.fields.host_name ?? log.fields.k8s_node_name ?? '(no host)',
    log.fields.service_name ?? '(unknown)',
  ],
  service: (log) => ['all services', log.fields.service_name ?? '(unknown)'],
};

function healthMap(projectId: string, body: HealthMapRequest) {
  const place = PLACE[body.groupBy];
  if (!place) throw new DemoError(400, 'groupBy must be "k8s", "host" or "service"');
  const { from, to } = wholeMinutes(body.timeRange);
  const predicate = matcher(body.query as QueryNode | null | undefined);
  const span = to - from;
  const current = totalsBy(
    projectId,
    from,
    to,
    span + 1,
    predicate,
    (log) => [...place(log), log.level].join(SEP),
    60,
  );
  const previous = totalsBy(
    projectId,
    from - DAY,
    to - DAY,
    span + 1,
    predicate,
    (log) => place(log).join(SEP),
    60,
  );
  const tiles = new Map<
    string,
    {
      group: string;
      name: string;
      total: number;
      errors: number;
      warnings: number;
      previous: number;
    }
  >();
  for (const [key, count] of current) {
    const [group, name, level] = key.split(SEP);
    const id = `${group}${SEP}${name}`;
    const tile = tiles.get(id) ?? { group, name, total: 0, errors: 0, warnings: 0, previous: 0 };
    tile.total += count;
    if (['error', 'fatal', 'critical'].includes(level)) tile.errors += count;
    else if (level === 'warn' || level === 'warning') tile.warnings += count;
    tiles.set(id, tile);
  }
  for (const [id, count] of previous) {
    const tile = tiles.get(id);
    if (tile) tile.previous += count;
  }
  const sorted = [...tiles.values()].sort(
    (a, b) => b.total - a.total || a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
  );
  const shown = sorted.slice(0, HEALTH_MAX_TILES);
  const groups: { name: string; total: number; tiles: ReturnType<typeof tileOut>[] }[] = [];
  const tileOut = (t: (typeof sorted)[number]) => ({
    name: t.name,
    total: t.total,
    errors: t.errors,
    warnings: t.warnings,
    previous: t.previous,
  });
  for (const tile of shown) {
    let group = groups.find((g) => g.name === tile.group);
    if (!group) groups.push((group = { name: tile.group, total: 0, tiles: [] }));
    group.total += tile.total;
    group.tiles.push(tileOut(tile));
  }
  groups.sort((a, b) => b.total - a.total);
  return {
    groupBy: body.groupBy,
    groups,
    hiddenTiles: sorted.length - shown.length,
    partial: false,
  };
}

export function register(r: Router) {
  r.post('/logs/query/pattern-trends/:pid', (req) =>
    patternTrends(requireProject(req.params.pid).id, (req.body ?? {}) as PatternTrendsRequest),
  );
  r.post('/logs/query/explain/:pid', (req) =>
    explain(requireProject(req.params.pid).id, (req.body ?? {}) as ExplainRequest),
  );
  r.post('/logs/query/volume/:pid', (req) =>
    volume(requireProject(req.params.pid).id, (req.body as { days?: number } | undefined)?.days),
  );
  r.post('/logs/query/health-map/:pid', (req) =>
    healthMap(requireProject(req.params.pid).id, (req.body ?? {}) as HealthMapRequest),
  );
}
