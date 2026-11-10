// Security posture for the two seeded connections: Security Hub findings for Harborline's AWS
// account in eu-west-1, Obzly's baseline checks in us-east-1 (Security Hub isn't on there) and
// in the analytics Azure subscription (Defender for Cloud has no assessments yet). Resources are
// the inventory's; control IDs and fix steps are the real ones, the findings are made up.
import type { Finding, Remediation, RunResult, Severity, StandardRef } from '../../entity/posture';
import { uuidFrom } from '../lib/rng';
import { NODES, PROJECT_ID, REGION, STAGING_PROJECT_ID } from '../world';
import { AWS_CONNECTION_NAME, AZURE_CONNECTION_NAME, DAY } from './cost';
import {
  AWS_ACCOUNT,
  AWS_CONNECTION_ID,
  AZURE_CONNECTION_ID,
  AZURE_SUBSCRIPTION,
  NEW_BUCKET_HOURS_AGO,
  cloudResources,
  instanceId,
} from './inventory';

export const STANDARD_NAMES: Record<string, string> = {
  'aws-fsbp': 'AWS Foundational Security Best Practices',
  'cis-aws': 'CIS AWS Foundations Benchmark',
  mcsb: 'Microsoft cloud security benchmark',
  'cis-azure': 'CIS Microsoft Azure Foundations Benchmark',
  'obzly-baseline': 'Obzly baseline',
};

export interface SeedFinding {
  id: string;
  projectId: string;
  connectionId: string;
  connectionName: string;
  provider: 'aws' | 'azure';
  account: string;
  region: string;
  source: 'native' | 'baseline';
  control: string;
  check?: string;
  title: string;
  severity: Severity;
  resourceKey: string;
  resourceType?: string;
  standards: StandardRef[];
  evidence: Record<string, string>;
  remediationUrl?: string;
  remediation?: Remediation;
  /** Hours ago it opened, and resolved (when it did). */
  openedHoursAgo: number;
  resolvedHoursAgo?: number;
  /** Seeded suppression: who, why, and days until it ends. */
  suppressed?: {
    by: string;
    reason: string;
    forDays: number;
    hoursAgo: number;
  };
}

export interface SeedRun {
  projectId: string;
  connectionId: string;
  connectionName: string;
  provider: 'aws' | 'azure';
  account: string;
  region: string;
  standard: string;
  source: 'native' | 'baseline';
  result: RunResult;
  reason?: string;
  passed: string[];
  failed: string[];
  /** Hours ago the scope was last read. */
  scannedHoursAgo: number;
}

const ARN_EC2 = (id: string, region = REGION) => `arn:aws:ec2:${region}:${AWS_ACCOUNT}:${id}`;
const resource = (name: string) => cloudResources().find((r) => r.name === name)?.id ?? name;
const ref = (standard: string, control: string): StandardRef => ({
  standard,
  control,
});
const hubUrl = (control: string) =>
  `https://docs.aws.amazon.com/console/securityhub/${control}/remediation`;

const aws = (
  partial: Omit<
    SeedFinding,
    'projectId' | 'connectionId' | 'connectionName' | 'provider' | 'account'
  >,
) =>
  ({
    projectId: PROJECT_ID,
    connectionId: AWS_CONNECTION_ID,
    connectionName: AWS_CONNECTION_NAME,
    provider: 'aws',
    account: AWS_ACCOUNT,
    ...partial,
  }) as SeedFinding;

const azure = (
  partial: Omit<
    SeedFinding,
    'projectId' | 'connectionId' | 'connectionName' | 'provider' | 'account' | 'region' | 'source'
  >,
) =>
  ({
    projectId: STAGING_PROJECT_ID,
    connectionId: AZURE_CONNECTION_ID,
    connectionName: AZURE_CONNECTION_NAME,
    provider: 'azure',
    account: AZURE_SUBSCRIPTION,
    region: 'global',
    source: 'baseline',
    ...partial,
  }) as SeedFinding;

const lake = cloudResources().find((r) => r.name === 'harborlinelakeweu')?.id ?? '';
const jumpNsg = `/subscriptions/${AZURE_SUBSCRIPTION}/resourcegroups/rg-analytics/providers/microsoft.network/networksecuritygroups/analytics-jump-nsg`;

