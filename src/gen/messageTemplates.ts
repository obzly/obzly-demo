// Notification message templates: the built-in ones, the sample
// notifications the editor previews (the server's sampleNotifications) and
// rendering per channel kind, through lib/goTemplate. Nothing is ever sent.
import type {
  ChannelKind,
  MessageTemplate,
  Severity,
  TemplatePreviewResponse,
  TemplatePreviewSample,
  TemplateError as TemplateProblem,
} from '../../entity/alerting';
import { TemplateError, executeTemplate, parseTemplate, truthy } from '../lib/goTemplate';

const MINUTE = 60_000;
export const CHANNEL_KINDS: ChannelKind[] = ['email', 'slack', 'pagerduty', 'webhook'];
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const MAX_TEMPLATE_BYTES = 16 << 10;

/** A severity from a rule's request or its severity label; anything else is medium. */
export function normalizeSeverity(value: unknown): Severity {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return (SEVERITIES as string[]).includes(s) ? (s as Severity) : 'medium';
}

// --- the built-in templates (the server's templates_defaults.go) --------------------

const TITLE =
  '{{if .Emoji}}{{.Emoji}} {{end}}[{{upper .Status}}] {{if not .Test}}{{.Severity}}: {{end}}{{.Rule.Name}}';

const EMAIL_BODY = `${TITLE}
{{- if .Summary}}

{{.Summary}}
{{- end}}
{{if .Incident}}
Services: {{join ", " .Incident.Services}}
Signals: {{.Incident.SignalCount}} ({{.Incident.ErrorLogs}} error logs, {{.Incident.ErrorSpans}} error spans)
{{- range .Incident.TopServices}}
- {{.Name}}: {{.Total}} errors
{{- end}}
{{else if not .Test}}
Value {{.Value}} ({{.Comparison}} {{.Threshold}})
{{end -}}
{{if .StartsAt}}Started {{.StartsAt}}{{if .Duration}} ({{.Duration}}){{end}}
{{end -}}
{{if .Project.Name}}Project {{.Project.Name}}{{if .Site.Name}} on {{.Site.Name}}{{end}}
{{end -}}
{{range .SortedLabels}}{{.Name}}={{.Value}}
{{end -}}
{{if .Rule.Description}}
Runbook:
{{.Rule.Description}}
{{end -}}
{{if .Link}}
Open in Obzly: {{.Link}}
{{end}}`;

const SLACK_BODY = `*${TITLE}*
{{- if .Summary}}
{{.Summary}}
{{- end}}
{{- if .Incident}}
Services: {{join ", " .Incident.Services}} · {{.Incident.SignalCount}} signals
{{- range .Incident.TopServices}}
• {{.Name}}: {{.Total}} errors
{{- end}}
{{- else if not .Test}}
Value \`{{.Value}}\` ({{.Comparison}} {{.Threshold}})
{{- end}}
{{- if .Duration}}
For {{.Duration}}{{if .Project.Name}} · {{.Project.Name}}{{end}}
{{- end}}
{{- if .SortedLabels}}
{{range $i, $l := .SortedLabels}}{{if $i}}, {{end}}\`{{$l.Name}}={{$l.Value}}\`{{end}}
{{- end}}
{{- if .Rule.Description}}
_Runbook:_ {{.Rule.Description}}
{{- end}}
{{- if .Link}}
<{{.Link}}|Open in Obzly>
{{- end}}`;

const PAGERDUTY_SUMMARY =
  '{{if .Emoji}}{{.Emoji}} {{end}}[{{upper .Status}}] {{.Rule.Name}}{{if .Summary}}: {{.Summary}}{{end}}';

export function defaultTemplate(kind: ChannelKind): MessageTemplate {
  switch (kind) {
    case 'email':
      return { subject: TITLE, body: EMAIL_BODY };
    case 'slack':
      return { subject: '', body: SLACK_BODY };
    case 'pagerduty':
      return { subject: '', body: PAGERDUTY_SUMMARY };
    default:
      return { subject: '', body: '' };
  }
}

// --- sample notifications -----------------------------------------------------------

type Status = 'firing' | 'resolved' | 'test';

