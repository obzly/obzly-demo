// Logs: search (plain and streamed), facets, patterns, anomalies, deploy
// markers, context, live tail and the log-source panel aggregation the
// histogram and dashboards use. SQL mode lives in ./sql.
import type { AggregationBucket, Panel } from '../../entity/dashboards';
import type {
  DeploysRequest,
  FieldValuesRequest,
  LogContextRequest,
  LogPatternsRequest,
  LogQueryRequest,
  PatternChangesRequest,
  QueryNode,
} from '../../entity/query';
import {
  ALL_TEMPLATES,
  type GenLog,
  SLOT_MS,
  countLogs,
  logById,
  patternHashOf,
  sampleMessage,
  slotLogs,
  slotOf,
  templateFor,
  toLogItem,
  totalLogs,
  walkLogs,
} from '../gen/logs';
import { probeRunLogs } from '../gen/synthetics';
import { goDuration, ndjson, sleep } from '../lib/http';
import { fieldValue, matcher, normalizeField } from '../query/evalNode';
import { DemoError, type Router } from '../router';
import { PROJECT_ID, WORKLOADS, dataStart, deploysFor, podsFor } from '../world';
import { requireProject } from './bootstrap';
import { registerSql } from './sql';

const HOUR = 3_600_000;

export function resolveRange(range: { from?: string; to?: string } | undefined, fallbackMs = HOUR) {
  const to = range?.to ? Date.parse(range.to) : Date.now();
  const from = range?.from ? Date.parse(range.from) : to - fallbackMs;
  if (!Number.isFinite(from) || !Number.isFinite(to))
    throw new DemoError(400, 'Invalid time range');
  return { from, to };
}

// --- search -----------------------------------------------------------------

interface SearchResult {
  logs: GenLog[];
  total: number;
  nextCursor?: string;
  partial?: boolean;
  searchedThrough?: string;
  countSkipped?: boolean;
  executedIn: string;
}

function search(projectId: string, req: LogQueryRequest): SearchResult {
  const started = performance.now();
  const { from, to } = resolveRange(req.timeRange, 14 * 24 * HOUR);
  const limit = Math.min(Math.max(req.limit ?? 100, 1), 1000);
  const order = req.sortOrder === 'asc' ? 'asc' : 'desc';
  const predicate = matcher(req.query);
  let cursorTs: number | undefined;
  let cursorId: string | undefined;
  if (req.cursor) {
    const [ts, id] = req.cursor.split('|');
    cursorTs = Number(ts);
    cursorId = id;
  }
  let skip = req.cursor ? 0 : (req.offset ?? 0);
  let passedCursor = cursorId === undefined;
  const logs: GenLog[] = [];
  const walkFrom = order === 'asc' && cursorTs !== undefined ? cursorTs : from;
  const walkTo = order === 'desc' && cursorTs !== undefined ? cursorTs : to;
  const walked = walkLogs(projectId, walkFrom, walkTo, order, (log) => {
    if (!passedCursor) {
      if (log.id === cursorId) passedCursor = true;
      return true;
    }
    if (!predicate(log)) return true;
    if (skip > 0) {
      skip--;
      return true;
    }
    logs.push(log);
    return logs.length <= limit; // one extra row tells there's a next page
  });
  const hasMore = logs.length > limit;
  if (hasMore) logs.length = limit;
  const last = logs[logs.length - 1];
  const partial = !walked.complete && !hasMore;
  let total = -1;
  if (req.trackTotal !== false && !req.cursor) {
    total =
      !hasMore && walked.complete && !req.offset
        ? logs.length
        : totalLogs(projectId, from, to, predicate);
    if (total < logs.length) total = logs.length;
  }
  return {
    logs,
    total,
    nextCursor: hasMore && last ? `${last.ts}|${last.id}` : undefined,
    partial: partial || undefined,
    searchedThrough: partial ? new Date(walked.reached).toISOString() : undefined,
    executedIn: goDuration(performance.now() - started + 20 + Math.random() * 40),
  };
}

