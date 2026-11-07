// Alerting: rules (with live previews over the demo's logs, traces and
// metrics), the alerts the recurring incident raises and clears, silences,
// project channels and the deployment-level channels and email settings.
// Nothing is ever sent: channel tests answer "(demo: nothing was sent)".
import type {
  AlertRule,
  AlertView,
  ChannelConfig,
  ChannelKind,
  Matcher,
  NotificationChannel,
  PreviewSeries,
  RuleRequest,
  SMTPRequest,
  SMTPSettings,
  SettingsChannel,
  SettingsChannelRequest,
  SettingsSync,
  Silence,
  SilenceRequest,
} from '../../entity/alerting';
import type { AggregationBucket, Panel } from '../../entity/dashboards';
import { ALL_TEMPLATES, patternHashOf } from '../gen/logs';
import { hashString, hex } from '../lib/rng';
import { evaluatePromQL } from '../query/promql';
import { DemoError, type Router, notInDemo } from '../router';
import {
  INCIDENT_ALERTS,
  type StoredChannel,
  describeChannel,
  seedChannels,
  seedRules,
  seedSilences,
  seedSmtp,
} from '../seed/alerting';
import { DEMO_SITE_ID } from '../seed/site';
import { collection, newId, value } from '../store';
import { incidentsBetween } from '../world';
import { requireProject } from './bootstrap';
import { SPAN_GROUPS, SPAN_METRICS, runPanel } from './dashboards';
import { aggregateLogPanel } from './logs';

const HOUR = 3_600_000;
const MAX_SERIES = 100;

export const rules = collection<AlertRule>('alertRules', seedRules);
export const silences = collection<Silence>('alertSilences', seedSilences);
export const channels = collection<StoredChannel>('notificationChannels', seedChannels);
export const smtp = value<SMTPSettings>('smtpSettings', seedSmtp);

const bad = (message: string): never => {
  throw new DemoError(400, message);
};

// --- rules ------------------------------------------------------------------------

const COMPARISONS = ['>', '>=', '<', '<=', '==', '!='];
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MANAGED_SYNTHETICS =
  "this rule is managed by Synthetics: change its monitor's alerts on the control plane";
const MANAGED_BUDGET =
  'this rule is kept by an AI budget: change the budget in AI Observability, Budgets';

const channelsFor = (projectId: string) =>
  channels.find((c) => c.allProjects || c.projectIds.includes(projectId));