export interface SampleNotification {
  kind: 'alert' | 'incident';
  status: Status;
  severity: Severity;
  projectId: string;
  ruleId?: string;
  ruleName: string;
  source: string;
  summary: string;
  description: string;
  comparison: string;
  threshold: number;
  measured: number;
  startsAt: number;
  endsAt?: number;
  labels: Record<string, string>;
  fingerprint: string;
  incident?: {
    id: string;
    services: string[];
    signalCount: number;
    errorLogs: number;
    errorSpans: number;
    topServices: { name: string; errorLogs: number; errorSpans: number; total: number }[];
  };
}

const SAMPLE_PROJECT = '6f1c2a52-8c3e-4f8e-9a51-0d7c1e5b2a10';
const SAMPLE_RULE = '3b9d7f0e-2a4c-4b6e-8f1a-5c2d9e7b4a31';
const SAMPLE_SESSION = '9e4a1c7b-5d2f-4a8e-b6c3-1f0d2e3a4b5c';

export function sampleNotifications(now = Date.now()) {
  const startsAt = Math.floor((now - 12 * MINUTE) / 1000) * 1000;
  const alert = (status: Status, severity: Severity): SampleNotification => ({
    kind: 'alert',
    status,
    severity,
    projectId: SAMPLE_PROJECT,
    ruleId: SAMPLE_RULE,
    ruleName: 'High error rate on checkout',
    source: 'metrics',
    summary: '5xx responses above 5% for 5 minutes',
    description: 'Check the checkout dashboard; roll back the last deploy if it started then.',
    comparison: '>',
    threshold: 0.05,
    measured: 0.0734,
    startsAt,
    endsAt: status === 'resolved' ? startsAt + 9 * MINUTE : undefined,
    labels: {
      alertname: 'High error rate on checkout',
      service_name: 'checkout',
      env: 'production',
      team: 'payments <oncall> & "night"',
    },
    fingerprint: 'a1b2c3d4e5f60718',
  });
  const test: SampleNotification = {
    kind: 'alert',
    status: 'test',
    severity: 'medium',
    projectId: '',
    ruleName: 'Test notification from Obzly',
    source: '',
    summary: 'If you can read this, the channel ops-alerts works.',
    description: '',
    comparison: '',
    threshold: 0,
    measured: 0,
    startsAt,
    labels: { channel: 'ops-alerts' },
    fingerprint: '',
  };
  const incident = (status: Status): SampleNotification => ({
    kind: 'incident',
    status,
    severity: 'high',
    projectId: SAMPLE_PROJECT,
    ruleName: 'Incident: checkout, payments',
    source: 'incident',
    summary: '14 error signals across 2 services',
    description: '',
    comparison: '',
    threshold: 0,
    measured: 0,
    startsAt,
    endsAt: status === 'resolved' ? startsAt + 25 * MINUTE : undefined,
    labels: { alertname: 'Incident', obzly_kind: 'incident', severity: 'high' },
    fingerprint: `incident:${SAMPLE_SESSION}`,
    incident: {
      id: SAMPLE_SESSION,
      services: ['checkout', 'payments'],
      signalCount: 14,
      errorLogs: 9,
      errorSpans: 5,
      topServices: [
        { name: 'checkout', errorLogs: 7, errorSpans: 4, total: 11 },
        { name: 'payments', errorLogs: 2, errorSpans: 1, total: 3 },
      ],
    },
  });
  return [
    { key: 'firing-critical', label: 'Critical firing', n: alert('firing', 'critical') },
    { key: 'firing-high', label: 'High firing', n: alert('firing', 'high') },
    { key: 'firing-medium', label: 'Medium firing', n: alert('firing', 'medium') },
    { key: 'firing-low', label: 'Low firing', n: alert('firing', 'low') },
    { key: 'resolved', label: 'Resolved', n: alert('resolved', 'high') },
    { key: 'test', label: 'Test', n: test },
    { key: 'incident-open', label: 'Incident opened', n: incident('firing') },
    { key: 'incident-end', label: 'Incident ended', n: incident('resolved') },
  ];
}

// --- rendering ------------------------------------------------------------------------

const EMOJI: Record<Severity, string> = {
  critical: '\u{1F4E3}❗\u{1F525}',
  high: '\u{1F4E3}❗\u{1F6A8}',
  medium: '\u{1F4E3} \u{1F514}⚠️',
  low: '\u{1F514}\u{1F514}\u{1F440}',
};
const COLOR: Record<Severity, string> = {
  critical: '#DC2626',
  high: '#EA580C',
  medium: '#F59E0B',
  low: '#2563EB',
};

