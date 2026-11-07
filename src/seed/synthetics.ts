// Synthetics sample config: Harborline's probe groups, destinations,
// monitors and maintenance windows. Everything here is made up; hosts are
// *.harborline.example.com and addresses come from the documentation ranges.
import type {
  CheckAlerts,
  CheckView,
  Destination,
  MaintenanceSchedule,
  MaintenanceScope,
} from '../../entity/synthetics';
import { uuidFrom } from '../lib/rng';
import { collection } from '../store';
import { BATCH_HOST, DEMO_USER_ID, PROJECT_ID, STAGING_PROJECT_ID } from '../world';
import { DEMO_SITE_ID } from './site';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The demo's one Site (see ./site); the seeds point destinations at it. */
export { DEMO_SITE_ID };

/** Seed timestamps hang off the start of today, so they don't move on every request. */
export const seedAnchor = () => Math.floor(Date.now() / DAY) * DAY;
const daysAgo = (days: number) => new Date(seedAnchor() - days * DAY).toISOString();

export const PROBE_VERSION = '1.0.0';

// --- probe groups -------------------------------------------------------------

export interface StoredMember {
  name: string;
  version: string;
  /** Days before the anchor it first connected. */
  firstSeenDays: number;
  /** How long ago it was last heard from; undefined = it's live (seconds ago). */
  silentForMs?: number;
}

export interface StoredProbe {
  id: string;
  name: string;
  location: string;
  description: string;
  createdAt: string;
  members: StoredMember[];
  /** A probe group made in the demo: never connects. */
  created?: boolean;
}

const probeSeed = (): StoredProbe[] => [
  {
    id: uuidFrom('probe:aws-eu-west-1'),
    name: 'aws-eu-west-1',
    location: 'aws-eu-west-1',
    description: 'EKS harborline-prod, Dublin (two replicas)',
    createdAt: daysAgo(96),
    members: [
      { name: 'obzly-probe-6f9c7d8b5-k2xvq', version: PROBE_VERSION, firstSeenDays: 1.4 },
      { name: 'obzly-probe-6f9c7d8b5-w7mzt', version: PROBE_VERSION, firstSeenDays: 1.4 },
    ],
  },
  {
    id: uuidFrom('probe:aws-us-east-1'),
    name: 'aws-us-east-1',
    location: 'aws-us-east-1',
    description: 'ECS task in N. Virginia',
    createdAt: daysAgo(81),
    members: [{ name: 'ip-172-31-40-18.ec2.internal', version: PROBE_VERSION, firstSeenDays: 6 }],
  },
  {
    id: uuidFrom('probe:aws-ap-southeast-1'),
    name: 'aws-ap-southeast-1',
    location: 'aws-ap-southeast-1',
    description: 'Singapore; one instance replaced this morning',
    createdAt: daysAgo(64),
    members: [
      { name: 'probe-sg-02', version: PROBE_VERSION, firstSeenDays: 0.3 },
      // The instance it replaced: still listed for 24 h, no longer live.
      { name: 'probe-sg-01', version: '0.58.1', firstSeenDays: 23, silentForMs: 5.2 * HOUR },
    ],
  },
  {
    id: uuidFrom('probe:office-london'),
    name: 'office-london',
    location: 'office-london',
    description: 'Docker on the London office NUC, reaches the VPN',
    createdAt: daysAgo(52),
    members: [{ name: 'ldn-nuc-01', version: '0.58.1', firstSeenDays: 19 }],
  },
];

export const probes = collection<StoredProbe>('synthetics.probes', probeSeed);

// --- destinations ---------------------------------------------------------------

export const PROD_DESTINATION_ID = uuidFrom('destination:harborline-shop');
export const STAGING_DESTINATION_ID = uuidFrom('destination:harborline-staging');

const destinationSeed = (): Destination[] => [
  {
    id: PROD_DESTINATION_ID,
    name: 'Harborline Shop',
    siteId: DEMO_SITE_ID,
    projectId: PROJECT_ID,
    otlpUrl: 'https://obzly-eu.harborline.example.com/otlp',
    apiKeyHint: 'obz_…4f1a',
    createdAt: daysAgo(96),
  },
  {
    id: STAGING_DESTINATION_ID,
    name: 'Harborline Staging',
    siteId: DEMO_SITE_ID,
    projectId: STAGING_PROJECT_ID,
    otlpUrl: 'https://obzly-eu.harborline.example.com/otlp',
    apiKeyHint: 'obz_…9c07',
    createdAt: daysAgo(70),
  },
];

