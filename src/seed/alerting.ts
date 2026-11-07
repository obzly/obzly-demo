// Harborline's alerting setup: notification channels (all to example.com
// addresses), rules on logs, traces and metrics, silences and email settings.
// Three rules follow the recurring payments incident (see world.ts); the
// others watch things that stay healthy.
import type {
  AlertRule,
  ChannelConfig,
  SMTPSettings,
  SettingsChannel,
  Silence,
} from '../../entity/alerting';
import { uuidFrom } from '../lib/rng';
import { MINUTE, PROJECT_ID, incidentLevel, traffic } from '../world';
import { and, checkout5xx, cond, errorLevels } from './dashboards';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const daysAgo = (days: number) =>
  new Date(Math.floor((Date.now() - days * DAY) / MINUTE) * MINUTE).toISOString();

// --- channels -------------------------------------------------------------------

/** A deployment-level channel as stored: the settings view plus its (secret) config. */
export type StoredChannel = Omit<SettingsChannel, 'usedBy'> & { config: ChannelConfig };

export const CHANNEL_CHECKOUT_SLACK = uuidFrom('demo-channel:slack-checkout');
export const CHANNEL_PLATFORM_SLACK = uuidFrom('demo-channel:slack-platform');
export const CHANNEL_PAGERDUTY = uuidFrom('demo-channel:pagerduty-payments');
export const CHANNEL_SRE_EMAIL = uuidFrom('demo-channel:email-sre');
export const CHANNEL_WEBHOOK = uuidFrom('demo-channel:webhook-incidents');

export function seedChannels(): StoredChannel[] {
  const base = { source: 'local' as const, allProjects: true, projectIds: [] as string[] };
  return [
    {
      ...base,
      id: CHANNEL_CHECKOUT_SLACK,
      name: '#checkout-oncall',
      kind: 'slack',
      target: 'https://hooks.example.com',
      config: { url: 'https://hooks.example.com/services/T0HARBOR/B0CHECKOUT/demo' },
      updatedAt: daysAgo(70),
    },
    {
      ...base,
      id: CHANNEL_PLATFORM_SLACK,
      name: '#platform-alerts',
      kind: 'slack',
      target: 'https://hooks.example.com',
      config: { url: 'https://hooks.example.com/services/T0HARBOR/B0PLATFORM/demo' },
      updatedAt: daysAgo(70),
    },
    {
      ...base,
      id: CHANNEL_PAGERDUTY,
      name: 'Payments on-call (PagerDuty)',
      kind: 'pagerduty',
      target: 'routing key …c9e2',
      config: { routingKey: 'demo00000000000000000000c9e2' },
      updatedAt: daysAgo(52),
    },
    {
      ...base,
      id: CHANNEL_SRE_EMAIL,
      name: 'SRE email',
      kind: 'email',
      target: 'sre@harborline.example.com, oncall@harborline.example.com',
      config: { to: ['sre@harborline.example.com', 'oncall@harborline.example.com'] },
      updatedAt: daysAgo(66),
    },
    {
      ...base,
      allProjects: false,
      projectIds: [PROJECT_ID],
      id: CHANNEL_WEBHOOK,
      name: 'Incident bot webhook',
      kind: 'webhook',
      target: 'https://incidents.harborline.example.com',
      config: {
        url: 'https://incidents.harborline.example.com/hooks/obzly',
        headers: { 'X-Source': 'obzly' },
      },
      updatedAt: daysAgo(21),
    },
  ];
}

/** Where a channel sends, without secrets (the backend's describe()). */
export function describeChannel(kind: string, config: ChannelConfig): string {
  switch (kind) {
    case 'webhook':
    case 'slack':
      try {
        const url = new URL(config.url ?? '');
        return `${url.protocol}//${url.host}`;
      } catch {
        return '';
      }
    case 'pagerduty': {
      const key = config.routingKey ?? '';
      return `routing key …${key.length > 4 ? key.slice(-4) : key}`;
    }
    case 'email':
      return (config.to ?? []).join(', ');
    default:
      return '';
  }
}

export const seedSmtp = (): SMTPSettings => ({
  configured: true,
  source: 'local',
  host: 'smtp.example.com',
  port: 587,
  username: 'obzly@harborline.example.com',
  passwordSet: true,
  from: 'Obzly alerts <alerts@harborline.example.com>',
  tls: 'starttls',
  updatedAt: daysAgo(66),
  managed: false,
});