export const emojiFor = (status: Status, severity: Severity) =>
  status === 'resolved' ? '✅️' : status === 'test' ? '\u{1F9EA}' : EMOJI[severity];
const colorFor = (status: Status, severity: Severity) =>
  status === 'resolved' ? '#16A34A' : status === 'test' ? '#6B7280' : COLOR[severity];

const truncate = (limit: number, s: string) => {
  const chars = [...s];
  if (chars.length <= limit) return s;
  return limit <= 1 ? chars.slice(0, limit).join('') : `${chars.slice(0, limit - 1).join('')}…`;
};

const FUNCS = {
  upper: (s: unknown) => String(s).toUpperCase(),
  lower: (s: unknown) => String(s).toLowerCase(),
  title: (s: unknown) => String(s).charAt(0).toUpperCase() + String(s).slice(1),
  trim: (s: unknown) => String(s).trim(),
  truncate: (n: unknown, s: unknown) => truncate(Number(n), String(s)),
  join: (sep: unknown, items: unknown) =>
    truncate(64 << 10, (Array.isArray(items) ? items : []).map(String).join(String(sep))),
  default: (fallback: unknown, value: unknown) =>
    String(value ?? '').trim() === '' ? fallback : value,
  contains: (sub: unknown, s: unknown) => String(s).includes(String(sub)),
  hasPrefix: (prefix: unknown, s: unknown) => String(s).startsWith(String(prefix)),
  hasSuffix: (suffix: unknown, s: unknown) => String(s).endsWith(String(suffix)),
  label: (labels: unknown, name: unknown) =>
    labels instanceof Map ? (labels.get(String(name)) ?? '') : '',
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const escapePlain = (s: string) => s.replace(CONTROL, ' ');
const escapeSlack = (s: string) =>
  escapePlain(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeJSON = (s: string) => JSON.stringify(s).slice(1, -1);

const goTime = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const utcText = (t: number) => `${goTime(t).replace('T', ' ').replace('Z', '')} UTC`;
const formatValue = (v: number) => String(Number(v.toPrecision(6)));

function humanDuration(ms: number): string {
  if (ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400)
    return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) - Math.floor(s / 3600) * 60}m`;
  const days = Math.floor(s / 86_400);
  return `${days}d ${Math.floor(s / 3600) - days * 24}h`;
}

export interface RenderContext {
  projectName: string;
  siteId: string;
  siteName: string;
  link: string;
  useEmoji: boolean;
  now: number;
}

/** An "Open in Obzly" deep link: ?site&project&tab=alerts&rule or tab=incidents&session. */
export function notificationLink(base: string, siteId: string, n: SampleNotification): string {
  if (!n.projectId) return `${base}/`;
  const query = new URLSearchParams();
  if (siteId) query.set('site', siteId);
  query.set('project', n.projectId);
  if (n.incident) {
    query.set('tab', 'incidents');
    query.set('session', n.incident.id);
  } else {
    query.set('tab', 'alerts');
    if (n.ruleId) query.set('rule', n.ruleId);
  }
  return `${base}/?${query.toString()}`;
}

const sampleContext = (n: SampleNotification, useEmoji: boolean): RenderContext => ({
  projectName: 'Contoso Shop',
  siteId: 'eu-1',
  siteName: 'eu-1',
  useEmoji,
  link: notificationLink('https://obzly.example.com', 'eu-1', n),
  now: n.startsAt + 12 * MINUTE,
});

function templateData(n: SampleNotification, rc: RenderContext, esc: (s: string) => string) {
  const keys = Object.keys(n.labels).sort();
  const labels = new Map(keys.map((k) => [esc(k), esc(n.labels[k])]));
  const end = n.status === 'test' ? 0 : (n.endsAt ?? rc.now);
  return {
    Kind: n.kind,
    Status: esc(n.status),
    Test: n.status === 'test',
    Severity: n.severity.charAt(0).toUpperCase() + n.severity.slice(1),
    SeverityKey: n.severity,
    Emoji: rc.useEmoji ? emojiFor(n.status, n.severity) : '',
    Rule: { ID: n.ruleId ?? '', Name: esc(n.ruleName), Description: esc(n.description) },
    Summary: esc(n.summary),
    Value: formatValue(n.measured),
    Threshold: formatValue(n.threshold),
    Comparison: esc(n.comparison),
    Labels: labels,
    SortedLabels: [...labels.entries()].map(([Name, Value]) => ({ Name, Value })),
    StartsAt: utcText(n.startsAt),
    StartsAtISO: goTime(n.startsAt),
    EndsAt: n.endsAt ? utcText(n.endsAt) : '',
    EndsAtISO: n.endsAt ? goTime(n.endsAt) : '',
    Duration: n.status === 'test' ? '' : humanDuration(end - n.startsAt),
    Project: { ID: n.projectId, Name: esc(rc.projectName) },
    Site: { ID: esc(rc.siteId), Name: esc(rc.siteName) },
    Source: esc(n.source),
    Link: esc(rc.link),
    Incident: n.incident
      ? {
          ID: n.incident.id,
          Services: n.incident.services.map(esc),
          ServiceCount: n.incident.services.length,
          SignalCount: n.incident.signalCount,
          ErrorLogs: n.incident.errorLogs,
          ErrorSpans: n.incident.errorSpans,
          TopServices: n.incident.topServices.map((s) => ({
            Name: esc(s.name),
            ErrorLogs: s.errorLogs,
            ErrorSpans: s.errorSpans,
            Total: s.total,
          })),
        }
      : null,
  };
}

/** The built-in webhook JSON (keys sorted, as Go marshals a map). */
function webhookBody(n: SampleNotification, rc: RenderContext) {
  const body: Record<string, unknown> = {
    version: 'obzly.alert/1',
    status: n.status,
    projectId: n.projectId || '00000000-0000-0000-0000-000000000000',
    ruleId: n.ruleId ?? null,
    ruleName: n.ruleName,
    source: n.source,
    summary: n.summary,
    labels: Object.fromEntries(
      Object.keys(n.labels)
        .sort()
        .map((k) => [k, n.labels[k]]),
    ),
    value: n.measured,
    comparison: n.comparison,
    threshold: n.threshold,
    fingerprint: n.fingerprint,
    startsAt: goTime(n.startsAt),
    endsAt: n.endsAt ? goTime(n.endsAt) : null,
    kind: n.kind,
    severity: n.severity,
    description: n.description,
    link: rc.link,
  };
  if (n.incident) body.incident = n.incident;
  return Object.fromEntries(
    Object.keys(body)
      .sort()
      .map((k) => [k, body[k]]),
  );
}

interface Rendered {
  subject?: string;
  text?: string;
  json?: string;
  color: string;
}

type Field = 'subject' | 'body';

const problem = (field: Field, error: unknown): TemplateProblem =>
  error instanceof TemplateError
    ? { field, line: error.line, message: error.message }
    : // Only the template engine's own messages go back; anything else stays generic.
      { field, line: 0, message: 'the template could not be rendered' };

/**
 * A caught render failure as a plain problem: only our own problem objects pass their field, line
 * and message; anything else (an unexpected exception) becomes a generic message, so no exception
 * object or stack reaches a response.
 */
const caughtProblem = (caught: unknown, fallbackField: Field = 'body'): TemplateProblem => {
  if (typeof caught === 'object' && caught !== null && !(caught instanceof Error)) {
    const candidate = caught as Partial<TemplateProblem>;
    if (
      (candidate.field === 'subject' || candidate.field === 'body') &&
      typeof candidate.line === 'number' &&
      typeof candidate.message === 'string'
    ) {
      return { field: candidate.field, line: candidate.line, message: candidate.message };
    }
  }
  return { field: fallbackField, line: 0, message: 'the template could not be rendered' };
};

function execute(field: Field, source: string, data: unknown): string {
  try {
    return executeTemplate(parseTemplate(source, FUNCS), data, FUNCS);
  } catch (error) {
    throw problem(field, error);
  }
}

function render(
  kind: ChannelKind,
  tpl: MessageTemplate,
  n: SampleNotification,
  rc: RenderContext,
): Rendered {
  const out: Rendered = { color: colorFor(n.status, n.severity) };
  // eslint-disable-next-line no-control-regex
  const collapse = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  switch (kind) {
    case 'email':
      out.subject = truncate(
        300,
        collapse(execute('subject', tpl.subject, templateData(n, rc, escapePlain))).trim(),
      );
      if (!out.subject)
        throw {
          field: 'subject',
          line: 0,
          message: 'the subject renders empty',
        } as TemplateProblem;
      out.text = execute('body', tpl.body, templateData(n, rc, escapePlain));
      break;
    case 'slack':
      out.text = execute('body', tpl.body, templateData(n, rc, escapeSlack));
      break;
    case 'pagerduty':
      out.text = truncate(
        1024,
        collapse(execute('body', tpl.body, templateData(n, rc, escapePlain))).trim(),
      );
      break;
    case 'webhook': {
      if (!tpl.body.trim()) {
        out.json = JSON.stringify(webhookBody(n, rc));
        return out;
      }
      const text = execute('body', tpl.body, templateData(n, rc, escapeJSON));
      try {
        JSON.parse(text);
      } catch {
        throw {
          field: 'body',
          line: 0,
          message: 'renders invalid JSON',
        } as TemplateProblem;
      }
      out.json = text;
      return out;
    }
  }
  if (!truthy(out.text?.trim()))
    throw { field: 'body', line: 0, message: 'the message renders empty' } as TemplateProblem;
  return out;
}

/** Problems that stop a template parsing at all (or an empty field). */
export function parseProblems(kind: ChannelKind, tpl: MessageTemplate): TemplateProblem[] {
  const fields: [Field, string][] = [['body', tpl.body ?? '']];
  if (kind === 'email') fields.unshift(['subject', tpl.subject ?? '']);
  const problems: TemplateProblem[] = [];
  for (const [field, source] of fields) {
    if (!source.trim()) {
      if (kind !== 'webhook') problems.push({ field, line: 0, message: "can't be empty" });
      continue;
    }
    if (source.length > MAX_TEMPLATE_BYTES) {
      problems.push({ field, line: 0, message: `is longer than ${MAX_TEMPLATE_BYTES >> 10} KB` });
      continue;
    }
    try {
      parseTemplate(source, FUNCS);
    } catch (error) {
      problems.push(problem(field, error));
    }
  }
  return problems;
}

/** Every problem saving the template would hit: parsing, then rendering each sample. */
export function validateTemplate(kind: ChannelKind, tpl: MessageTemplate): TemplateProblem[] {
  const parsed = parseProblems(kind, tpl);
  if (parsed.length) return parsed;
  const seen = new Set<string>();
  const problems: TemplateProblem[] = [];
  for (const sample of sampleNotifications()) {
    try {
      render(kind, tpl, sample.n, sampleContext(sample.n, true));
    } catch (error) {
      const p = caughtProblem(error);
      const key = `${p.field}:${p.line}:${p.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        problems.push({ field: p.field, line: p.line, message: `${p.message} (${sample.label})` });
      }
    }
  }
  return problems;
}