// --- aggregation (histogram + logs panels) ------------------------------------

const groupKeyOf = (field: string | undefined) => {
  if (!field) return undefined;
  return (log: GenLog) => fieldValue(log, field) ?? '';
};

/** A logs-source panel's buckets: counts per time bucket (and group). */
export function aggregateLogPanel(
  projectId: string,
  panel: Panel,
  range: { from?: string; to?: string } | undefined,
): AggregationBucket[] {
  const { from, to } = resolveRange(range, 24 * HOUR);
  const span = Math.max(to - from, SLOT_MS);
  const auto = Math.max(SLOT_MS, Math.ceil(span / 120 / SLOT_MS) * SLOT_MS);
  const bucketMs =
    panel.bucketMs && panel.bucketMs >= 1000 ? Math.max(panel.bucketMs, SLOT_MS) : auto;
  const predicate = matcher(panel.query);
  const timeless = panel.type === 'pie' || panel.type === 'stat' || panel.type === 'table';
  const counts = countLogs(
    projectId,
    from,
    to,
    timeless ? span + 1 : bucketMs,
    predicate,
    groupKeyOf(panel.groupField),
  );
  const buckets: AggregationBucket[] = [];
  if (timeless) {
    const totals = new Map<string, number>();
    for (const groups of counts.values()) {
      for (const [key, count] of groups) totals.set(key, (totals.get(key) ?? 0) + count);
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, panel.limit || 20);
    for (const [key, count] of sorted) {
      buckets.push(
        panel.groupField ? { groupKey: key || '(empty)', value: count } : { value: count },
      );
    }
    if (!sorted.length && !panel.groupField) buckets.push({ value: 0 });
    return buckets;
  }
  // Keep the top groups by total so a high-cardinality field stays readable.
  const totals = new Map<string, number>();
  for (const groups of counts.values())
    for (const [k, c] of groups) totals.set(k, (totals.get(k) ?? 0) + c);
  const keep = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, panel.limit || 10)
      .map(([k]) => k),
  );
  for (const [bucket, groups] of counts) {
    const timestamp = new Date(bucket).toISOString();
    if (!panel.groupField) {
      buckets.push({ timestamp, value: groups.get('') ?? 0 });
      continue;
    }
    for (const [key, count] of groups) {
      if (keep.has(key)) buckets.push({ timestamp, groupKey: key || '(empty)', value: count });
    }
  }
  return buckets;
}

// --- facets -----------------------------------------------------------------

const SOURCE_FIELDS: Record<string, string> = {
  service: 'service_name',
  namespace: 'k8s_namespace_name',
  workload: 'k8s_deployment_name',
  container: 'k8s_container_name',
  pod: 'k8s_pod_name',
  node: 'k8s_node_name',
  cluster: 'k8s_cluster_name',
  host: 'host_name',
};

function facet(
  projectId: string,
  query: QueryNode | null | undefined,
  range: { from?: string; to?: string } | undefined,
  sampleRows: number | undefined,
  keyOf: (log: GenLog) => string | undefined,
) {
  const { from, to } = resolveRange(range);
  const predicate = matcher(query);
  const counts = new Map<string, { count: number; sample: GenLog }>();
  let matched = 0;
  const cap = sampleRows && sampleRows > 0 ? sampleRows : 50_000;
  const walked = walkLogs(projectId, from, to, 'desc', (log) => {
    if (!predicate(log)) return true;
    matched++;
    const key = keyOf(log);
    if (key !== undefined && key !== '') {
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { count: 1, sample: log });
    }
    return matched < cap;
  });
  let scale = 1;
  let sampledFrom: string | undefined;
  if (!walked.complete) {
    if (sampleRows) {
      sampledFrom = new Date(walked.reached).toISOString();
    } else {
      // No sample asked for: scale the counts up to the whole range.
      const total = totalLogs(projectId, from, to, predicate);
      scale = matched ? total / matched : 1;
      matched = total;
    }
  }
  if (scale !== 1)
    for (const entry of counts.values()) entry.count = Math.round(entry.count * scale);
  return { counts, matched, sampledFrom };
}