// --- rules ------------------------------------------------------------------------

export const RULE_CHECKOUT_5XX = uuidFrom('demo-rule:checkout-5xx');
export const RULE_PAYMENTS_P95 = uuidFrom('demo-rule:payments-p95');
export const RULE_POSTGRES_CONNECTIONS = uuidFrom('demo-rule:postgres-connections');

type SeedRule = Omit<AlertRule, 'lastEvalAt'>;

const rule = (key: string, fields: Omit<SeedRule, 'id' | 'projectId' | 'lastError'>): SeedRule => ({
  id: uuidFrom(`demo-rule:${key}`),
  projectId: PROJECT_ID,
  lastError: '',
  ...fields,
});

export function seedRules(): SeedRule[] {
  return [
    rule('checkout-5xx', {
      name: 'Checkout 5xx rate',
      enabled: true,
      source: 'logs',
      query: { logs: checkout5xx(), groupBy: '' },
      comparison: '>',
      threshold: 10,
      windowSeconds: 300,
      intervalSeconds: 60,
      forSeconds: 120,
      repeatSeconds: 4 * 3600,
      labels: { severity: 'critical', team: 'checkout' },
      summary:
        'More than 10 POST /checkout requests failed with a 5xx at the ingress in 5 minutes.',
      channelIds: [CHANNEL_CHECKOUT_SLACK, CHANNEL_PAGERDUTY, CHANNEL_WEBHOOK],
    }),
    rule('payments-p95', {
      name: 'Payments p95 latency',
      enabled: true,
      source: 'traces',
      query: { serviceName: 'payments', metric: 'p95_duration_ms', groupBy: '' },
      comparison: '>',
      threshold: 1500,
      windowSeconds: 300,
      intervalSeconds: 60,
      forSeconds: 180,
      repeatSeconds: 4 * 3600,
      labels: { severity: 'critical', team: 'payments' },
      summary:
        'Payments spans are slow (p95 over 1.5 s): check the database pool and the provider.',
      channelIds: [CHANNEL_PAGERDUTY, CHANNEL_CHECKOUT_SLACK],
    }),
    rule('postgres-connections', {
      name: 'Postgres connections near max',
      enabled: true,
      source: 'metrics',
      query: { promql: 'sum(postgresql_backends) / max(postgresql_connection_max)' },
      comparison: '>',
      threshold: 0.9,
      windowSeconds: 300,
      intervalSeconds: 60,
      forSeconds: 60,
      repeatSeconds: 2 * 3600,
      labels: { severity: 'warning', team: 'platform', service_name: 'postgres' },
      summary: 'Over 90% of max_connections are in use; new connections will soon be refused.',
      channelIds: [CHANNEL_PLATFORM_SLACK, CHANNEL_SRE_EMAIL],
    }),
    rule('node-cpu', {
      name: 'Node CPU high',
      enabled: true,
      source: 'metrics',
      query: { promql: '1 - avg by (host_name) (rate(system_cpu_time{state="idle"}[5m]))' },
      comparison: '>',
      threshold: 0.85,
      windowSeconds: 300,
      intervalSeconds: 60,
      forSeconds: 600,
      repeatSeconds: 4 * 3600,
      labels: { severity: 'warning', team: 'platform' },
      summary: 'A node has been above 85% CPU for 10 minutes.',
      channelIds: [CHANNEL_PLATFORM_SLACK],
    }),
    rule('storefront-traffic', {
      name: 'Storefront traffic dropped',
      enabled: true,
      source: 'metrics',
      query: {
        promql:
          'sum(rate(http_server_request_duration_seconds_count{service_name="storefront"}[5m]))',
      },
      comparison: '<',
      threshold: 0.5,
      windowSeconds: 300,
      intervalSeconds: 60,
      forSeconds: 300,
      repeatSeconds: 4 * 3600,
      labels: { severity: 'critical', team: 'web' },
      summary: 'The storefront serves under 0.5 requests a second: is the ingress or DNS down?',
      channelIds: [CHANNEL_PAGERDUTY, CHANNEL_SRE_EMAIL],
    }),
    rule('search-p95', {
      name: 'Search p95 latency',
      enabled: true,
      source: 'traces',
      query: { serviceName: 'search', metric: 'p95_duration_ms', groupBy: '' },
      comparison: '>',
      threshold: 800,
      windowSeconds: 600,
      intervalSeconds: 60,
      forSeconds: 300,
      repeatSeconds: 4 * 3600,
      labels: { severity: 'warning', team: 'discovery' },
      summary: 'Search queries are slow (p95 over 800 ms for 5 minutes).',
      channelIds: [CHANNEL_PLATFORM_SLACK],
    }),
    rule('auth-failures', {
      name: 'Sign-in failures spike',
      enabled: true,
      source: 'logs',
      query: {
        logs: and(
          cond('service_name', 'equals', 'auth'),
          cond('message', 'contains', 'Failed sign-in'),
        ),
        groupBy: '',
      },
      comparison: '>',
      threshold: 120,
      windowSeconds: 300,
      intervalSeconds: 60,
      forSeconds: 0,
      repeatSeconds: 3600,
      labels: { severity: 'warning', team: 'identity' },
      summary: 'Many failed sign-ins in 5 minutes: possible credential stuffing.',
      channelIds: [CHANNEL_SRE_EMAIL],
    }),
    rule('new-error-patterns', {
      name: 'New error patterns',
      enabled: false,
      source: 'log_patterns',
      query: { logs: errorLevels(), baselineSeconds: 86400, minCount: 20 },
      comparison: '>=',
      threshold: 3,
      windowSeconds: 900,
      intervalSeconds: 300,
      forSeconds: 0,
      repeatSeconds: 12 * 3600,
      labels: { severity: 'info' },
      summary: 'Error messages that were not there yesterday (or tripled).',
      channelIds: [CHANNEL_PLATFORM_SLACK],
    }),
  ];
}