export const destinations = collection<Destination>('synthetics.destinations', destinationSeed);

// --- monitors -------------------------------------------------------------------

/** A monitor as stored: the view without its derived parts. */
export interface StoredCheck extends Omit<CheckView, 'destination' | 'secrets'> {
  destinationId: string;
  /** Placeholders with a stored value (values themselves are never kept). */
  storedSecrets: string[];
}

export const checkId = (slug: string) => uuidFrom(`check:${slug}`);

const NO_ALERTS: CheckAlerts = { channelIds: [], notify: '', certDays: 0, repeatSeconds: 0 };

type CheckSeed = Omit<
  StoredCheck,
  'id' | 'version' | 'createdAt' | 'updatedAt' | 'alerts' | 'storedSecrets' | 'destinationId'
> & {
  slug: string;
  ageDays: number;
  version?: number;
  storedSecrets?: string[];
  destinationId?: string;
};

const CHECKS: CheckSeed[] = [
  {
    slug: 'storefront-home',
    name: 'Storefront home page',
    type: 'http',
    enabled: true,
    folder: 'Shop',
    parentIds: [],
    intervalSeconds: 60,
    downLocations: 2,
    locations: [],
    ageDays: 94,
    version: 4,
    definition: {
      type: 'http',
      timeoutSeconds: 10,
      request: { method: 'GET', url: 'https://www.harborline.example.com/', followRedirects: true },
      assertions: [
        { kind: 'status', op: 'equals', value: '200' },
        { kind: 'response_time_ms', op: 'below', number: 3000 },
        { kind: 'response_time_ms', op: 'below', number: 1800, severity: 'warn' },
        { kind: 'body', op: 'contains', value: 'Harborline' },
      ],
    },
  },
  {
    slug: 'checkout-api',
    name: 'Checkout API health',
    type: 'http',
    enabled: true,
    folder: 'Shop/Checkout',
    parentIds: [],
    intervalSeconds: 60,
    downLocations: 2,
    locations: [],
    ageDays: 94,
    version: 6,
    definition: {
      type: 'http',
      timeoutSeconds: 10,
      request: {
        method: 'GET',
        url: 'https://api.harborline.example.com/checkout/health',
        headers: { Accept: 'application/json' },
      },
      assertions: [
        { kind: 'status', op: 'equals', value: '200' },
        { kind: 'response_time_ms', op: 'below', number: 2000 },
        { kind: 'response_time_ms', op: 'below', number: 800, severity: 'warn' },
        { kind: 'header', op: 'contains', name: 'Content-Type', value: 'application/json' },
        { kind: 'json', op: 'equals', path: '$.status', value: 'ok' },
        { kind: 'json', op: 'exists', path: '$.checks.payments' },
      ],
    },
  },
  {
    slug: 'checkout-flow',
    name: 'Checkout flow',
    type: 'multi',
    enabled: true,
    folder: 'Shop/Checkout',
    parentIds: [checkId('checkout-api')],
    intervalSeconds: 300,
    downLocations: 2,
    locations: ['aws-eu-west-1', 'aws-us-east-1', 'office-london'],
    ageDays: 41,
    version: 9,
    storedSecrets: ['OBZLY_SECRET_CHECKOUT_PASSWORD'],
    definition: {
      type: 'multi',
      timeoutSeconds: 60,
      variables: {
        user: 'synthetic-buyer@harborline.example.com',
        password: '${env:OBZLY_SECRET_CHECKOUT_PASSWORD}',
      },
      steps: [
        {
          name: 'Sign in',
          request: {
            method: 'POST',
            url: 'https://api.harborline.example.com/auth/login',
            headers: { 'Content-Type': 'application/json' },
            body: '{"email":"{{user}}","password":"{{password}}"}',
          },
          assertions: [{ kind: 'status', op: 'equals', value: '200' }],
          extract: [{ name: 'token', from: 'json', path: '$.accessToken', secret: true }],
        },
        {
          name: 'Add to cart',
          request: {
            method: 'POST',
            url: 'https://api.harborline.example.com/cart/items',
            headers: { Authorization: 'Bearer {{token}}', 'Content-Type': 'application/json' },
            body: '{"sku":"LANTERN-BRASS-S","qty":1}',
          },
          assertions: [
            { kind: 'status', op: 'equals', value: '201' },
            { kind: 'json', op: 'exists', path: '$.cartId' },
          ],
          extract: [{ name: 'cartId', from: 'json', path: '$.cartId' }],
        },
        {
          name: 'Create order',
          request: {
            method: 'POST',
            url: 'https://api.harborline.example.com/checkout/orders',
            headers: {
              Authorization: 'Bearer {{token}}',
              'Idempotency-Key': '{{$uuid}}',
              'Content-Type': 'application/json',
            },
            body: '{"cartId":"{{cartId}}","payment":"test-card"}',
          },
          assertions: [
            { kind: 'status', op: 'equals', value: '201' },
            { kind: 'json', op: 'equals', path: '$.state', value: 'pending' },
            { kind: 'response_time_ms', op: 'below', number: 2500 },
          ],
          extract: [{ name: 'orderId', from: 'json', path: '$.id' }],
        },
        {
          name: 'Cancel order',
          continueOnFailure: true,
          request: {
            method: 'DELETE',
            url: 'https://api.harborline.example.com/checkout/orders/{{orderId}}',
            headers: { Authorization: 'Bearer {{token}}' },
          },
          assertions: [{ kind: 'status', op: 'in', values: [204, 404] }],
        },
      ],
    },
  },
  {
    slug: 'search-api',
    name: 'Catalog search API',
    type: 'http',
    enabled: true,
    folder: 'Shop',
    parentIds: [],
    intervalSeconds: 120,
    downLocations: 2,
    locations: [],
    ageDays: 77,
    version: 3,
    definition: {
      type: 'http',
      timeoutSeconds: 10,
      request: {
        method: 'GET',
        url: 'https://api.harborline.example.com/search?q=lantern&limit=24',
        headers: { Accept: 'application/json' },
      },
      assertions: [
        { kind: 'status', op: 'equals', value: '200' },
        { kind: 'response_time_ms', op: 'below', number: 2500 },
        { kind: 'json', op: 'exists', path: '$.results' },
      ],
    },
  },
  {
    slug: 'auth-login',
    name: 'Sign-in page',
    type: 'http',
    enabled: true,
    folder: 'Identity',
    parentIds: [],
    intervalSeconds: 120,
    downLocations: 2,
    locations: [],
    ageDays: 88,
    version: 2,
    definition: {
      type: 'http',
      timeoutSeconds: 10,
      request: { method: 'GET', url: 'https://auth.harborline.example.com/login' },
      // The certificate monitor below warns about expiry; this one only fails.
      tls: { warnDays: 5 },
      assertions: [
        { kind: 'status', op: 'equals', value: '200' },
        { kind: 'body', op: 'contains', value: 'Sign in' },
      ],
    },
  },
  {
    slug: 'auth-cert',
    name: 'auth.harborline.example.com certificate',
    type: 'tls',
    enabled: true,
    folder: 'Platform/Certificates',
    parentIds: [],
    intervalSeconds: 3600,
    downLocations: 1,
    locations: ['aws-eu-west-1', 'aws-us-east-1'],
    ageDays: 88,
    definition: {
      type: 'tls',
      target: 'auth.harborline.example.com:443',
      timeoutSeconds: 10,
      tls: { warnDays: 21, failDays: 7, minProtocol: 'TLS1.2', verifyHostname: true },
    },
  },
  {
    slug: 'www-cert',
    name: 'www.harborline.example.com certificate',
    type: 'tls',
    enabled: true,
    folder: 'Platform/Certificates',
    parentIds: [],
    intervalSeconds: 3600,
    downLocations: 1,
    locations: ['aws-eu-west-1', 'aws-us-east-1'],
    ageDays: 88,
    definition: {
      type: 'tls',
      target: 'www.harborline.example.com:443',
      timeoutSeconds: 10,
      tls: { warnDays: 21, failDays: 7, minProtocol: 'TLS1.2', verifyHostname: true },
    },
  },
  {
    slug: 'apex-dns',
    name: 'Apex A records',
    type: 'dns',
    enabled: true,
    folder: 'Platform',
    parentIds: [],
    intervalSeconds: 300,
    downLocations: 2,
    locations: [],
    ageDays: 90,
    definition: {
      type: 'dns',
      target: 'harborline.example.com',
      timeoutSeconds: 5,
      dns: {
        recordType: 'A',
        resolver: '192.0.2.53:53',
        expectAnyOf: ['203.0.113.10', '203.0.113.11'],
      },
    },
  },
  {
    slug: 'sftp-port',
    name: 'Partner SFTP port',
    type: 'tcp',
    enabled: true,
    folder: 'Data',
    parentIds: [],
    intervalSeconds: 120,
    downLocations: 1,
    locations: ['aws-eu-west-1', 'office-london'],
    ageDays: 33,
    definition: { type: 'tcp', target: 'sftp.harborline.example.com:22', timeoutSeconds: 5 },
  },
  {
    slug: 'batch-ping',
    name: 'Batch host ping',
    type: 'icmp',
    enabled: true,
    folder: 'Data',
    parentIds: [],
    intervalSeconds: 60,
    downLocations: 1,
    locations: ['aws-eu-west-1', 'office-london'],
    ageDays: 33,
    definition: {
      type: 'icmp',
      target: BATCH_HOST,
      timeoutSeconds: 5,
      icmp: { count: 5, maxLossRatio: 0.2, rttWarnMs: 40 },
    },
  },
  {
    slug: 'status-page',
    name: 'Status page',
    type: 'http',
    enabled: true,
    folder: '',
    parentIds: [],
    intervalSeconds: 300,
    downLocations: 0,
    locations: ['aws-us-east-1', 'aws-ap-southeast-1'],
    ageDays: 60,
    definition: {
      type: 'http',
      timeoutSeconds: 10,
      request: { method: 'GET', url: 'https://status.harborline.example.com/' },
      assertions: [{ kind: 'status', op: 'equals', value: '200' }],
    },
  },
  {
    slug: 'staging-storefront',
    name: 'Staging storefront',
    type: 'http',
    enabled: true,
    folder: 'Staging',
    parentIds: [],
    intervalSeconds: 300,
    downLocations: 1,
    locations: ['aws-eu-west-1'],
    ageDays: 58,
    destinationId: STAGING_DESTINATION_ID,
    definition: {
      type: 'http',
      timeoutSeconds: 10,
      request: { method: 'GET', url: 'https://staging.harborline.example.com/' },
      assertions: [{ kind: 'status', op: 'equals', value: '200' }],
    },
  },
  {
    slug: 'legacy-status',
    name: 'Legacy status page',
    type: 'http',
    enabled: false,
    folder: '',
    parentIds: [],
    intervalSeconds: 600,
    downLocations: 0,
    locations: [],
    ageDays: 140,
    version: 5,
    definition: {
      type: 'http',
      timeoutSeconds: 10,
      request: { method: 'GET', url: 'https://status-old.harborline.example.com/' },
      assertions: [{ kind: 'status', op: 'equals', value: '200' }],
    },
  },
];

