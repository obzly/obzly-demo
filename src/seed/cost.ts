// Cloud cost for the two seeded connections: Harborline's AWS account from a FOCUS export
// (resource level, USD, 13 months) and the analytics team's Azure subscription from the Cost
// Management API (service and region only, EUR). Rows are worked out per day from a seed, so
// every visitor sees the same numbers; nothing here is a real bill.
import { hashString, mix, rng } from '../lib/rng';
import { BATCH_HOST, NODES, PROJECT_ID, REGION, STAGING_PROJECT_ID } from '../world';
import {
  AWS_ACCOUNT,
  AWS_CONNECTION_ID,
  AZURE_CONNECTION_ID,
  AZURE_REGION,
  AZURE_SUBSCRIPTION,
  cloudResources,
  instanceId,
} from './inventory';

export const DAY = 86_400_000;
/** The AWS export goes back 13 months; the Azure API read backfilled 90 days. */
export const AWS_HISTORY_DAYS = 400;
export const AZURE_HISTORY_DAYS = 90;
/** The provider hasn't finalised the last two days. */
export const ESTIMATED_DAYS = 2;
/** The data transfer spike Anomalies flags. */
export const SPIKE_DAYS_AGO = 9;

export const AWS_ACCOUNT_NAME = 'Harborline production';
export const AZURE_ACCOUNT_NAME = 'Analytics subscription';
export const AWS_CONNECTION_NAME = 'Harborline production (AWS)';
export const AZURE_CONNECTION_NAME = 'Analytics subscription (Azure)';

export interface CostLine {
  connectionId: string;
  projectId: string;
  provider: 'aws' | 'azure';
  source: 'export' | 'api';
  account: string;
  accountName: string;
  service: string;
  region: string;
  resource: string;
  charge: string;
  /** Standard (on demand), Committed or Dynamic (spot). */
  pricing: string;
  currency: string;
  tags: Record<string, string>;
  /** Effective cost a day, before trend, weekday and noise. */
  daily: number;
  /** Days ago the line started (a resource created later). */
  since?: number;
  /** Weekends cost less (traffic-driven lines). */
  weekly?: boolean;
}

export interface CostRow {
  line: CostLine;
  day: string;
  billed: number;
  effective: number;
  estimated: boolean;
}

const resourceId = (name: string) => cloudResources().find((r) => r.name === name)?.id ?? '';

export const UNATTACHED_VOLUME = `arn:aws:ec2:${REGION}:${AWS_ACCOUNT}:volume/vol-0c4e9a1b7d2f30558`;
export const GP2_VOLUME = `arn:aws:ec2:${REGION}:${AWS_ACCOUNT}:volume/vol-0a7f3e2d9c1b40261`;
export const UNUSED_EIP = `arn:aws:ec2:${REGION}:${AWS_ACCOUNT}:elastic-ip/eipalloc-0b5d2e8f1a9c37460`;