// --- the alerts the incident raises ----------------------------------------------------

export interface IncidentAlert {
  ruleId: string;
  /** Labels the series itself carries (the rule's labels and alertname are added). */
  series: Record<string, string>;
  /** How long into an incident the value crosses the threshold. */
  onsetMs: number;
  /** How long after the incident the value is back under it. */
  clearMs: number;
  /** The value at t while it's above the threshold. */
  peak: (t: number) => number;
  /** The value once resolved. */
  ok: number;
}

export const INCIDENT_ALERTS: IncidentAlert[] = [
  {
    ruleId: RULE_CHECKOUT_5XX,
    series: {},
    onsetMs: 2 * MINUTE,
    clearMs: 3 * MINUTE,
    peak: (t) => Math.round(12 + 44 * incidentLevel(t) * traffic(t)),
    ok: 1,
  },
  {
    ruleId: RULE_PAYMENTS_P95,
    series: {},
    onsetMs: 1.5 * MINUTE,
    clearMs: 4 * MINUTE,
    peak: (t) => Math.round(1600 + 3300 * incidentLevel(t)),
    ok: 312,
  },
  {
    ruleId: RULE_POSTGRES_CONNECTIONS,
    series: {},
    onsetMs: MINUTE,
    clearMs: 2 * MINUTE,
    peak: (t) => Math.round((0.92 + 0.08 * incidentLevel(t)) * 1000) / 1000,
    ok: 0.41,
  },
];

// --- silences ------------------------------------------------------------------------------

export function seedSilences(): Silence[] {
  const now = Date.now();
  const hour = (t: number) => new Date(Math.floor(t / HOUR) * HOUR).toISOString();
  const tomorrowOne = Math.floor(now / DAY) * DAY + DAY + HOUR;
  return [
    {
      id: uuidFrom('demo-silence:search-reindex'),
      projectId: PROJECT_ID,
      matchers: [{ name: 'alertname', value: 'Search p95 latency' }],
      startsAt: hour(now - 2 * HOUR),
      endsAt: hour(now + 5 * HOUR),
      comment: 'Search index rebuild (CHG-2291): slow queries expected until it finishes.',
    },
    {
      id: uuidFrom('demo-silence:postgres-upgrade'),
      projectId: PROJECT_ID,
      matchers: [
        { name: 'team', value: 'platform' },
        { name: 'severity', value: 'warning|info', regex: true },
      ],
      startsAt: new Date(tomorrowOne).toISOString(),
      endsAt: new Date(tomorrowOne + 2 * HOUR).toISOString(),
      comment: 'Postgres 16.4 to 16.5 minor upgrade window (CHG-2304).',
    },
  ];
}