/** The backend's applyRule: validates a request and fills defaults. */
function applyRule(projectId: string, request: RuleRequest): Omit<AlertRule, 'id' | 'projectId'> {
  const name = (request.name ?? '').trim();
  const window = request.windowSeconds ?? 0;
  const interval = request.intervalSeconds ?? 0;
  const forSeconds = request.forSeconds ?? 0;
  const repeat = request.repeatSeconds;
  const labels = request.labels ?? {};
  const channelIds = [...new Set(request.channelIds ?? [])];
  if (!name || name.length > 200) bad('a name of up to 200 characters is required');
  if (!COMPARISONS.includes(request.comparison)) {
    bad('comparison must be one of > >= < <= == !=');
  }
  if (interval !== 0 && (interval < 15 || interval > 86400)) {
    bad('interval must be between 15 seconds and a day');
  }
  if (window !== 0 && (window < 60 || window > 86400)) {
    bad('window must be between a minute and a day');
  }
  if (forSeconds < 0 || forSeconds > 86400) bad('for must be between 0 and a day');
  if (repeat !== undefined && repeat !== null && (repeat < 0 || repeat > 7 * 86400)) {
    bad('repeat must be between 0 and 7 days');
  }
  if (Object.keys(labels).length > 20 || channelIds.length > 20) {
    bad('at most 20 labels and 20 channels');
  }
  for (const label of Object.keys(labels)) {
    if (!LABEL_NAME.test(label) || label === 'alertname') bad(`invalid label name "${label}"`);
  }
  const q = request.query ?? {};
  let query: AlertRule['query'];
  switch (request.source) {
    case 'metrics':
      if (!q.promql?.trim()) bad('a PromQL query is required');
      query = { promql: q.promql };
      break;
    case 'logs':
      query = { logs: q.logs, groupBy: (q.groupBy ?? '').trim() };
      break;
    case 'log_patterns': {
      const baseline = q.baselineSeconds || 86400;
      if (baseline < 3600 || baseline > 7 * 86400) {
        bad('the baseline must be between an hour and 7 days');
      }
      if ((q.minCount ?? 0) < 0) bad("the minimum count can't be negative");
      query = { logs: q.logs, baselineSeconds: baseline, minCount: q.minCount ?? 0 };
      break;
    }
    case 'traces': {
      const metric = q.metric || 'count';
      if (!SPAN_METRICS.has(metric)) {
        bad(`metric must be one of ${[...SPAN_METRICS].join(', ')}`);
      }
      if (q.groupBy && !SPAN_GROUPS.has(q.groupBy)) {
        bad('traces can be grouped by service_name, name, status_code or kind');
      }
      query = {
        metric,
        groupBy: q.groupBy ?? '',
        serviceName: q.serviceName,
        operationName: q.operationName,
        rootSpansOnly: q.rootSpansOnly,
      };
      break;
    }
    default:
      return bad('source must be metrics, logs, log_patterns or traces');
  }
  const known = new Set(channelsFor(projectId).map((c) => c.id));
  if (channelIds.some((id) => !known.has(id))) bad('every channel must belong to this project');
  return {
    name,
    enabled: request.enabled === undefined || request.enabled,
    source: request.source,
    query,
    comparison: request.comparison,
    threshold: Number(request.threshold) || 0,
    windowSeconds: window || 300,
    intervalSeconds: interval || 60,
    forSeconds,
    repeatSeconds: repeat ?? 4 * 3600,
    labels,
    summary: (request.summary ?? '').slice(0, 2000),
    lastError: '',
    channelIds,
  };
}

function ownedRule(projectId: string, id: string): AlertRule {
  const rule = rules.get(id);
  if (!rule || rule.projectId !== projectId) throw new DemoError(404, 'alert rule not found');
  return rule;
}

function refuseManaged(rule: AlertRule) {
  if (!rule.managedBy) return;
  throw new DemoError(
    409,
    rule.managedBy.startsWith('ai-budget:') ? MANAGED_BUDGET : MANAGED_SYNTHETICS,
  );
}

/** Rules as listed: enabled ones were last evaluated on their interval's grid. */
function withEval(rule: AlertRule, now = Date.now()): AlertRule {
  if (!rule.enabled) return rule;
  const interval = (rule.intervalSeconds || 60) * 1000;
  return { ...rule, lastEvalAt: new Date(Math.floor(now / interval) * interval).toISOString() };
}

export function compare(op: string, v: number, threshold: number): boolean {
  switch (op) {
    case '>':
      return v > threshold;
    case '>=':
      return v >= threshold;
    case '<':
      return v < threshold;
    case '<=':
      return v <= threshold;
    case '==':
      return v === threshold;
    case '!=':
      return v !== threshold;
    default:
      return false;
  }
}

// --- previews (the evaluator's query step) ------------------------------------------

type Sample = { labels: Record<string, string>; value: number };

const groupLabels = (field: string | undefined, key: string | undefined) =>
  field ? { [field]: key ?? '' } : {};

const panelBase = (source: Panel['source'], type: Panel['type']): Panel => ({
  id: 'alert-preview',
  title: '',
  type,
  source,
  gridPos: { x: 0, y: 0, w: 1, h: 1 },
});