function lines(): CostLine[] {
  const aws = (partial: Partial<CostLine> & Pick<CostLine, 'service' | 'daily'>): CostLine => ({
    connectionId: AWS_CONNECTION_ID,
    projectId: PROJECT_ID,
    provider: 'aws',
    source: 'export',
    account: AWS_ACCOUNT,
    accountName: AWS_ACCOUNT_NAME,
    region: REGION,
    resource: '',
    charge: 'Usage',
    pricing: 'Standard',
    currency: 'USD',
    tags: { team: 'platform', env: 'prod' },
    ...partial,
  });
  const azure = (partial: Partial<CostLine> & Pick<CostLine, 'service' | 'daily'>): CostLine => ({
    connectionId: AZURE_CONNECTION_ID,
    projectId: STAGING_PROJECT_ID,
    provider: 'azure',
    source: 'api',
    account: AZURE_SUBSCRIPTION,
    accountName: AZURE_ACCOUNT_NAME,
    region: AZURE_REGION,
    resource: '',
    charge: 'Usage',
    pricing: 'Standard',
    currency: 'EUR',
    tags: {},
    ...partial,
  });
  const ec2 = 'Amazon Elastic Compute Cloud';
  return [
    // The EKS nodes: part covered by the Compute Savings Plan.
    ...NODES.flatMap((node) => [
      aws({
        service: ec2,
        resource: instanceId(node),
        daily: 2.95,
        tags: { team: 'shop', env: 'prod' },
      }),
      aws({
        service: ec2,
        resource: instanceId(node),
        daily: 1.66,
        pricing: 'Committed',
        tags: { team: 'shop', env: 'prod' },
      }),
    ]),
    aws({
      service: ec2,
      resource: instanceId(BATCH_HOST),
      daily: 2.0,
      tags: { team: 'data', env: 'prod' },
    }),
    aws({
      service: ec2,
      resource: GP2_VOLUME,
      daily: 1.64,
      tags: { team: 'data', env: 'prod' },
    }),
    aws({
      service: ec2,
      resource: UNATTACHED_VOLUME,
      daily: 0.8,
      tags: { team: 'data', env: 'prod' },
    }),
    aws({ service: ec2, resource: UNUSED_EIP, daily: 0.12 }),
    aws({ service: ec2, daily: 3.1, weekly: true }), // NAT gateway and data transfer
    aws({
      service: 'Amazon Elastic Kubernetes Service',
      resource: resourceId('harborline-prod'),
      daily: 2.4,
    }),
    aws({
      service: 'Elastic Load Balancing',
      resource: resourceId('k8s-shop-ingress'),
      daily: 1.15,
      weekly: true,
      tags: { team: 'shop', env: 'prod' },
    }),
    aws({
      service: 'Elastic Load Balancing',
      resource: resourceId('partner-sftp'),
      daily: 0.6,
    }),
    aws({
      service: 'Amazon Relational Database Service',
      resource: resourceId('harborline-reporting'),
      daily: 6.2,
      pricing: 'Committed',
      tags: { team: 'data', env: 'prod' },
    }),
    aws({
      service: 'Amazon Relational Database Service',
      resource: resourceId('legacy-orders-mysql'),
      daily: 1.2,
      tags: { team: 'shop', env: 'prod' },
    }),
    aws({
      service: 'Amazon Simple Storage Service',
      resource: resourceId('harborline-assets-prod'),
      daily: 2.3,
      weekly: true,
      tags: { team: 'shop', env: 'prod' },
    }),
    aws({
      service: 'Amazon Simple Storage Service',
      resource: resourceId('harborline-backups-eu'),
      daily: 1.7,
    }),
    aws({
      service: 'Amazon Simple Storage Service',
      resource: resourceId('harborline-logs-archive'),
      daily: 0.9,
    }),
    aws({
      service: 'Amazon Simple Storage Service',
      resource: resourceId('harborline-dr-backups'),
      region: 'us-east-1',
      daily: 0.6,
      since: 190,
    }),
    aws({
      service: 'AWS Lambda',
      resource: resourceId('image-resizer'),
      daily: 0.35,
      weekly: true,
      tags: { team: 'shop', env: 'prod' },
      since: 133,
    }),
    aws({
      service: 'AWS Lambda',
      resource: resourceId('order-webhook-relay'),
      daily: 0.15,
      tags: { team: 'shop', env: 'prod' },
      since: 71,
    }),
    aws({ service: 'Amazon CloudWatch', daily: 1.5 }),
    aws({ service: 'AWS Key Management Service', daily: 0.13 }),
    aws({ service: 'Tax', charge: 'Tax', daily: 0, tags: {} }),
    azure({ service: 'Virtual Machines', daily: 13.3 }),
    azure({ service: 'Azure Kubernetes Service', daily: 2.2 }),
    azure({ service: 'Azure Database for PostgreSQL', daily: 3.2 }),
    azure({ service: 'Storage', daily: 1.4 }),
    azure({ service: 'Application Gateway', daily: 4.3, since: 120 }),
    azure({ service: 'Bandwidth', daily: 0.6 }),
  ];
}

