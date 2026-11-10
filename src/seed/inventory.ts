// Cloud connections and what their scans find: Harborline's AWS account
// (the EKS cluster's nodes, the batch VM, load balancers, RDS, S3, Lambda)
// and the analytics team's Azure subscription in West Europe. Account ids,
// subscription GUIDs, ARNs and names are all made up.
import type {
  CloudAccess,
  CloudProvider,
  CloudScope,
  CloudUse,
  CostSettings,
  PostureSettings,
} from '../../entity/cloud';
import { hashString, hex, uuidFrom } from '../lib/rng';
import { collection } from '../store';
import { BATCH_HOST, CLUSTER, DEMO_USER_ID, NODES, REGION } from '../world';
import { PROD_DESTINATION_ID, STAGING_DESTINATION_ID, seedAnchor } from './synthetics';

const DAY = 24 * 3_600_000;

export const AWS_ACCOUNT = '123456789012';
export const AZURE_SUBSCRIPTION = '3f9a6c2e-8b1d-4e57-a0c4-6d2e9f1b7a35';
export const AZURE_TENANT = '0c6e2a9f-71b4-4d3e-8a5c-f4b9d2e1a603';
export const AZURE_CLIENT_ID = '9b2e4d71-5c3a-4f8e-b6d0-2a7c1e9f4b58';
export const AZURE_REGION = 'westeurope';

export const AWS_CONNECTION_ID = uuidFrom('cloud:aws-prod');
export const AZURE_CONNECTION_ID = uuidFrom('cloud:azure-analytics');

export interface StoredConnection {
  id: string;
  name: string;
  provider: CloudProvider;
  scope: CloudScope;
  scopeId: string;
  access: CloudAccess;
  identity: string;
  externalId: string;
  tenantId: string;
  probeId: string;
  destinationId: string;
  scanTypes: CloudUse[];
  regions: string[];
  resourceTypes: string[];
  intervalSeconds: number;
  healthIntervalSeconds: number;
  /** Set when scanTypes has cost / posture. */
  cost?: CostSettings;
  posture?: PostureSettings;
  enabled: boolean;
  version: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** Seeded connections scan; ones made in the demo wait for a probe that never comes. */
  seeded?: boolean;
}

export const externalIdFor = (seed: string) =>
  `obz-${hex(hashString(`ext:${seed}`), 32)}-${hex(hashString(`mac:${seed}`), 16)}`;

const connectionSeed = (): StoredConnection[] => [
  {
    id: AWS_CONNECTION_ID,
    name: 'Harborline production (AWS)',
    provider: 'aws',
    scope: 'account',
    scopeId: AWS_ACCOUNT,
    access: 'role',
    identity: `arn:aws:iam::${AWS_ACCOUNT}:role/obzly-readonly`,
    externalId: externalIdFor('aws-prod'),
    tenantId: '',
    probeId: uuidFrom('probe:aws-eu-west-1'),
    destinationId: PROD_DESTINATION_ID,
    scanTypes: ['inventory', 'cost', 'posture'],
    cost: {
      source: 'export',
      scope: 'account',
      export: { bucket: 'harborline-billing-exports', region: REGION, prefix: 'focus/harborline' },
      refreshHours: 12,
      trackedTags: ['team', 'env'],
    },
    posture: { source: 'auto', refreshHours: 12 },
    regions: [REGION, 'us-east-1'],
    resourceTypes: [],
    intervalSeconds: 14_400,
    healthIntervalSeconds: 900,
    enabled: true,
    version: 3,
    createdBy: DEMO_USER_ID,
    createdAt: new Date(seedAnchor() - 38 * DAY).toISOString(),
    updatedAt: new Date(seedAnchor() - 11 * DAY).toISOString(),
    seeded: true,
  },
  {
    id: AZURE_CONNECTION_ID,
    name: 'Analytics subscription (Azure)',
    provider: 'azure',
    scope: 'subscription',
    scopeId: AZURE_SUBSCRIPTION,
    access: 'workload',
    identity: AZURE_CLIENT_ID,
    externalId: '',
    tenantId: AZURE_TENANT,
    probeId: uuidFrom('probe:aws-eu-west-1'),
    destinationId: STAGING_DESTINATION_ID,
    scanTypes: ['inventory', 'cost', 'posture'],
    cost: { source: 'api', scope: 'account', refreshHours: 12, trackedTags: ['team', 'env'] },
    posture: { source: 'auto', refreshHours: 12 },
    regions: [AZURE_REGION],
    resourceTypes: [],
    intervalSeconds: 14_400,
    healthIntervalSeconds: 900,
    enabled: true,
    version: 1,
    createdBy: DEMO_USER_ID,
    createdAt: new Date(seedAnchor() - 17 * DAY).toISOString(),
    updatedAt: new Date(seedAnchor() - 17 * DAY).toISOString(),
    seeded: true,
  },
];

export const cloudConnections = collection<StoredConnection>('cloud.connections', connectionSeed);

// --- what the scans find -------------------------------------------------------------