/** Collapses timed buckets to one value per group (sums for counts, else the mean). */
function perGroup(buckets: AggregationBucket[], sum: boolean): Map<string, number> {
  const totals = new Map<string, { total: number; n: number }>();
  for (const bucket of buckets) {
    const key = bucket.groupKey ?? '';
    const entry = totals.get(key) ?? { total: 0, n: 0 };
    entry.total += bucket.value;
    entry.n += 1;
    totals.set(key, entry);
  }
  return new Map([...totals].map(([key, e]) => [key, sum ? e.total : e.total / e.n]));
}

function metricSamples(projectId: string, promql: string, now: number): Sample[] {
  const at = new Date(now).toISOString();
  const response = evaluatePromQL(projectId, { query: promql, start: at, end: at, instant: true });
  const samples: Sample[] = [];
  for (const series of response.series ?? []) {
    const last = series.points?.[series.points.length - 1];
    if (!last || !Number.isFinite(last.value)) continue;
    const labels = { ...series.labels };
    delete labels.__name__;
    samples.push({ labels, value: last.value });
  }
  if (!samples.length && typeof response.scalar === 'number') {
    return [{ labels: {}, value: response.scalar }];
  }
  if (samples.length > MAX_SERIES) {
    bad(`query returns ${samples.length} series; a rule may watch at most ${MAX_SERIES}`);
  }
  return samples;
}

const patternText = new Map(ALL_TEMPLATES.map((t) => [patternHashOf(t.id), t.pattern]));

function patternSamples(
  projectId: string,
  rule: Omit<AlertRule, 'id' | 'projectId'>,
  now: number,
): Sample[] {
  const windowMs = rule.windowSeconds * 1000;
  const baselineMs = (rule.query.baselineSeconds || 86400) * 1000;
  const minCount = rule.query.minCount || 5;
  const panel: Panel = {
    ...panelBase('logs', 'line'),
    query: rule.query.logs,
    groupField: 'pattern.hash',
    limit: 200,
  };
  const iso = (t: number) => new Date(t).toISOString();
  const current = perGroup(
    aggregateLogPanel(projectId, panel, { from: iso(now - windowMs), to: iso(now) }),
    true,
  );
  const baseline = perGroup(
    aggregateLogPanel(projectId, panel, {
      from: iso(now - windowMs - baselineMs),
      to: iso(now - windowMs - 1),
    }),
    true,
  );
  const scale = windowMs / baselineMs;
  const samples: Sample[] = [];
  for (const [hash, count] of current) {
    if (count < minCount) continue;
    const before = (baseline.get(hash) ?? 0) * scale;
    const change = before < 0.5 ? 'new' : count >= 2 * before ? 'spike' : undefined;
    if (!change) continue;
    const pattern = (patternText.get(hash) ?? hash).slice(0, 200);
    samples.push({
      labels: { pattern_hash: hash, change, pattern },
      value: change === 'new' ? 1000 : Math.round((count / before) * 100) / 100,
    });
  }
  return samples.sort((a, b) => b.value - a.value).slice(0, 20);
}

/** One evaluation of a rule at `now`: a value per series, like the backend's query(). */
export function evaluateRule(
  projectId: string,
  rule: Omit<AlertRule, 'id' | 'projectId'>,
  now = Date.now(),
): Sample[] {
  const range = {
    from: new Date(now - rule.windowSeconds * 1000).toISOString(),
    to: new Date(now).toISOString(),
  };
  const q = rule.query;
  switch (rule.source) {
    case 'metrics':
      return metricSamples(projectId, q.promql ?? '', now);
    case 'logs': {
      const buckets = aggregateLogPanel(
        projectId,
        { ...panelBase('logs', 'table'), query: q.logs, groupField: q.groupBy, limit: MAX_SERIES },
        range,
      );
      const samples = [...perGroup(buckets, true)].map(([key, v]) => ({
        labels: groupLabels(q.groupBy, key),
        value: v,
      }));
      return !q.groupBy && !samples.length ? [{ labels: {}, value: 0 }] : samples;
    }
    case 'traces': {
      const metric = (q.metric || 'count') as Panel['metric'];
      const buckets = runPanel(
        projectId,
        {
          ...panelBase('spans', 'table'),
          serviceName: q.serviceName,
          operationName: q.operationName,
          rootSpansOnly: q.rootSpansOnly,
          groupField: q.groupBy || undefined,
          metric,
          limit: MAX_SERIES,
        },
        range,
      );
      const countLike = metric === 'count' || metric === 'error_count';
      const samples = [...perGroup(buckets, countLike)].map(([key, v]) => ({
        labels: groupLabels(q.groupBy, key),
        value: Math.round(v * 100) / 100,
      }));
      return !q.groupBy && !samples.length && countLike ? [{ labels: {}, value: 0 }] : samples;
    }
    case 'log_patterns':
      return patternSamples(projectId, rule, now);
    default:
      return bad(`unknown rule source "${rule.source}"`);
  }
}

