import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloudConnection, CloudTest } from '../../entity/cloud';
import type { AssetChange, AssetDetail, AssetList, InventorySummary } from '../../entity/inventory';
import { cloudSeries } from '../gen/inventory';
import { Router } from '../router';
import { AWS_ACCOUNT, AZURE_SUBSCRIPTION } from '../seed/inventory';
import { resetDemo } from '../store';
import { CLUSTER, NODES, PROJECT_ID, STAGING_PROJECT_ID, WORKLOADS } from '../world';
import { register } from './inventory';

const router = new Router();
register(router);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(path, 'http://demo.test');
  const route = router.match(method, url.pathname);
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`);
  return (await route.handler({
    method,
    path: url.pathname,
    params: route.params,
    query: url.searchParams,
    body,
  })) as T;
}

afterEach(() => {
  vi.useRealTimers();
  resetDemo();
});

describe('inventory', () => {
  it('lists the cluster, its tree, the batch VM and cloud resources, worst first', async () => {
    const { assets, total } = await call<AssetList>('GET', '/inventory/assets?limit=5000');
    expect(total).toBe(assets.length);
    const byKind = (kind: string) => assets.filter((a) => a.kind === kind);
    expect(byKind('cluster').map((a) => a.name)).toEqual(
      expect.arrayContaining([CLUSTER, 'analytics-aks']),
    );
    expect(
      byKind('node')
        .map((a) => a.name)
        .sort(),
    ).toEqual([...NODES].sort());
    // Pods a rollout replaced in the last half hour are still listed, not reporting.
    const live = byKind('pod').filter((a) => a.state === 'active' || a.state === 'new');
    const replicas = WORKLOADS.reduce((sum, w) => sum + w.replicas, 0) + 6;
    expect(live.length).toBeGreaterThanOrEqual(replicas);
    expect(live.length).toBeLessThanOrEqual(replicas + 3);
    expect(byKind('bucket').length).toBeGreaterThanOrEqual(6);
    expect(byKind('database').length).toBeGreaterThanOrEqual(3);
    const rank = { critical: 0, warning: 1, healthy: 2, unknown: 3, inactive: 4 };
    for (let i = 1; i < assets.length; i++) {
      expect(rank[assets[i - 1].health]).toBeLessThanOrEqual(rank[assets[i].health]);
    }
    const ids = new Set(assets.map((a) => a.id));
    expect(ids.size).toBe(assets.length);
  });

  it('is healthy but not perfect', async () => {
    const { assets } = await call<AssetList>('GET', '/inventory/assets?limit=5000');
    const find = (name: string) => assets.find((a) => a.name === name)!;
    expect(find('legacy-orders-mysql')).toMatchObject({ health: 'inactive' });
    expect(find('partner-sftp').reasons[0].text).toBe('1 of 2 targets unhealthy');
    expect(find('batch-01.harborline.example.com').reasons[0].text).toMatch(/^Filesystem at 8\d%/);
    expect(find('analytics-appgw').health).toBe('warning');
    expect(find(NODES[3]).state).toBe('new');
    const node = find(NODES[0]);
    expect(node.sources).toEqual(['metrics', 'cloud']);
    expect(node.attributes.cloud_resource_type).toBe('aws_ec2_instance');
    const current = assets.filter((a) => a.state !== 'terminated');
    const healthy = current.filter((a) => a.health === 'healthy').length;
    expect(healthy / current.length).toBeGreaterThan(0.75);
  });

  it('summarizes by kind, health, state and project', async () => {
    const summary = await call<InventorySummary>('GET', '/inventory/summary');
    const { total } = await call<AssetList>('GET', '/inventory/assets?limit=5000');
    expect(summary.total).toBe(total);
    expect(summary.projects.map((p) => p.id).sort()).toEqual(
      [PROJECT_ID, STAGING_PROJECT_ID].sort(),
    );
    expect(summary.kinds.node?.healthy).toBe(NODES.length);
  });

  it('answers an asset with its parents, node, children and changes', async () => {
    const { assets } = await call<AssetList>('GET', '/inventory/assets?kind=pod&limit=5000');
    const pod = assets.find((a) => a.name.startsWith('checkout-') && a.state !== 'terminated')!;
    const detail = await call<AssetDetail>('GET', `/inventory/assets/${pod.id}`);
    expect(detail.parents.map((p) => p.kind)).toEqual(['cluster', 'namespace', 'workload']);
    expect(detail.node?.kind).toBe('node');
    expect(detail.children.map((c) => c.kind)).toEqual(['container']);
    const workload = await call<AssetDetail>('GET', `/inventory/assets/${detail.parents[2].id}`);
    expect(workload.children.filter((c) => c.kind === 'pod').length).toBeGreaterThanOrEqual(3);
    expect(workload.changes.length).toBeGreaterThan(0);
    await expect(call('GET', '/inventory/assets/nope')).rejects.toMatchObject({ status: 404 });
  });

  it('feeds deploys, the incident, the node replacement and cloud events', async () => {
    const changes = await call<AssetChange[]>('GET', '/inventory/changes?hours=24&limit=200');
    expect(changes.length).toBeGreaterThan(20);
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i - 1].at >= changes[i].at).toBe(true);
    }
    const all = await call<AssetChange[]>('GET', '/inventory/changes?hours=24&limit=500');
    expect(all.some((c) => c.kind === 'node' && c.change === 'new')).toBe(true);
    expect(all.some((c) => c.kind === 'workload' && c.to === 'warning')).toBe(true);
    expect(all.some((c) => c.kind === 'pod' && c.change === 'new')).toBe(true);
    expect(all.some((c) => c.assetName === 'harborline-exports-tmp')).toBe(true);
  });

  it('reports cloud_resource_info for the projects connections send to', () => {
    const now = Date.now();
    const series = cloudSeries(PROJECT_ID, 'cloud_resource_info', [], now - 3_600_000, now);
    expect(series.some((s) => s.labels.cloud_resource_type === 'aws_s3_bucket')).toBe(true);
    expect(series.every((s) => s.labels.cloud_account_id === AWS_ACCOUNT)).toBe(true);
    const targets = cloudSeries(PROJECT_ID, 'cloud_lb_targets', [], now - 3_600_000, now);
    expect(targets.some((s) => s.labels.health === 'unhealthy')).toBe(true);
    const azure = cloudSeries(STAGING_PROJECT_ID, 'cloud_resource_info', [], now - 3_600_000, now);
    expect(azure.every((s) => s.labels.cloud_account_id === AZURE_SUBSCRIPTION)).toBe(true);
  });
});

describe('cloud connections', () => {
  it('lists the seeded connections with their scans', async () => {
    const list = await call<CloudConnection[]>('GET', '/cloud-connections');
    expect(list).toHaveLength(2);
    const aws = list.find((c) => c.provider === 'aws')!;
    expect(aws.status.scan?.resources).toBeGreaterThan(10);
    expect(aws.status.scan?.uses.inventory.state).toBe('ok');
    expect(aws.probe.name).toBe('aws-eu-west-1');
    expect(aws.externalId).toMatch(/^obz-/);
    const azure = list.find((c) => c.provider === 'azure')!;
    expect(azure.status.health?.uses.inventory.state).toBe('needs_permission');
    const setup = await call<{ externalId: string }>('GET', '/cloud-connections/setup');
    expect(setup.externalId).toMatch(/^obz-/);
  });

  it('validates, tests (answering after a moment) and saves a new connection', async () => {
    const [aws] = await call<CloudConnection[]>('GET', '/cloud-connections');
    const request = {
      name: 'Harborline sandbox (AWS)',
      provider: 'aws',
      scope: 'account',
      scopeId: '210987654321',
      access: 'role',
      identity: 'arn:aws:iam::210987654321:role/obzly-readonly',
      externalId: 'obz-abc',
      tenantId: '',
      probeId: aws.probe.id,
      destinationId: aws.destination.id,
      scanTypes: ['inventory'],
      regions: ['eu-west-1'],
      resourceTypes: [],
      intervalSeconds: 14_400,
      healthIntervalSeconds: 900,
    };
    await expect(
      call('POST', '/cloud-connections/test', { ...request, scopeId: '12345' }),
    ).rejects.toMatchObject({ status: 400 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
    const test = await call<CloudTest>('POST', '/cloud-connections/test', request);
    expect(test.status).toBe('queued');
    vi.setSystemTime(new Date('2026-11-07T10:00:03Z'));
    const done = await call<CloudTest>('GET', `/cloud-connections/tests/${test.id}`);
    expect(done.status).toBe('done');
    expect(done.result?.uses.inventory.state).toBe('ok');
    expect(done.result?.regions).toEqual(['eu-west-1']);
    vi.useRealTimers();
    const created = await call<CloudConnection>('POST', '/cloud-connections', request);
    expect(created.externalId).toMatch(/^obz-.{20,}/);
    expect(created.status).toEqual({});
    const updated = await call<CloudConnection>('PUT', `/cloud-connections/${created.id}`, {
      ...request,
      enabled: false,
      version: created.version,
    });
    expect(updated).toMatchObject({ enabled: false, version: 2 });
    await call('DELETE', `/cloud-connections/${created.id}`);
    expect(await call<CloudConnection[]>('GET', '/cloud-connections')).toHaveLength(2);
  });
});