/** One resource as a probe reports it (discovery.Resource). */
export interface CloudResource {
  connectionId: string;
  provider: CloudProvider;
  accountId: string;
  region: string;
  type: string;
  id: string;
  name: string;
  state: string;
  health?: string;
  attributes: Record<string, string>;
  targets?: Record<string, number>;
  /** Days it has existed; a fraction of a day is a recent arrival. */
  ageDays: number;
}

export const instanceId = (name: string) => `i-0${hex(hashString(`ec2:${name}`), 16)}`;

const AZ = ['a', 'b', 'c'];
const azureId = (group: string, provider: string, name: string) =>
  `/subscriptions/${AZURE_SUBSCRIPTION}/resourcegroups/${group}/providers/${provider}/${name}`.toLowerCase();

/** The node a replacement took over from (it left the cluster yesterday). */
export const REPLACED_NODE = 'ip-10-20-1-61.eu-west-1.compute.internal';
/** Hours ago the node replacement happened, the new bucket appeared... */
export const REPLACEMENT_HOURS_AGO = 9;
export const NEW_BUCKET_HOURS_AGO = 3;

const aws = (
  partial: Omit<CloudResource, 'connectionId' | 'provider' | 'accountId' | 'region'> & {
    region?: string;
  },
): CloudResource => ({
  connectionId: AWS_CONNECTION_ID,
  provider: 'aws',
  accountId: AWS_ACCOUNT,
  region: REGION,
  ...partial,
});

const azure = (
  partial: Omit<CloudResource, 'connectionId' | 'provider' | 'accountId' | 'region'>,
): CloudResource => ({
  connectionId: AZURE_CONNECTION_ID,
  provider: 'azure',
  accountId: AZURE_SUBSCRIPTION,
  region: AZURE_REGION,
  ...partial,
});