const checkSeed = (): StoredCheck[] =>
  CHECKS.map(({ slug, ageDays, version, storedSecrets, destinationId, ...rest }) => ({
    ...rest,
    id: checkId(slug),
    destinationId: destinationId ?? PROD_DESTINATION_ID,
    storedSecrets: storedSecrets ?? [],
    alerts: { ...NO_ALERTS },
    version: version ?? 1,
    createdAt: daysAgo(ageDays),
    // A disabled monitor stopped reporting when it was switched off.
    updatedAt: daysAgo(rest.enabled ? Math.min(ageDays, 3 + (slug.length % 9)) : 21),
  }));

export const checks = collection<StoredCheck>('synthetics.checks', checkSeed);

// --- maintenance windows --------------------------------------------------------

export interface OccurrenceOverride {
  /** The scheduled start it moves (ms). */
  occurrence: number;
  start: number;
  end: number;
}

export interface StoredWindow {
  id: string;
  name: string;
  reason: string;
  scope: MaintenanceScope;
  schedule: MaintenanceSchedule;
  enabled: boolean;
  version: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  adjustments: OccurrenceOverride[];
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const windowSeed = (): StoredWindow[] => {
  const anchor = seedAnchor();
  return [
    {
      id: uuidFrom('maintenance:db-patching'),
      name: 'Weekly database patching',
      reason: 'Postgres minor upgrades and vacuum; the partner SFTP and batch host restart too.',
      scope: { all: false, monitorIds: [], folders: ['Data'] },
      schedule: {
        kind: 'weekly',
        timeZone: 'Europe/London',
        startTime: '02:00',
        durationMinutes: 60,
        weekdays: ['sun'],
        startDate: isoDate(anchor - 60 * DAY),
      },
      enabled: true,
      version: 2,
      createdBy: DEMO_USER_ID,
      createdAt: daysAgo(60),
      updatedAt: daysAgo(12),
      adjustments: [],
    },
    {
      id: uuidFrom('maintenance:payments-upgrade'),
      name: 'Payments provider upgrade',
      reason: 'The card processor moves us to its new API; checkout may return 503 briefly.',
      scope: {
        all: false,
        monitorIds: [checkId('checkout-api'), checkId('checkout-flow')],
        folders: [],
      },
      schedule: {
        kind: 'once',
        startsAt: new Date(anchor + 2 * DAY + 21 * HOUR).toISOString(),
        endsAt: new Date(anchor + 2 * DAY + 23 * HOUR).toISOString(),
        timeZone: 'UTC',
      },
      enabled: true,
      version: 1,
      createdBy: DEMO_USER_ID,
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
      adjustments: [],
    },
    {
      id: uuidFrom('maintenance:cert-rotation'),
      name: 'Certificate rotation',
      reason: 'Rotating the edge certificates; TLS monitors may flap.',
      scope: { all: false, monitorIds: [], folders: ['Platform/Certificates'] },
      schedule: {
        kind: 'monthly_weekday',
        timeZone: 'UTC',
        startTime: '06:00',
        durationMinutes: 30,
        weekOfMonth: 1,
        weekday: 'tue',
        startDate: isoDate(anchor - 120 * DAY),
      },
      enabled: true,
      version: 1,
      createdBy: DEMO_USER_ID,
      createdAt: daysAgo(120),
      updatedAt: daysAgo(120),
      adjustments: [],
    },
    {
      id: uuidFrom('maintenance:office-network'),
      name: 'Office network works',
      reason: 'ISP line swap at the London office.',
      scope: { all: false, monitorIds: [], folders: [] },
      schedule: {
        kind: 'once',
        startsAt: new Date(anchor - 5 * DAY + 18 * HOUR).toISOString(),
        endsAt: new Date(anchor - 5 * DAY + 20 * HOUR).toISOString(),
        timeZone: 'Europe/London',
      },
      enabled: true,
      version: 1,
      createdBy: DEMO_USER_ID,
      createdAt: daysAgo(9),
      updatedAt: daysAgo(9),
      adjustments: [],
    },
    {
      id: uuidFrom('maintenance:all-hands'),
      name: 'Quarterly DR drill',
      reason: 'Failover rehearsal; paused until the next drill is booked.',
      scope: { all: true, monitorIds: [], folders: [] },
      schedule: {
        kind: 'monthly_day',
        timeZone: 'UTC',
        startTime: '05:00',
        durationMinutes: 90,
        dayOfMonth: 15,
        startDate: isoDate(anchor - 200 * DAY),
      },
      enabled: false,
      version: 3,
      createdBy: DEMO_USER_ID,
      createdAt: daysAgo(200),
      updatedAt: daysAgo(30),
      adjustments: [],
    },
  ];
};

// The office window covers the office probe's checks by id.
const officeIds = [checkId('sftp-port'), checkId('batch-ping')];
const seededWindows = () =>
  windowSeed().map((w) =>
    w.id === uuidFrom('maintenance:office-network')
      ? { ...w, scope: { ...w.scope, monitorIds: officeIds } }
      : w,
  );

export const maintenanceWindows = collection<StoredWindow>('synthetics.maintenance', seededWindows);