// --- alerts the incident raises ------------------------------------------------------------

function fingerprint(labels: Record<string, string>): string {
  const text = Object.keys(labels)
    .sort()
    .map((key) => `${key}\u0000${labels[key]}\u0000`)
    .join('');
  return hex(hashString(text), 16);
}

/** Each incident rule's current state: pending/firing in an incident, else resolved after the last one. */
export function deriveAlerts(projectId: string, now = Date.now()): AlertView[] {
  const views: AlertView[] = [];
  const incidents = incidentsBetween(now - 13 * HOUR, now);
  for (const def of INCIDENT_ALERTS) {
    const rule = rules.get(def.ruleId);
    if (!rule || rule.projectId !== projectId || !rule.enabled) continue;
    const interval = (rule.intervalSeconds || 60) * 1000;
    const onGrid = (t: number) => Math.ceil(t / interval) * interval;
    const timeline = incidents
      .map((incident) => {
        const activeAt = onGrid(incident.start + def.onsetMs);
        return {
          activeAt,
          firedAt: onGrid(activeAt + rule.forSeconds * 1000),
          resolvedAt: onGrid(incident.end + def.clearMs),
        };
      })
      .filter((t) => t.activeAt <= now)
      .pop();
    if (!timeline) continue;
    const labels = { ...rule.labels, ...def.series, alertname: rule.name };
    const iso = (t: number) => new Date(t).toISOString();
    const base = {
      ruleId: rule.id,
      ruleName: rule.name,
      fingerprint: fingerprint(labels),
      labels,
      activeAt: iso(timeline.activeAt),
    };
    const above = Math.max(def.peak(now), rule.threshold * 1.05);
    if (now < timeline.firedAt) {
      views.push({ ...base, state: 'pending', value: Math.round(above * 1000) / 1000 });
    } else if (now < timeline.resolvedAt) {
      views.push({
        ...base,
        state: 'firing',
        value: Math.round(above * 1000) / 1000,
        firedAt: iso(timeline.firedAt),
        lastNotifiedAt: iso(timeline.firedAt),
      });
    } else {
      views.push({
        ...base,
        state: 'resolved',
        value: def.ok,
        firedAt: iso(timeline.firedAt),
        resolvedAt: iso(timeline.resolvedAt),
        lastNotifiedAt: iso(timeline.resolvedAt),
      });
    }
  }
  // The backend's order: state (firing, pending, resolved), then newest first.
  return views.sort(
    (a, b) => a.state.localeCompare(b.state) || b.activeAt.localeCompare(a.activeAt),
  );
}

// --- silences -----------------------------------------------------------------------------

function validMatchers(matchers: Matcher[] | undefined): Matcher[] {
  const list = matchers ?? [];
  if (list.length === 0 || list.length > 20) bad('between 1 and 20 matchers are required');
  for (const matcher of list) {
    if (!LABEL_NAME.test(matcher.name ?? '')) bad(`invalid label name "${matcher.name}"`);
    if (matcher.regex) {
      try {
        new RegExp(`^(?:${matcher.value})$`);
      } catch {
        bad(`invalid regex for "${matcher.name}"`);
      }
    }
  }
  return list.map((m) => ({
    name: m.name,
    value: m.value ?? '',
    ...(m.regex ? { regex: true } : {}),
  }));
}