let cachedLines: CostLine[] | undefined;
export const costLines = () => (cachedLines ??= lines());

export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
export const today = (now = Date.now()) => Math.floor(now / DAY) * DAY;

/** One line's cost on one day (0 before it started), by trend, weekday and noise. */
function amount(line: CostLine, day: number, todayStart: number): number {
  const ago = Math.round((todayStart - day) / DAY);
  if (line.since !== undefined && ago > line.since) return 0;
  const r = rng(
    mix(hashString(`${line.service}|${line.resource}|${line.pricing}`), Math.floor(day / DAY)),
  );
  // Steady growth: about 15% a year.
  let value = line.daily * (1 - ago * 0.0004) * (0.94 + r() * 0.12);
  const weekday = new Date(day).getUTCDay();
  if (line.weekly && (weekday === 0 || weekday === 6)) value *= 0.78;
  if (line.service === 'Amazon Elastic Compute Cloud' && !line.resource && ago === SPIKE_DAYS_AGO) {
    value *= 9; // A partner backfill pulled 2 TB over the NAT gateway.
  }
  // Today is a partial day.
  if (ago === 0) value *= 0.45;
  return Math.round(value * 100) / 100;
}

/** Every row from..to (day starts, inclusive), for the lines that pass keep. */
export function costRows(
  from: number,
  to: number,
  keep: (line: CostLine) => boolean = () => true,
  now = Date.now(),
): CostRow[] {
  const todayStart = today(now);
  const out: CostRow[] = [];
  for (const line of costLines()) {
    if (!keep(line)) continue;
    const history = line.provider === 'aws' ? AWS_HISTORY_DAYS : AZURE_HISTORY_DAYS;
    const first = Math.max(from, todayStart - history * DAY);
    for (let day = first; day <= Math.min(to, todayStart); day += DAY) {
      const ago = Math.round((todayStart - day) / DAY);
      let effective = amount(line, day, todayStart);
      if (line.charge === 'Tax') {
        // Tax lands on the first of the month, on last month's bill.
        if (new Date(day).getUTCDate() !== 1) continue;
        effective = 41.2;
      }
      if (effective === 0) continue;
      // Committed usage: billed shows the plan's hourly fee, effective spreads it the same way here.
      const billed =
        line.pricing === 'Committed' ? Math.round(effective * 1.02 * 100) / 100 : effective;
      out.push({
        line,
        day: dayKey(day),
        billed,
        effective,
        estimated: ago < ESTIMATED_DAYS,
      });
    }
  }
  return out;
}

/** The first and last day each connection's source has delivered. */
export function sourceSpans(now = Date.now()) {
  const todayStart = today(now);
  return [
    {
      connectionId: AWS_CONNECTION_ID,
      connectionName: AWS_CONNECTION_NAME,
      projectId: PROJECT_ID,
      provider: 'aws' as const,
      source: 'export' as const,
      from: dayKey(todayStart - AWS_HISTORY_DAYS * DAY),
      to: dayKey(todayStart),
      finalThrough: dayKey(todayStart - ESTIMATED_DAYS * DAY),
      deliveredAt: new Date(
        todayStart + 4 * 3_600_000 > now ? todayStart - 20 * 3_600_000 : todayStart + 4 * 3_600_000,
      ).toISOString(),
    },
    {
      connectionId: AZURE_CONNECTION_ID,
      connectionName: AZURE_CONNECTION_NAME,
      projectId: STAGING_PROJECT_ID,
      provider: 'azure' as const,
      source: 'api' as const,
      from: dayKey(todayStart - AZURE_HISTORY_DAYS * DAY),
      to: dayKey(todayStart),
      finalThrough: dayKey(todayStart - ESTIMATED_DAYS * DAY),
      deliveredAt: new Date(
        todayStart + 2 * 3_600_000 > now ? todayStart - 22 * 3_600_000 : todayStart + 2 * 3_600_000,
      ).toISOString(),
    },
  ];
}