let cached: SeedFinding[] | undefined;
export function findingSeed(): SeedFinding[] {
  return (cached ??= [
    aws({
      id: uuidFrom('finding:s3.8:exports-tmp'),
      region: REGION,
      source: 'native',
      control: 'S3.8',
      title: 'S3 general purpose buckets should block public access',
      severity: 'high',
      resourceKey: resource('harborline-exports-tmp'),
      resourceType: 'AwsS3Bucket',
      standards: [ref('aws-fsbp', 'S3.8'), ref('cis-aws', '2.1.4')],
      evidence: { status_reason: 'Block Public Access is off for the bucket' },
      remediationUrl: hubUrl('S3.8'),
      openedHoursAgo: NEW_BUCKET_HOURS_AGO - 1,
    }),
    aws({
      id: uuidFrom('finding:s3.9:exports-tmp'),
      region: REGION,
      source: 'native',
      control: 'S3.9',
      title: 'S3 general purpose buckets should have server access logging enabled',
      severity: 'medium',
      resourceKey: resource('harborline-exports-tmp'),
      resourceType: 'AwsS3Bucket',
      standards: [ref('aws-fsbp', 'S3.9')],
      evidence: { status_reason: 'Server access logging is off' },
      remediationUrl: hubUrl('S3.9'),
      openedHoursAgo: NEW_BUCKET_HOURS_AGO - 1,
    }),
    aws({
      id: uuidFrom('finding:iam.4:root'),
      region: REGION,
      source: 'native',
      control: 'IAM.4',
      title: 'IAM root user access key should not exist',
      severity: 'critical',
      resourceKey: `AWS::::Account:${AWS_ACCOUNT}`,
      resourceType: 'AwsAccount',
      standards: [ref('aws-fsbp', 'IAM.4'), ref('cis-aws', '1.4')],
      evidence: {
        status_reason: 'The root user has an active access key, last used 212 days ago',
      },
      remediationUrl: hubUrl('IAM.4'),
      openedHoursAgo: 26 * 24,
    }),
    ...NODES.slice(0, 2).map((node, i) =>
      aws({
        id: uuidFrom(`finding:ec2.8:${node}`),
        region: REGION,
        source: 'native',
        control: 'EC2.8',
        title: 'EC2 instances should use Instance Metadata Service Version 2 (IMDSv2)',
        severity: 'high',
        resourceKey: ARN_EC2(`instance/${instanceId(node)}`),
        resourceType: 'AwsEc2Instance',
        standards: [ref('aws-fsbp', 'EC2.8'), ref('cis-aws', '5.6')],
        evidence: { status_reason: 'HttpTokens is optional' },
        remediationUrl: hubUrl('EC2.8'),
        openedHoursAgo: (19 - i) * 24,
      }),
    ),
    aws({
      id: uuidFrom('finding:ec2.13:partner-sftp'),
      region: REGION,
      source: 'native',
      control: 'EC2.13',
      title: 'Security groups should not allow ingress from 0.0.0.0/0 or ::/0 to port 22',
      severity: 'high',
      resourceKey: ARN_EC2('security-group/sg-0d2c4e6a8b1f30927'),
      resourceType: 'AwsEc2SecurityGroup',
      standards: [ref('aws-fsbp', 'EC2.13'), ref('cis-aws', '5.2')],
      evidence: {
        status_reason: 'Rule allows 0.0.0.0/0 on TCP 22 (partner-sftp-admin)',
      },
      remediationUrl: hubUrl('EC2.13'),
      openedHoursAgo: 61 * 24,
    }),
    aws({
      id: uuidFrom('finding:rds.3:legacy-orders'),
      region: REGION,
      source: 'native',
      control: 'RDS.3',
      title: 'RDS DB instances should have encryption at-rest enabled',
      severity: 'medium',
      resourceKey: resource('legacy-orders-mysql'),
      resourceType: 'AwsRdsDbInstance',
      standards: [ref('aws-fsbp', 'RDS.3'), ref('cis-aws', '2.3.1')],
      evidence: { status_reason: 'StorageEncrypted is false' },
      remediationUrl: hubUrl('RDS.3'),
      openedHoursAgo: 120 * 24,
    }),
    aws({
      id: uuidFrom('finding:cloudtrail.1'),
      region: REGION,
      source: 'native',
      control: 'CloudTrail.1',
      title: 'CloudTrail should be enabled and configured with at least one multi-Region trail',
      severity: 'high',
      resourceKey: `AWS::::Account:${AWS_ACCOUNT}`,
      resourceType: 'AwsAccount',
      standards: [ref('aws-fsbp', 'CloudTrail.1'), ref('cis-aws', '3.1')],
      evidence: {
        status_reason: 'No multi-Region trail logs management events',
      },
      remediationUrl: hubUrl('CloudTrail.1'),
      openedHoursAgo: 40 * 24,
      resolvedHoursAgo: 11 * 24,
    }),
    aws({
      id: uuidFrom('finding:ec2.7:us-east-1'),
      region: 'us-east-1',
      source: 'baseline',
      control: 'EC2.7',
      check: 'aws-ebs-default-encryption',
      title: 'EBS encryption by default should be on in every region',
      severity: 'medium',
      resourceKey: ARN_EC2('ebs-default-encryption', 'us-east-1'),
      resourceType: 'aws_ebs_settings',
      standards: [ref('aws-fsbp', 'EC2.7'), ref('cis-aws', '2.2.1')],
      evidence: { default_encryption: 'false', name: 'us-east-1' },
      remediation: {
        cli: 'aws ec2 enable-ebs-encryption-by-default --region {region}',
        iac: '# Not a CloudFormation resource: run the CLI command once per region, or use an\n# AWS Config remediation for ec2-ebs-encryption-by-default.',
        console:
          'EC2 → Settings (Data protection and security) → EBS encryption → Manage → Always encrypt new EBS volumes.',
      },
      openedHoursAgo: 33 * 24,
    }),
    azure({
      id: uuidFrom('finding:azure:no-public-blob:lake'),
      control: 'azure-storage-no-public-blob',
      check: 'azure-storage-no-public-blob',
      title: 'Storage accounts should disallow anonymous blob access',
      severity: 'high',
      resourceKey: lake,
      resourceType: 'azure_storage_account',
      standards: [ref('cis-azure', '3.7')],
      evidence: {
        allow_blob_public_access: 'true',
        name: 'harborlinelakeweu',
        resourceGroup: 'rg-analytics',
      },
      remediation: {
        cli: 'az storage account update --name {name} --resource-group {resourceGroup} --allow-blob-public-access false',
        iac: '// Bicep, on the Microsoft.Storage/storageAccounts resource\nproperties: { allowBlobPublicAccess: false }',
        console:
          'Storage account → Settings → Configuration → Allow Blob anonymous access → Disabled.',
      },
      openedHoursAgo: 14 * 24,
    }),
    azure({
      id: uuidFrom('finding:azure:nsg-ssh:jump'),
      control: 'azure-nsg-no-world-ssh',
      check: 'azure-nsg-no-world-ssh',
      title: 'Network security groups should not allow SSH (22) from the internet',
      severity: 'high',
      resourceKey: jumpNsg,
      resourceType: 'azure_network_security_group',
      standards: [ref('mcsb', 'NS-1'), ref('cis-azure', '6.2')],
      evidence: {
        world_ports: '[22]',
        world_all_traffic: 'false',
        name: 'analytics-jump-nsg',
        resourceGroup: 'rg-analytics',
      },
      remediation: {
        cli: 'az network nsg rule list --resource-group {resourceGroup} --nsg-name {name} --output table\naz network nsg rule update --resource-group {resourceGroup} --nsg-name {name} --name <rule> \\\n  --source-address-prefixes <your admin network>',
        iac: "// Bicep: narrow the rule's source, or remove it and use Azure Bastion\nsourceAddressPrefix: '10.0.0.0/8'",
        console:
          'Network security group → Inbound security rules → the rule allowing 22 from Any or Internet → narrow the source or delete it. Prefer Azure Bastion.',
      },
      openedHoursAgo: 17 * 24,
    }),
    azure({
      id: uuidFrom('finding:azure:min-tls:lake'),
      control: 'azure-storage-min-tls',
      check: 'azure-storage-min-tls',
      title: 'Storage accounts should require TLS 1.2 or later',
      severity: 'medium',
      resourceKey: lake,
      resourceType: 'azure_storage_account',
      standards: [ref('mcsb', 'DP-3'), ref('cis-azure', '3.15')],
      evidence: {
        min_tls: 'TLS1_0',
        name: 'harborlinelakeweu',
        resourceGroup: 'rg-analytics',
      },
      remediation: {
        cli: 'az storage account update --name {name} --resource-group {resourceGroup} --min-tls-version TLS1_2',
        iac: "// Bicep, on the Microsoft.Storage/storageAccounts resource\nproperties: { minimumTlsVersion: 'TLS1_2' }",
        console: 'Storage account → Settings → Configuration → Minimum TLS version → Version 1.2.',
      },
      openedHoursAgo: 17 * 24,
      suppressed: {
        by: 'priya.natarajan@harborline.example.com',
        reason:
          'The on-premises reporting gateway still needs TLS 1.0; it is replaced in the next quarter (DATA-412)',
        forDays: 45,
        hoursAgo: 15 * 24,
      },
    }),
  ]);
}