// --- deployment channels --------------------------------------------------------------------

const KINDS: ChannelKind[] = ['webhook', 'slack', 'pagerduty', 'email'];
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function validateConfig(kind: ChannelKind, config: ChannelConfig) {
  switch (kind) {
    case 'webhook':
    case 'slack': {
      let ok: boolean;
      try {
        const url = new URL(config.url ?? '');
        ok = (url.protocol === 'https:' || url.protocol === 'http:') && !!url.host;
      } catch {
        ok = false;
      }
      if (!ok) bad('a valid http(s) URL is required');
      if (kind === 'slack' && Object.keys(config.headers ?? {}).length) {
        bad('slack channels take no headers');
      }
      for (const name of Object.keys(config.headers ?? {})) {
        if (!name || /[ :\r\n]/.test(name)) bad(`invalid header name "${name}"`);
      }
      break;
    }
    case 'pagerduty':
      if (!config.routingKey?.trim()) bad('a PagerDuty routing key is required');
      break;
    case 'email': {
      const to = config.to ?? [];
      if (to.length === 0 || to.length > 20) bad('between 1 and 20 recipients are required');
      for (const address of to) if (!EMAIL.test(address)) bad(`invalid recipient "${address}"`);
      break;
    }
    default:
      bad(`unknown channel kind "${kind}"`);
  }
}

function settingsView(channel: StoredChannel): SettingsChannel {
  const { config, ...view } = channel;
  void config;
  const usedBy = rules.find((r) => r.channelIds.includes(channel.id)).length;
  return { ...view, usedBy };
}

const projectView = (channel: StoredChannel): NotificationChannel => ({
  id: channel.id,
  name: channel.name,
  kind: channel.kind,
  target: channel.target,
  source: channel.source,
});

function ownedChannel(id: string): StoredChannel {
  const channel = channels.get(id);
  if (!channel) throw new DemoError(404, 'channel not found');
  return channel;
}

const SENT = (what: string) => `${what} (demo: nothing was sent)`;

// --- routes -----------------------------------------------------------------------------------

