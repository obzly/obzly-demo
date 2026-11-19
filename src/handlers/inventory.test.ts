import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloudConnection, CloudTest } from '../../entity/cloud';
import type {
  Asset,
  AssetChange,
  AssetDetail,
  AssetList,
  AssetSort,
  InventorySummary,
  SiteAsset,
} from '../../entity/inventory';
import { compareAssets } from '../../features/infrastructure/lib/paging';
import { cloudSeries } from '../gen/inventory';
import { Router } from '../router';
import { AWS_ACCOUNT, AZURE_REGION, AZURE_SUBSCRIPTION } from '../seed/inventory';
import { resetDemo } from '../store';
import {
  CLUSTER,
  NODES,
  PROJECT_ID,
  REGION,
  STAGING_PROJECT_ID,
  STAGING_PROJECT_NAME,
  WORKLOADS,
} from '../world';
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

describe('asset list (paging, sorting, tree)', () => {
  const SORTS: AssetSort[] = [
    'health',
    'kind',
    'name',
    'cpu',
    'memory',
    'restarts',
    'age',
    'lastSeen',
    'attention',
  ];
  const site = (a: Asset): SiteAsset => ({ ...a, siteId: '', siteName: '' });
  const ids = (assets: Asset[]) => assets.map((a) => a.id);

  it('pages the matches from offset; total counts them all', async () => {
    const all = await call<AssetList>('GET', '/inventory/assets?limit=5000');
    expect(all.assets.length).toBe(all.total);
    const first = await call<AssetList>('GET', '/inventory/assets?limit=25');
    const second = await call<AssetList>('GET', '/inventory/assets?offset=25&limit=25');
    expect(first.total).toBe(all.total);
    expect(second.total).toBe(all.total);
    expect(ids([...first.assets, ...second.assets])).toEqual(ids(all.assets.slice(0, 50)));
    const past = await call<AssetList>('GET', `/inventory/assets?offset=${all.total}`);
    expect(past).toEqual({ assets: [], total: all.total });
    // Bad limits fall back to 2000, a negative offset to 0.
    const fallback = await call<AssetList>('GET', '/inventory/assets?limit=-3&offset=-9');
    expect(fallback.assets.length).toBe(Math.min(all.total, 2000));
    expect(fallback.assets[0].id).toBe(all.assets[0].id);
  });

  it('sorts every column both ways in the order the UI merges Sites by', async () => {
    for (const sort of SORTS) {
      for (const order of ['asc', 'desc'] as const) {
        const { assets } = await call<AssetList>(
          'GET',
          `/inventory/assets?limit=5000&sort=${sort}&order=${order}`,
        );
        const expected = [...assets]
          .map(site)
          .sort(compareAssets(sort, order === 'asc' ? 'ascend' : 'descend'));
        expect(ids(assets), `${sort} ${order}`).toEqual(ids(expected));
      }
    }
    const byCpu = await call<AssetList>(
      'GET',
      '/inventory/assets?kind=pod,node&sort=cpu&order=desc',
    );
    const cpu = byCpu.assets.map((a) => a.metrics.cpuPercent ?? -1);
    expect(cpu).toEqual([...cpu].sort((a, b) => b - a));
    const newest = await call<AssetList>('GET', '/inventory/assets?sort=age&limit=1');
    const oldest = await call<AssetList>('GET', '/inventory/assets?sort=age&order=desc&limit=1');
    expect(newest.assets[0].firstSeen >= oldest.assets[0].firstSeen).toBe(true);
    // The default is worst health first, like sort=health.
    const plain = await call<AssetList>('GET', '/inventory/assets?limit=5000');
    const health = await call<AssetList>('GET', '/inventory/assets?limit=5000&sort=health');
    expect(ids(plain.assets)).toEqual(ids(health.assets));
  });

  it('rejects an unknown sort or order', async () => {
    await expect(call('GET', '/inventory/assets?sort=size')).rejects.toMatchObject({
      status: 400,
      message: 'invalid request: unknown sort "size"',
    });
    await expect(call('GET', '/inventory/assets?order=up')).rejects.toMatchObject({
      status: 400,
      message: 'order must be asc or desc',
    });
  });

  it('searches names, nodes, attribute values and project names, not attribute keys', async () => {
    const all = (await call<AssetList>('GET', '/inventory/assets?limit=5000')).assets;
    const staging = all.filter((a) => a.projectId === STAGING_PROJECT_ID);
    const byProject = await call<AssetList>(
      'GET',
      `/inventory/assets?limit=5000&q=${encodeURIComponent(STAGING_PROJECT_NAME.toUpperCase())}`,
    );
    expect(staging.length).toBeGreaterThan(0);
    expect(ids(byProject.assets)).toEqual(expect.arrayContaining(ids(staging)));
    const byValue = await call<AssetList>('GET', '/inventory/assets?limit=5000&q=aws_ec2_instance');
    expect(byValue.total).toBeGreaterThan(0);
    expect(
      byValue.assets.every((a) => a.attributes.cloud_resource_type === 'aws_ec2_instance'),
    ).toBe(true);
    const byKey = await call<AssetList>('GET', '/inventory/assets?q=cloud_resource_type');
    expect(byKey.total).toBe(0);
    const byNode = await call<AssetList>('GET', `/inventory/assets?kind=pod&q=${NODES[0]}`);
    expect(byNode.total).toBeGreaterThan(0);
    expect(byNode.assets.every((a) => a.node === NODES[0])).toBe(true);
  });

  it('reads the roots with child counts, then a branch by parent', async () => {
    const all = (await call<AssetList>('GET', '/inventory/assets?limit=5000')).assets;
    const present = new Set(all.map((a) => `${a.projectId}|${a.key}`));
    const roots = await call<AssetList>('GET', '/inventory/assets?roots=true&childCounts=true');
    expect(roots.total).toBeGreaterThan(0);
    expect(roots.total).toBeLessThan(all.length);
    for (const a of roots.assets) {
      expect(!a.parentKey || !present.has(`${a.projectId}|${a.parentKey}`)).toBe(true);
      const children = all.filter((c) => c.projectId === a.projectId && c.parentKey === a.key);
      expect(a.childCount).toBe(children.length);
    }
    const cluster = roots.assets.find((a) => a.kind === 'cluster' && a.name === CLUSTER)!;
    expect(cluster.childCount).toBeGreaterThan(0);
    const branch = await call<AssetList>(
      'GET',
      `/inventory/assets?projectId=${cluster.projectId}&parent=${encodeURIComponent(cluster.key)}&childCounts=true`,
    );
    expect(branch.total).toBe(cluster.childCount);
    expect(branch.assets.every((a) => a.parentKey === cluster.key)).toBe(true);
    expect(branch.assets.some((a) => (a.childCount ?? 0) > 0)).toBe(true);
    // Without childCounts there are none.
    const plain = await call<AssetList>('GET', '/inventory/assets?roots=true');
    expect(plain.assets.every((a) => a.childCount === undefined)).toBe(true);
  });

  it('adds the ancestors of the matches that are not among them', async () => {
    const list = await call<AssetList>(
      'GET',
      '/inventory/assets?kind=container&q=checkout&limit=3&ancestors=true',
    );
    expect(list.assets).toHaveLength(3);
    const ancestors = list.ancestors ?? [];
    const page = new Set(ids(list.assets));
    expect(ancestors.every((a) => !page.has(a.id))).toBe(true);
    expect(new Set(ids(ancestors)).size).toBe(ancestors.length);
    // Every match reaches the top through the ancestors.
    const byKey = new Map(ancestors.map((a) => [a.key, a]));
    for (const container of list.assets) {
      const chain: string[] = [];
      for (let key = container.parentKey; key; key = byKey.get(key)?.parentKey ?? '') {
        const parent = byKey.get(key);
        expect(parent, key).toBeDefined();
        chain.push(parent!.kind);
      }
      expect(chain).toEqual(['pod', 'workload', 'namespace', 'cluster']);
    }
    const without = await call<AssetList>('GET', '/inventory/assets?kind=container&limit=3');
    expect(without.ancestors).toBeUndefined();
    // Roots have none to add.
    const roots = await call<AssetList>('GET', '/inventory/assets?roots=true&ancestors=true');
    expect(roots.ancestors).toBeUndefined();
  });
});