const awsRun = (
  partial: Partial<SeedRun> & Pick<SeedRun, 'region' | 'standard' | 'source' | 'result'>,
): SeedRun => ({
  projectId: PROJECT_ID,
  connectionId: AWS_CONNECTION_ID,
  connectionName: AWS_CONNECTION_NAME,
  provider: 'aws',
  account: AWS_ACCOUNT,
  passed: [],
  failed: [],
  scannedHoursAgo: 3,
  ...partial,
});

const azureRun = (
  partial: Partial<SeedRun> & Pick<SeedRun, 'standard' | 'source' | 'result'>,
): SeedRun => ({
  projectId: STAGING_PROJECT_ID,
  connectionId: AZURE_CONNECTION_ID,
  connectionName: AZURE_CONNECTION_NAME,
  provider: 'azure',
  account: AZURE_SUBSCRIPTION,
  region: 'global',
  passed: [],
  failed: [],
  scannedHoursAgo: 5,
  ...partial,
});

/** Each scope's latest read, per standard and source. */
export function runSeed(): SeedRun[] {
  return [
    awsRun({
      region: REGION,
      standard: 'aws-fsbp',
      source: 'native',
      result: 'ok',
      passed: [
        'S3.1',
        'S3.5',
        'IAM.9',
        'IAM.15',
        'CloudTrail.1',
        'RDS.2',
        'EC2.2',
        'EC2.14',
        'KMS.4',
        'Lambda.1',
        'ELB.4',
        'EKS.2',
      ],
      failed: ['S3.8', 'S3.9', 'IAM.4', 'EC2.8', 'EC2.13', 'RDS.3'],
    }),
    awsRun({
      region: REGION,
      standard: 'cis-aws',
      source: 'native',
      result: 'ok',
      passed: ['1.5', '1.8', '1.9', '2.1.1', '2.3.3', '3.1', '3.2', '5.3'],
      failed: ['1.4', '2.1.4', '2.3.1', '5.2', '5.6'],
    }),
    awsRun({
      region: 'us-east-1',
      standard: 'aws-fsbp',
      source: 'native',
      result: 'not_enabled',
      reason: 'Security Hub not enabled in us-east-1',
    }),
    awsRun({
      region: 'us-east-1',
      standard: 'aws-fsbp',
      source: 'baseline',
      result: 'ok',
      passed: ['S3.8', 'EC2.13', 'EC2.14', 'EC2.8'],
      failed: ['EC2.7'],
    }),
    awsRun({
      region: 'us-east-1',
      standard: 'cis-aws',
      source: 'baseline',
      result: 'ok',
      passed: ['2.1.4', '5.2', '5.6'],
      failed: ['2.2.1'],
    }),
    azureRun({
      standard: 'mcsb',
      source: 'native',
      result: 'not_enabled',
      reason: 'Defender for Cloud has no assessments for this subscription',
    }),
    azureRun({
      standard: 'cis-azure',
      source: 'baseline',
      result: 'ok',
      passed: ['3.1', '6.3', '8.5', '4.1.1'],
      failed: ['3.7', '3.15', '6.2'],
    }),
    azureRun({
      standard: 'mcsb',
      source: 'baseline',
      result: 'ok',
      passed: ['DP-8', 'NS-2'],
      failed: ['NS-1', 'DP-3'],
    }),
  ];
}