export function cloudResources(): CloudResource[] {
  const nodes = NODES.map((node, i) =>
    aws({
      type: 'aws_ec2_instance',
      id: instanceId(node),
      name: node,
      state: 'running',
      health: 'healthy',
      ageDays: node === NODES[3] ? REPLACEMENT_HOURS_AGO / 24 : 34 - i * 3,
      attributes: {
        host_id: instanceId(node),
        instance_type: 'm6i.xlarge',
        cloud_availability_zone: `${REGION}${AZ[i % 3]}`,
        vpc_id: 'vpc-0a1b2c3d4e5f60718',
        private_dns_name: node,
      },
    }),
  );
  return [
    ...nodes,
    aws({
      type: 'aws_ec2_instance',
      id: instanceId(BATCH_HOST),
      name: 'batch-01',
      state: 'running',
      health: 'healthy',
      ageDays: 212,
      attributes: {
        host_id: instanceId(BATCH_HOST),
        instance_type: 't3.large',
        cloud_availability_zone: `${REGION}b`,
        vpc_id: 'vpc-0a1b2c3d4e5f60718',
        private_dns_name: 'ip-10-20-8-40.eu-west-1.compute.internal',
      },
    }),
    aws({
      type: 'aws_eks_cluster',
      id: `arn:aws:eks:${REGION}:${AWS_ACCOUNT}:cluster/${CLUSTER}`,
      name: CLUSTER,
      state: 'active',
      ageDays: 403,
      attributes: { k8s_cluster_name: CLUSTER, k8s_version: '1.31' },
    }),
    aws({
      type: 'aws_autoscaling_group',
      id: `arn:aws:autoscaling:${REGION}:${AWS_ACCOUNT}:autoScalingGroup:6c1d9e2a-4b7f-4a30-9d58-2e1f0c7b8a64:autoScalingGroupName/eks-general-4cc5b2f1`,
      name: 'eks-general-4cc5b2f1',
      state: '',
      ageDays: 403,
      attributes: { desired: '4', healthy: '4' },
    }),
    aws({
      type: 'aws_load_balancer',
      id: `arn:aws:elasticloadbalancing:${REGION}:${AWS_ACCOUNT}:loadbalancer/app/k8s-shop-ingress/7f3a2c1b9e0d4a21`,
      name: 'k8s-shop-ingress',
      state: 'active',
      ageDays: 401,
      attributes: {
        lb_type: 'application',
        lb_scheme: 'internet-facing',
        vpc_id: 'vpc-0a1b2c3d4e5f60718',
      },
      targets: { healthy: 2 },
    }),
    aws({
      type: 'aws_load_balancer',
      id: `arn:aws:elasticloadbalancing:${REGION}:${AWS_ACCOUNT}:loadbalancer/net/partner-sftp/1d4e7a0c3b6f9e82`,
      name: 'partner-sftp',
      state: 'active',
      ageDays: 160,
      attributes: {
        lb_type: 'network',
        lb_scheme: 'internet-facing',
        vpc_id: 'vpc-0a1b2c3d4e5f60718',
      },
      // One of the two SFTP targets fails its health check: still serving.
      targets: { healthy: 1, unhealthy: 1 },
    }),
    aws({
      type: 'aws_rds_instance',
      id: `arn:aws:rds:${REGION}:${AWS_ACCOUNT}:db:harborline-reporting`,
      name: 'harborline-reporting',
      state: 'available',
      health: 'healthy',
      ageDays: 288,
      attributes: {
        db_engine: 'postgres',
        db_engine_version: '16.4',
        instance_type: 'db.r6g.large',
      },
    }),
    aws({
      type: 'aws_rds_instance',
      id: `arn:aws:rds:${REGION}:${AWS_ACCOUNT}:db:legacy-orders-mysql`,
      name: 'legacy-orders-mysql',
      state: 'stopped',
      ageDays: 690,
      attributes: {
        db_engine: 'mysql',
        db_engine_version: '8.0.39',
        instance_type: 'db.t3.medium',
      },
    }),
    ...[
      ['harborline-assets-prod', REGION, 401],
      ['harborline-backups-eu', REGION, 380],
      ['harborline-logs-archive', REGION, 344],
      ['harborline-terraform-state', REGION, 405],
      ['harborline-dr-backups', 'us-east-1', 190],
      ['harborline-exports-tmp', REGION, NEW_BUCKET_HOURS_AGO / 24],
    ].map(([name, region, age]) =>
      aws({
        type: 'aws_s3_bucket',
        id: `arn:aws:s3:::${name}`,
        name: String(name),
        region: String(region),
        state: 'available',
        ageDays: Number(age),
        attributes: {},
      }),
    ),
    aws({
      type: 'aws_lambda_function',
      id: `arn:aws:lambda:${REGION}:${AWS_ACCOUNT}:function:image-resizer`,
      name: 'image-resizer',
      state: 'active',
      ageDays: 133,
      attributes: { runtime: 'nodejs20.x' },
    }),
    aws({
      type: 'aws_lambda_function',
      id: `arn:aws:lambda:${REGION}:${AWS_ACCOUNT}:function:order-webhook-relay`,
      name: 'order-webhook-relay',
      state: 'active',
      ageDays: 71,
      attributes: { runtime: 'python3.12' },
    }),
    // The analytics team's Azure subscription.
    azure({
      type: 'azure_aks_cluster',
      id: azureId('rg-analytics', 'microsoft.containerservice/managedclusters', 'analytics-aks'),
      name: 'analytics-aks',
      state: 'running',
      ageDays: 150,
      attributes: {
        azure_resource_group: 'rg-analytics',
        k8s_cluster_name: 'analytics-aks',
        k8s_version: '1.30.6',
      },
    }),
    azure({
      type: 'azure_vm_scale_set',
      id: azureId(
        'mc_rg-analytics_analytics-aks_westeurope',
        'microsoft.compute/virtualmachinescalesets',
        'aks-nodepool1-31415926-vmss',
      ),
      name: 'aks-nodepool1-31415926-vmss',
      state: 'succeeded',
      ageDays: 150,
      attributes: {
        azure_resource_group: 'mc_rg-analytics_analytics-aks_westeurope',
        instance_type: 'Standard_D4s_v5',
      },
    }),
    azure({
      type: 'azure_virtual_machine',
      id: azureId('rg-analytics', 'microsoft.compute/virtualmachines', 'analytics-jump-01'),
      name: 'analytics-jump-01',
      state: 'running',
      health: 'healthy',
      ageDays: 96,
      attributes: {
        azure_resource_group: 'rg-analytics',
        host_id: '5d8c3f1a-27b9-4e60-9a4d-c1e2f3a4b5c6',
        instance_type: 'Standard_B2s',
      },
    }),
    azure({
      type: 'azure_postgresql_server',
      id: azureId(
        'rg-analytics',
        'microsoft.dbforpostgresql/flexibleservers',
        'harborline-analytics-pg',
      ),
      name: 'harborline-analytics-pg',
      state: 'ready',
      health: 'healthy',
      ageDays: 150,
      attributes: { azure_resource_group: 'rg-analytics' },
    }),
    azure({
      type: 'azure_storage_account',
      id: azureId('rg-analytics', 'microsoft.storage/storageaccounts', 'harborlinelakeweu'),
      name: 'harborlinelakeweu',
      state: 'available',
      ageDays: 150,
      attributes: { azure_resource_group: 'rg-analytics' },
    }),
    azure({
      type: 'azure_application_gateway',
      id: azureId('rg-analytics', 'microsoft.network/applicationgateways', 'analytics-appgw'),
      name: 'analytics-appgw',
      state: 'running',
      health: 'degraded',
      ageDays: 120,
      attributes: { azure_resource_group: 'rg-analytics' },
    }),
  ];
}

/** Where a cloud resource's identity says it lives: cloud_* labels as the probe sends them. */
export function resourceLabels(resource: CloudResource, refreshSeconds: number) {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(resource.attributes)) if (value) labels[key] = value;
  Object.assign(labels, {
    cloud_connection_id: resource.connectionId,
    cloud_provider: resource.provider,
    cloud_account_id: resource.accountId,
    cloud_region: resource.region,
    cloud_resource_type: resource.type,
    cloud_resource_id: resource.id,
    cloud_resource_name: resource.name,
    cloud_resource_state: resource.state,
    cloud_refresh_seconds: String(refreshSeconds),
  });
  if (resource.health) labels.cloud_health = resource.health;
  return labels;
}