export function register(r: Router) {
  const project = '/projects/:pid';

  r.get(`${project}/alerts`, (req) => {
    requireProject(req.params.pid);
    return deriveAlerts(req.params.pid);
  });

  r.get(`${project}/alert-rules`, (req) => {
    requireProject(req.params.pid);
    const now = Date.now();
    return rules
      .find((rule) => rule.projectId === req.params.pid)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((rule) => withEval(rule, now));
  });

  r.post(`${project}/alert-rules`, (req) => {
    requireProject(req.params.pid);
    const fields = applyRule(req.params.pid, (req.body ?? {}) as RuleRequest);
    return withEval(rules.insert({ id: newId(), projectId: req.params.pid, ...fields }));
  });

  r.post(`${project}/alert-rules/preview`, (req): PreviewSeries[] => {
    requireProject(req.params.pid);
    const rule = applyRule(req.params.pid, (req.body ?? {}) as RuleRequest);
    return evaluateRule(req.params.pid, rule).map((sample) => ({
      labels: sample.labels,
      value: sample.value,
      firing: compare(rule.comparison, sample.value, rule.threshold),
    }));
  });

  r.put(`${project}/alert-rules/:ruleId`, (req) => {
    requireProject(req.params.pid);
    const existing = ownedRule(req.params.pid, req.params.ruleId);
    refuseManaged(existing);
    const fields = applyRule(req.params.pid, (req.body ?? {}) as RuleRequest);
    return withEval(rules.update(existing.id, fields)!);
  });

  r.delete(`${project}/alert-rules/:ruleId`, (req) => {
    requireProject(req.params.pid);
    const rule = ownedRule(req.params.pid, req.params.ruleId);
    refuseManaged(rule);
    rules.remove(rule.id);
    return { message: 'Alert rule deleted' };
  });

  r.get(`${project}/notification-channels`, (req) => {
    requireProject(req.params.pid);
    return channelsFor(req.params.pid)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(projectView);
  });

  r.post(`${project}/notification-channels/:channelId/test`, (req) => {
    requireProject(req.params.pid);
    const channel = channelsFor(req.params.pid).find((c) => c.id === req.params.channelId);
    if (!channel) throw new DemoError(404, 'channel not found');
    return { message: SENT('Test notification sent') };
  });

  r.get(`${project}/silences`, (req) => {
    requireProject(req.params.pid);
    const now = new Date().toISOString();
    return silences
      .find((s) => s.projectId === req.params.pid && s.endsAt > now)
      .sort((a, b) => a.endsAt.localeCompare(b.endsAt));
  });

  r.post(`${project}/silences`, (req) => {
    requireProject(req.params.pid);
    const body = (req.body ?? {}) as SilenceRequest;
    const now = Date.now();
    const startsAt = body.startsAt ? Date.parse(body.startsAt) : now;
    const endsAt = Date.parse(body.endsAt);
    const matchers = validMatchers(body.matchers);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) bad('Invalid request format');
    if (!(endsAt > startsAt) || !(endsAt > now)) {
      bad('a silence must end after it starts, and in the future');
    }
    return silences.insert({
      id: newId(),
      projectId: req.params.pid,
      matchers,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      comment: (body.comment ?? '').slice(0, 1000),
    });
  });

  r.delete(`${project}/silences/:silenceId`, (req) => {
    requireProject(req.params.pid);
    const silence = silences.get(req.params.silenceId);
    if (!silence || silence.projectId !== req.params.pid) {
      throw new DemoError(404, 'silence not found');
    }
    if (silence.managedBy) {
      throw new DemoError(
        409,
        'this silence comes from a Synthetics maintenance window: change the window on the control plane',
      );
    }
    silences.remove(silence.id);
    return { message: 'Silence deleted' };
  });

  // --- deployment settings: channels, email, sync ---------------------------------------

  // The demo runs as a control plane: these are its central settings, which
  // the Site (DEMO_SITE_ID) fetches. A channel without a scope is every Site's.
  const centralView = (channel: StoredChannel): SettingsChannel => {
    const view = settingsView(channel);
    return {
      ...view,
      source: 'central',
      scope: view.scope ?? {
        allSites: view.allProjects,
        sites: [],
        projects: view.allProjects
          ? []
          : view.projectIds.map((projectId) => ({ siteId: DEMO_SITE_ID, projectId })),
      },
    };
  };

  r.get('/settings/channels', () =>
    channels
      .all()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(centralView),
  );

  const channelFields = (request: SettingsChannelRequest, existing?: StoredChannel) => {
    const name = (request.name ?? '').trim();
    if (!name || name.length > 200) bad('a name of up to 200 characters is required');
    if (!KINDS.includes(request.kind)) bad(`unknown channel kind "${request.kind}"`);
    let config = request.config;
    if (!config) {
      if (!existing || existing.kind !== request.kind) bad('the channel needs its settings');
      config = existing!.config;
    }
    validateConfig(request.kind, config!);
    const allProjects =
      request.allProjects ?? (request.scope ? true : (existing?.allProjects ?? true));
    return {
      name,
      kind: request.kind,
      config: config!,
      target: describeChannel(request.kind, config!),
      allProjects,
      projectIds: allProjects ? [] : (request.projectIds ?? []),
      ...(request.scope ? { scope: request.scope } : {}),
      updatedAt: new Date().toISOString(),
    };
  };

  r.post('/settings/channels', (req) => {
    const fields = channelFields((req.body ?? {}) as SettingsChannelRequest);
    return centralView(channels.insert({ id: newId(), source: 'central', ...fields }));
  });

  r.put('/settings/channels/:channelId', (req) => {
    const existing = ownedChannel(req.params.channelId);
    const fields = channelFields((req.body ?? {}) as SettingsChannelRequest, existing);
    return centralView(channels.update(existing.id, fields)!);
  });

  r.delete('/settings/channels/:channelId', (req) => {
    const existing = ownedChannel(req.params.channelId);
    channels.remove(existing.id);
    // Rules stop sending to it, as the backend's foreign keys do.
    for (const rule of rules.find((rr) => rr.channelIds.includes(existing.id))) {
      rules.update(rule.id, { channelIds: rule.channelIds.filter((id) => id !== existing.id) });
    }
    return { message: 'Channel deleted' };
  });

  r.post('/settings/channels/:channelId/test', (req) => {
    ownedChannel(req.params.channelId);
    return { message: SENT('Test notification sent') };
  });

  r.get('/settings/smtp', () => {
    const current = smtp.get();
    return current.configured ? { ...current, source: 'central', managed: false } : current;
  });

  r.put('/settings/smtp', (req) => {
    const body = (req.body ?? {}) as SMTPRequest;
    const current = smtp.get();
    if (!body.host?.trim()) bad('a host is required');
    if (!(body.port > 0 && body.port < 65536)) bad('a port between 1 and 65535 is required');
    if (!body.from?.trim()) bad('a from address is required');
    if (body.tls !== 'starttls' && body.tls !== 'tls') bad('tls must be starttls or tls');
    smtp.set({
      configured: true,
      source: 'local',
      host: body.host.trim(),
      port: body.port,
      username: body.username ?? '',
      // The password itself is never kept, not even in this browser.
      passwordSet: !!body.password || (current.configured && current.passwordSet),
      from: body.from.trim(),
      tls: body.tls,
      updatedAt: new Date().toISOString(),
      managed: false,
    });
    return { message: 'Email settings saved' };
  });

  r.delete('/settings/smtp', () => {
    smtp.set({
      configured: false,
      host: '',
      port: 0,
      username: '',
      passwordSet: false,
      from: '',
      tls: 'starttls',
      managed: false,
    });
    return { message: 'Email settings removed' };
  });

  r.post('/settings/smtp/test', () => notInDemo('Sending a test email'));

  // The control plane's view: one Site, which fetches every 5 minutes and has
  // applied the current settings (their version is a hash of channels + SMTP).
  r.get('/settings/sync', () => {
    const version = hex(
      hashString(JSON.stringify([channels.all().map((c) => [c.id, c.updatedAt]), smtp.get()])),
      12,
    );
    const now = Date.now();
    const fetchedAt = new Date(Math.floor(now / 300_000) * 300_000 + 41_000);
    if (fetchedAt.getTime() > now) fetchedAt.setTime(fetchedAt.getTime() - 300_000);
    const sync: SettingsSync = {
      mode: 'control-plane',
      sites: [
        {
          siteId: DEMO_SITE_ID,
          version,
          fetchedAt: fetchedAt.toISOString(),
          appliedVersion: version,
          appliedAt: new Date(fetchedAt.getTime() + 1_200).toISOString(),
          current: true,
          keyFingerprint: 'SHA256:ZGVtby1oYXJib3JsaW5lLWV1LWtleS1ub3QtcmVhbA',
          keyCheckedAt: fetchedAt.toISOString(),
        },
      ],
    };
    return sync;
  });
  r.post('/settings/sync/:siteId/accept-key', () => {
    throw new DemoError(409, 'This Site has no new key to accept');
  });
  r.get('/settings/local-config/export', () => notInDemo('Moving settings to the control plane'));
  r.post('/settings/adopt', () => notInDemo('Moving settings to the control plane'));
}