export const hoursAgo = (hours: number, now = Date.now()) =>
  new Date(now - hours * 3_600_000).toISOString();

/** A seeded finding as the API shows it before anyone changes it. */
export function findingOf(seed: SeedFinding, now = Date.now()): Finding {
  const resolved = seed.resolvedHoursAgo !== undefined;
  return {
    id: seed.id,
    projectId: seed.projectId,
    connectionId: seed.connectionId,
    connectionName: seed.connectionName,
    provider: seed.provider,
    account: seed.account,
    region: seed.region,
    source: seed.source,
    control: seed.control,
    check: seed.check,
    title: seed.title,
    severity: seed.severity,
    resourceKey: seed.resourceKey,
    resourceType: seed.resourceType,
    standards: seed.standards,
    evidence: seed.evidence,
    remediationUrl: seed.remediationUrl,
    status: resolved ? 'resolved' : 'open',
    firstSeen: hoursAgo(seed.openedHoursAgo, now),
    lastSeen: hoursAgo(resolved ? seed.resolvedHoursAgo! + 12 : 3, now),
    resolvedAt: resolved ? hoursAgo(seed.resolvedHoursAgo!, now) : undefined,
    suppressed: !!seed.suppressed,
    suppressReason: seed.suppressed?.reason,
    suppressedUntil: seed.suppressed
      ? new Date(
          now - seed.suppressed.hoursAgo * 3_600_000 + seed.suppressed.forDays * DAY,
        ).toISOString()
      : undefined,
    suppressedBy: seed.suppressed?.by,
  };
}