// --- live tail --------------------------------------------------------------

function liveTail(projectId: string, query: QueryNode | null, signal?: AbortSignal) {
  const predicate = matcher(query);
  return ndjson(async (send, aborted) => {
    send({ type: 'ready' });
    let cursor = slotOf(Date.now() - 2_000);
    let lastHeartbeat = Date.now();
    const seen = new Set<string>();
    while (!aborted.aborted) {
      const now = Date.now();
      const nowSlot = slotOf(now);
      for (let slot = cursor; slot <= nowSlot; slot++) {
        for (const log of slotLogs(slot, projectId, now)) {
          if (log.ts <= now - 15_000 || seen.has(log.id) || !predicate(log)) continue;
          seen.add(log.id);
          send({ type: 'log', log: toLogItem(log) });
        }
      }
      cursor = nowSlot;
      if (seen.size > 5000) seen.clear();
      if (now - lastHeartbeat > 10_000) {
        send({ type: 'heartbeat' });
        lastHeartbeat = now;
      }
      await sleep(1000, aborted);
    }
  }, signal);
}

// --- routes -----------------------------------------------------------------

export function register(r: Router) {
  registerSql(r);

  r.post('/logs/query/execute/:pid', (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as LogQueryRequest;
    // Synthetics run history is the probe's own logs: those come from its simulator.
    const runs = probeRunLogs(req.params.pid, body);
    if (runs) return runs;
    const result = search(req.params.pid, body);
    return {
      logs: result.logs.map(toLogItem),
      total: result.total,
      limit: body.limit ?? 100,
      offset: body.offset ?? 0,
      executedIn: result.executedIn,
      nextCursor: result.nextCursor,
      partial: result.partial,
      searchedThrough: result.searchedThrough,
    };
  });

  r.post('/logs/query/stream/:pid', (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as LogQueryRequest;
    const runs = probeRunLogs(req.params.pid, body);
    if (runs) {
      return ndjson(async (send) => {
        send({ type: 'rows', logs: runs.logs });
        send({
          type: 'done',
          total: runs.total,
          executedIn: runs.executedIn,
        });
      }, req.signal);
    }
    return ndjson(async (send, signal) => {
      send({ type: 'heartbeat' });
      const result = search(req.params.pid, body);
      // Rows arrive in a few windows, like the server's partition-by-partition reads.
      const chunk = Math.max(25, Math.ceil(result.logs.length / 3));
      for (let i = 0; i < result.logs.length; i += chunk) {
        await sleep(60, signal);
        send({ type: 'rows', logs: result.logs.slice(i, i + chunk).map(toLogItem) });
      }
      send({
        type: 'done',
        total: result.total,
        nextCursor: result.nextCursor,
        executedIn: result.executedIn,
        partial: result.partial,
        searchedThrough: result.searchedThrough,
      });
    }, req.signal);
  });

  r.post('/logs/query/patterns/:pid', (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as LogPatternsRequest;
    const { counts, matched, sampledFrom } = facet(
      req.params.pid,
      body.query,
      body.timeRange,
      body.sampleRows,
      (log) => log.template,
    );
    const patterns = [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, body.limit ?? 50)
      .map(([id, entry]) => ({
        hash: entry.sample.patternHash,
        pattern: templateFor(id)?.pattern ?? entry.sample.message,
        sample: entry.sample.message,
        count: entry.count,
      }));
    return { patterns, matchedRows: matched, sampledFrom };
  });

  r.post('/logs/query/field-values/:pid', (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as FieldValuesRequest;
    const field = SOURCE_FIELDS[body.field] ?? body.field;
    const { counts, matched, sampledFrom } = facet(
      req.params.pid,
      body.query,
      body.timeRange,
      body.sampleRows,
      (log) => fieldValue(log, field),
    );
    const values = [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, body.limit ?? 20)
      .map(([value, entry]) => ({ value, count: entry.count }));
    let recent: { value: string; lastSeen: string; inRange?: boolean }[] | undefined;
    if (body.includeRecent) {
      const listed = new Set(values.map((v) => v.value));
      const now = Date.now();
      const normalized = normalizeField(field);
      const candidates = new Map<string, number>();
      for (const workload of WORKLOADS) {
        const sample: Record<string, string[]> = {
          service_name: [workload.service],
          k8s_namespace_name: [workload.namespace],
          k8s_deployment_name: workload.kind === 'deployment' ? [workload.name] : [],
          k8s_container_name: [workload.container],
          k8s_cluster_name: ['harborline-prod'],
          k8s_pod_name: podsFor(workload, now).map((p) => p.name),
          k8s_node_name: podsFor(workload, now).map((p) => p.node),
        };
        for (const v of sample[normalized] ?? []) candidates.set(v, now - (v.length % 7) * 60_000);
      }
      if (normalized === 'service_name')
        candidates.set(
          'nightly-export',
          now - (((now % 86_400_000) - 140 * 60_000 + 86_400_000) % 86_400_000),
        );
      if (normalized === 'host_name')
        candidates.set('batch-01.harborline.example.com', now - 4 * HOUR);
      recent = [...candidates.entries()]
        .filter(([v]) => !listed.has(v))
        .sort((a, b) => b[1] - a[1])
        .map(([v, t]) => ({ value: v, lastSeen: new Date(t).toISOString() }));
    }
    return { values, matchedRows: matched, sampledFrom, recent };
  });

  r.post('/logs/query/changes/:pid', (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as PatternChangesRequest;
    const current = resolveRange(body.current);
    const baseline = resolveRange(body.baseline, 24 * HOUR);
    const predicate = matcher(body.query);
    const byTemplate = (from: number, to: number) => {
      const totals = new Map<string, number>();
      const span = Math.max(to - from, SLOT_MS);
      for (const groups of countLogs(
        req.params.pid,
        from,
        to,
        Math.ceil(span / 12 / SLOT_MS) * SLOT_MS,
        predicate,
        (log) => log.template,
      ).values()) {
        for (const [k, c] of groups) totals.set(k, (totals.get(k) ?? 0) + c);
      }
      return totals;
    };
    const cur = byTemplate(current.from, current.to);
    const base = byTemplate(baseline.from, baseline.to);
    const scale = (current.to - current.from) / Math.max(1, baseline.to - baseline.from);
    const minCount = body.minCount ?? 5;
    const changes = [];
    for (const template of ALL_TEMPLATES) {
      const c = cur.get(template.id) ?? 0;
      const b = base.get(template.id) ?? 0;
      const expected = b * scale;
      let change: 'new' | 'spike' | 'drop' | undefined;
      let ratio = expected > 0 ? c / expected : c > 0 ? 1e9 : 1;
      if (b === 0 && c >= minCount) change = 'new';
      else if (c >= minCount && ratio >= 2) change = 'spike';
      else if (expected >= minCount && ratio <= 0.4) change = 'drop';
      if (!change) continue;
      if (change === 'new') ratio = 1e9;
      changes.push({
        hash: '',
        template,
        pattern: template.pattern,
        sample: sampleMessage(template.id, current.to),
        level: template.level,
        current: c,
        baseline: b,
        change,
        ratio,
      });
    }
    changes.sort(
      (a, b) => (b.change === 'new' ? 1 : 0) - (a.change === 'new' ? 1 : 0) || b.ratio - a.ratio,
    );
    const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
    return {
      changes: changes
        .slice(0, body.limit ?? 20)
        .map(({ template, ...rest }) => ({ ...rest, hash: patternHashOf(template.id) })),
      currentTotal: sum(cur),
      baselineTotal: sum(base),
    };
  });

  r.post('/logs/query/deploys/:pid', (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as DeploysRequest;
    const { from, to } = resolveRange(body.timeRange, 24 * HOUR);
    const markers = WORKLOADS.filter((w) => w.kind === 'deployment').flatMap((workload) =>
      deploysFor(workload.service, Math.max(from, dataStart()), to).map((deploy) => {
        const pods = podsFor(workload, deploy.time + 1);
        return {
          time: new Date(deploy.time).toISOString(),
          namespace: workload.namespace,
          workload: workload.name,
          replicaSet: pods[0]?.replicaSet ?? workload.name,
          pods: pods.length,
        };
      }),
    );
    return { markers: markers.sort((a, b) => a.time.localeCompare(b.time)) };
  });

  r.post('/logs/query/context/:pid', (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as LogContextRequest;
    const anchor = logById(body.anchor.id, req.params.pid);
    const windowMinutes = body.windowMinutes ?? 10;
    if (!anchor) return { anchor: null, before: [], after: [], scope: [], windowMinutes };
    const scopeFields =
      body.scope ??
      [
        'k8s_cluster_name',
        'k8s_namespace_name',
        'k8s_deployment_name',
        'k8s_statefulset_name',
        'k8s_daemonset_name',
        'k8s_container_name',
        'service_name',
        'host_name',
      ].filter((f) => anchor.fields[f] !== undefined);
    const scope = scopeFields.map((field) => ({ field, value: fieldValue(anchor, field) ?? '' }));
    const extra = matcher(body.query);
    const inScope = (log: GenLog) =>
      scope.every((s) => fieldValue(log, s.field) === s.value) && extra(log);
    const windowMs = windowMinutes * 60_000;
    const collect = (direction: 'before' | 'after', count: number, cursor?: string) => {
      const out: GenLog[] = [];
      const pivot = cursor ? Number(cursor.split('|')[0]) : anchor.ts;
      const pivotId = cursor ? cursor.split('|')[1] : anchor.id;
      let passed = false;
      walkLogs(
        req.params.pid,
        direction === 'before' ? anchor.ts - windowMs : pivot,
        direction === 'before' ? pivot : anchor.ts + windowMs,
        direction === 'before' ? 'desc' : 'asc',
        (log) => {
          if (!passed) {
            if (log.id === pivotId) passed = true;
            else if (direction === 'before' ? log.ts < pivot : log.ts > pivot) passed = true;
            else return true;
            if (log.id === pivotId) return true;
          }
          if (inScope(log)) out.push(log);
          return out.length < count;
        },
      );
      return out;
    };
    const before =
      body.direction === 'after'
        ? []
        : collect(
            'before',
            body.before ?? 50,
            body.direction === 'before' ? body.cursor : undefined,
          );
    const after =
      body.direction === 'before'
        ? []
        : collect('after', body.after ?? 50, body.direction === 'after' ? body.cursor : undefined);
    const oldest = before[before.length - 1];
    const newest = after[after.length - 1];
    return {
      anchor: toLogItem(anchor),
      before: before.reverse().map(toLogItem),
      after: after.map(toLogItem),
      scope,
      beforeCursor:
        oldest && before.length >= (body.before ?? 50) ? `${oldest.ts}|${oldest.id}` : undefined,
      afterCursor:
        newest && after.length >= (body.after ?? 50) ? `${newest.ts}|${newest.id}` : undefined,
      windowMinutes,
    };
  });

  r.get('/logs/query/fields/:pid', (req) => {
    requireProject(req.params.pid);
    const filter = (req.query.get('query') ?? '').toLowerCase();
    const custom = new Set<string>();
    const now = Date.now();
    for (let slot = slotOf(now) - 360; slot <= slotOf(now); slot += 6) {
      for (const log of slotLogs(slot, req.params.pid, now))
        for (const key of Object.keys(log.fields)) custom.add(key);
    }
    const stringOps = ['equals', 'not_equals', 'contains', 'not_contains', 'exists', 'not_exists'];
    const predefined = [
      {
        name: 'message',
        type: 'string',
        operations: ['equals', 'not_equals', 'contains', 'not_contains'],
        isCustom: false,
      },
      {
        name: 'level',
        type: 'string',
        operations: ['equals', 'not_equals', 'in', 'not_in'],
        isCustom: false,
      },
      {
        name: 'client_ip',
        type: 'string',
        operations: ['equals', 'not_equals', 'contains', 'not_contains'],
        isCustom: false,
      },
      {
        name: 'pattern_hash',
        type: 'string',
        operations: ['equals', 'not_equals', 'in', 'not_in'],
        isCustom: false,
      },
      {
        name: 'timestamp',
        type: 'timestamp',
        operations: [
          'equals',
          'not_equals',
          'greater_than',
          'greater_or_equal',
          'less_than',
          'less_or_equal',
        ],
        isCustom: false,
      },
      {
        name: 'trace_id',
        type: 'string',
        operations: ['equals', 'not_equals', 'exists', 'not_exists'],
        isCustom: false,
      },
      {
        name: 'span_id',
        type: 'string',
        operations: ['equals', 'not_equals', 'exists', 'not_exists'],
        isCustom: false,
      },
    ];
    const names = new Set(predefined.map((f) => f.name));
    const fields = [
      ...predefined,
      ...[...custom]
        .filter((name) => !names.has(name))
        .sort()
        .map((name) =>
          name === 'duration_ms'
            ? {
                name,
                type: 'number',
                operations: [
                  'equals',
                  'not_equals',
                  'greater_than',
                  'greater_or_equal',
                  'less_than',
                  'less_or_equal',
                  'exists',
                  'not_exists',
                ],
                isCustom: true,
              }
            : { name, type: 'string', operations: stringOps, isCustom: true },
        ),
    ].filter((f) => !filter || f.name.toLowerCase().includes(filter));
    return { fields };
  });

  const stats = (projectId: string) => {
    const now = Date.now();
    const oldest = dataStart(now);
    const total = totalLogs(projectId, oldest, now, () => true);
    const rawMb = (total * 310) / 1024 / 1024;
    return {
      totalLogs: total,
      totalSizeMb: Math.round(rawMb * 0.11 * 10) / 10,
      rawSizeMb: Math.round(rawMb * 10) / 10,
      oldestLogTime: new Date(oldest).toISOString(),
      newestLogTime: new Date(now - 1500).toISOString(),
    };
  };
  r.get('/logs/query/stats/:pid', (req) => stats(requireProject(req.params.pid).id));
  r.get('/logs/query/system-stats', () => stats(PROJECT_ID));
  r.get('/logs/query/system-dashboard', () => {
    const base = stats(PROJECT_ID);
    const perMin = Math.round(144 * (0.8 + Math.random() * 0.3));
    return {
      ...base,
      ingestionWindowMinutes: 15,
      ingestedCount: perMin * 15,
      ingestedRawBytes: perMin * 15 * 310,
      avgIngestionRatePerMin: perMin,
      cpuPercent: 18 + Math.random() * 9,
      memoryUsedBytes: 2.6 * 1024 ** 3,
      memoryTotalBytes: 8 * 1024 ** 3,
      diskUsedBytes: 185 * 1024 ** 3,
      diskTotalBytes: 500 * 1024 ** 3,
    };
  });

  r.post('/logs/tail/:pid', (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as { query?: QueryNode | null };
    return liveTail(req.params.pid, body.query ?? null, req.signal);
  });

  r.post('/logs/receiving/:pid', () => ({ message: 'Accepted (demo: nothing is stored)' }));
}