describe('inventory summary and changes (v1.2.2 fields)', () => {
  it('counts live assets, regions and clusters', async () => {
    const summary = await call<InventorySummary>('GET', '/inventory/summary');
    const all = (await call<AssetList>('GET', '/inventory/assets?limit=5000')).assets;
    const live = all.filter((a) => a.state !== 'terminated');
    const total = (counts?: Partial<Record<string, number>>) =>
      Object.values(counts ?? {}).reduce<number>((sum, n) => sum + (n ?? 0), 0);
    expect(total(summary.live)).toBe(live.length);
    expect(summary.live?.critical ?? 0).toBe(live.filter((a) => a.health === 'critical').length);
    for (const project of summary.projects) {
      expect(total(project.live)).toBe(live.filter((a) => a.projectId === project.id).length);
    }

    const regions = summary.regions ?? [];
    const counted = live.filter(
      (a) => a.attributes.cloud_region && a.kind !== 'pod' && a.kind !== 'container',
    );
    expect(regions.reduce((sum, r) => sum + r.assets, 0)).toBe(counted.length);
    expect(regions[0]).toMatchObject({ provider: 'aws', region: REGION });
    expect(regions.find((r) => r.region === AZURE_REGION)).toMatchObject({
      provider: 'azure',
      projects: [STAGING_PROJECT_NAME],
    });
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i - 1].assets).toBeGreaterThanOrEqual(regions[i].assets);
    }
    for (const r of regions) {
      expect(r.warning + r.critical).toBeLessThanOrEqual(r.assets);
      expect(r.projects).toEqual([...r.projects].sort());
    }

    expect(summary.clusters).toEqual(expect.arrayContaining([CLUSTER, 'analytics-aks']));
    expect(summary.clusters).toEqual([...(summary.clusters ?? [])].sort());

    const staging = await call<InventorySummary>(
      'GET',
      `/inventory/summary?projectId=${STAGING_PROJECT_ID}`,
    );
    expect(staging.projects.map((p) => p.id)).toEqual([STAGING_PROJECT_ID]);
    expect(staging.regions?.every((r) => r.projects.join() === STAGING_PROJECT_NAME)).toBe(true);
  });

  it('gives a change its asset id while the asset is still listed', async () => {
    const all = (await call<AssetList>('GET', '/inventory/assets?limit=5000')).assets;
    const byKey = new Map(all.map((a) => [`${a.projectId}|${a.key}`, a.id]));
    const changes = await call<AssetChange[]>('GET', '/inventory/changes?hours=168&limit=500');
    expect(changes.some((c) => c.assetId)).toBe(true);
    for (const c of changes) {
      expect(c.assetId, c.assetName).toBe(byKey.get(`${c.projectId}|${c.assetKey}`));
    }
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