/** The editor's preview: every sample rendered, or the parse errors. */
export function previewTemplate(
  kind: ChannelKind,
  tpl: MessageTemplate,
  useEmoji = true,
): TemplatePreviewResponse {
  const response: TemplatePreviewResponse = { errors: parseProblems(kind, tpl), samples: [] };
  if (response.errors.length) return response;
  for (const sample of sampleNotifications()) {
    const n = sample.n;
    const item: TemplatePreviewSample = {
      key: sample.key,
      label: sample.label,
      status: n.status,
      severity: n.severity,
      emoji: useEmoji ? emojiFor(n.status, n.severity) : '',
    };
    try {
      const out = render(kind, tpl, n, sampleContext(n, useEmoji));
      if (out.subject !== undefined) item.subject = out.subject;
      if (out.text !== undefined) item.text = out.text;
      if (kind === 'slack') item.color = out.color;
      if (out.json) item.body = JSON.stringify(JSON.parse(out.json), null, 2);
    } catch (error) {
      const p = caughtProblem(error);
      const labelled = { field: p.field, line: p.line, message: `${p.message} (${sample.label})` };
      response.errors.push(labelled);
      item.error =
        p.line > 0
          ? `${p.field}, line ${p.line}: ${labelled.message}`
          : `${p.field}: ${labelled.message}`;
    }
    response.samples.push(item);
  }
  return response;
}
