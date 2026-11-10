// Infrastructure: the inventory (assets, summary, change feed, asset detail)
// and cloud connections (list, setup, create, edit, delete, Test access).
// Assets come from ../gen/inventory; nothing ever calls a real cloud.
import type {
  CloudConnection,
  CloudConnectionRequest,
  CloudCostSettings,
  CloudScan,
  CloudSetup,
  CloudTest,
  CostSettings,
  PostureSettings,
  UseResult,
} from '../../entity/cloud';
import type { Asset, AssetDetail } from '../../entity/inventory';
import {
  changesBetween,
  inventoryAssets,
  lastHealthScan,
  refOf,
  sortAssets,
  summarize,
} from '../gen/inventory';
import { hashString, hex, int, mix, rng } from '../lib/rng';
import { DemoError, type DemoRequest, type Router } from '../router';
import {
  AWS_ACCOUNT,
  AZURE_SUBSCRIPTION,
  type CloudResource,
  type StoredConnection,
  cloudConnections,
  cloudResources,
} from '../seed/inventory';
import { destinations, probes } from '../seed/synthetics';
import { newId, value } from '../store';
import { DEMO_USER_ID, REGION } from '../world';
import { probeView } from './synthetics';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const bad = (message: string): never => {
  throw new DemoError(400, message);
};
const notFound = (what: string): never => {
  throw new DemoError(404, `${what} not found`);
};
const nowIso = () => new Date().toISOString();
const list = (value: string | null) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

// --- inventory ----------------------------------------------------------------------

function filtered(req: DemoRequest): Asset[] {
  const q = req.query;
  const projectId = q.get('projectId') ?? '';
  const kinds = list(q.get('kind'));
  const health = list(q.get('health'));
  const states = list(q.get('state'));
  const cluster = q.get('cluster') ?? '';
  const namespace = q.get('namespace') ?? '';
  const search = (q.get('q') ?? '').trim().toLowerCase();
  return inventoryAssets().filter(
    (a) =>
      (!projectId || a.projectId === projectId) &&
      (!kinds.length || kinds.includes(a.kind)) &&
      (!health.length || health.includes(a.health)) &&
      (!states.length || states.includes(a.state)) &&
      (!cluster || a.cluster === cluster) &&
      (!namespace || a.namespace === namespace) &&
      (!search ||
        a.name.toLowerCase().includes(search) ||
        a.node.toLowerCase().includes(search) ||
        JSON.stringify(a.attributes).toLowerCase().includes(search)),
  );
}

const clamp = (value: string | null, fallback: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

function assetDetail(id: string): AssetDetail {
  const all = inventoryAssets();
  const asset = all.find((a) => a.id === id) ?? notFound('Asset');
  const inProject = all.filter((a) => a.projectId === asset.projectId);
  const byKey = new Map(inProject.map((a) => [a.key, a]));
  const parents = [];
  for (let key = asset.parentKey, depth = 0; key && depth < 10; depth++) {
    const parent = byKey.get(key);
    if (!parent) break;
    parents.unshift(refOf(parent));
    key = parent.parentKey;
  }
  const node = asset.nodeKey ? byKey.get(asset.nodeKey) : undefined;
  const rank: Record<string, number> = { critical: 0, warning: 1 };
  const children = inProject
    .filter((a) => a.parentKey === asset.key || a.nodeKey === asset.key)
    .sort((a, b) => (rank[a.health] ?? 2) - (rank[b.health] ?? 2) || a.name.localeCompare(b.name))
    .slice(0, 500);
  const now = Date.now();
  const changes = changesBetween(now - 7 * DAY, now, now)
    .filter((c) => c.assetKey === asset.key && c.projectId === asset.projectId)
    .slice(0, 50);
  return { asset, parents, node: node && refOf(node), children, changes };
}

// --- cloud connections --------------------------------------------------------------

const AWS_TYPES = [
  'ec2_instance',
  'load_balancer',
  'eks_cluster',
  'rds_instance',
  'autoscaling_group',
  'lambda_function',
  's3_bucket',
];
const AZURE_TYPES = [
  'virtual_machine',
  'vm_scale_set',
  'load_balancer',
  'application_gateway',
  'aks_cluster',
  'sql_database',
  'postgresql_server',
  'storage_account',
  'function_app',
];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^arn:aws(-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

const newExternalId = () =>
  `obz-${hex(mix(hashString(newId()), Date.now()), 32)}-${hex(Date.now(), 16)}`;

/** Validates a request like the control plane's cloudConnectionFrom. */
function connectionFrom(
  request: CloudConnectionRequest,
  existing?: StoredConnection,
): StoredConnection {
  const name = (request.name ?? '').trim();
  if (!name || name.length > 100) bad('name must be 1 to 100 characters');
  const clash = cloudConnections
    .all()
    .find((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== existing?.id);
  if (clash) bad(`a cloud connection named "${name}" already exists`);
  const interval = request.intervalSeconds || 14_400;
  const health = request.healthIntervalSeconds || Math.min(900, interval);
  if (interval < 1800 || interval > 86_400) bad('the discovery interval must be 30 min to 24 h');
  if (health < 300 || health > 3600) bad('the health scan interval must be 5 min to 1 h');
  if (health > interval) bad("health scans can't be less frequent than discovery");
  const scanTypes = [...new Set(request.scanTypes ?? [])];
  if (!scanTypes.length) bad('pick at least one scan type');
  const unknown = scanTypes.find((use) => !['inventory', 'cost', 'posture'].includes(use));
  if (unknown) bad(`unknown use "${unknown}"`);
  const cost = scanTypes.includes('cost') ? costFrom(request.cost) : undefined;
  const posture = scanTypes.includes('posture') ? postureFrom(request.posture) : undefined;
  const scopeId = (request.scopeId ?? '').trim();
  let identity = (request.identity ?? '').trim();
  let tenantId = (request.tenantId ?? '').trim().toLowerCase();
  let externalId = '';
  if (request.provider === 'aws') {
    if (request.scope === 'account') {
      if (!/^\d{12}$/.test(scopeId)) bad('an AWS account ID is 12 digits');
    } else if (request.scope === 'organization') {
      if (!/^o-[a-z0-9]{10,32}$/.test(scopeId))
        bad('an AWS Organization ID looks like o-a1b2c3d4e5');
      if (request.access === 'probe') {
        bad('a whole Organization needs a role in each account: pick a role or federated access');
      }
    } else bad('scope must be account or organization');
    tenantId = '';
    if (request.access === 'probe') identity = '';
    else if (request.access === 'role' || request.access === 'federated') {
      if (!ROLE.test(identity)) {
        bad('the role ARN looks like arn:aws:iam::123456789012:role/obzly-readonly');
      }
      if (request.access === 'role') {
        const requested = (request.externalId ?? '').trim();
        externalId =
          existing?.externalId ||
          (/^obz-[0-9a-f]{32}-[0-9a-f]{16}$/.test(requested) ? requested : newExternalId());
      }
    } else bad('access for AWS must be probe, role or federated');
  } else if (request.provider === 'azure') {
    if (request.scope === 'subscription') {
      if (!GUID.test(scopeId)) bad('an Azure subscription ID is a GUID');
    } else if (request.scope === 'management_group') {
      if (!/^[A-Za-z0-9_().-]{1,90}$/.test(scopeId)) {
        bad('a management group ID is up to 90 letters, digits or _().-');
      }
    } else bad('scope must be subscription or management_group');
    if (!GUID.test(tenantId)) bad('the Microsoft Entra tenant ID is a GUID');
    if (request.access === 'probe') {
      if (identity && !GUID.test(identity)) bad("the managed identity's client ID is a GUID");
    } else if (request.access === 'workload' || request.access === 'federated') {
      if (!GUID.test(identity)) bad("the identity's client ID is a GUID");
    } else bad('access for Azure must be probe, workload or federated');
    identity = identity.toLowerCase();
  } else bad('provider must be aws or azure');
  const regionPattern =
    request.provider === 'aws' ? /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/ : /^[a-z][a-z0-9]{1,39}$/;
  const regions = [
    ...new Set((request.regions ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean)),
  ];
  const wrongRegion = regions.find((region) => !regionPattern.test(region));
  if (wrongRegion) bad(`"${wrongRegion}" isn't a region name`);
  const allowed = request.provider === 'aws' ? AWS_TYPES : AZURE_TYPES;
  const resourceTypes = [...new Set(request.resourceTypes ?? [])];
  const wrongType = resourceTypes.find((type) => !allowed.includes(type));
  if (wrongType) bad(`unknown ${request.provider} resource type "${wrongType}"`);
  if (!probes.get(request.probeId)) bad('pick the probe group that runs the scans');
  if (!destinations.get(request.destinationId)) bad('pick where results go (a destination)');
  const now = nowIso();
  return {
    id: existing?.id ?? newId(),
    name,
    provider: request.provider,
    scope: request.scope,
    scopeId:
      request.provider === 'azure' && request.scope === 'subscription'
        ? scopeId.toLowerCase()
        : scopeId,
    access: request.access,
    identity,
    externalId,
    tenantId,
    probeId: request.probeId,
    destinationId: request.destinationId,
    scanTypes,
    regions,
    resourceTypes,
    intervalSeconds: interval,
    healthIntervalSeconds: health,
    cost,
    posture,
    enabled: request.enabled ?? true,
    version: existing ? existing.version + 1 : 1,
    createdBy: existing?.createdBy ?? DEMO_USER_ID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    seeded: existing?.seeded,
  };
}

/** Validates the cost use's choices like the control plane's costSettingsFrom. */
function costFrom(settings?: CostSettings): CostSettings {
  if (!settings) return bad('the cost use needs its settings');
  if (!['auto', 'export', 'api'].includes(settings.source)) {
    bad('the cost source is auto, export or api');
  }
  if (!['account', 'billing', 'via'].includes(settings.scope)) {
    bad('the billing scope is account, billing or via');
  }
  if (settings.scope === 'via' && !cloudConnections.get(settings.viaConnectionId ?? '')) {
    bad("pick the connection that reads this one's cost");
  }
  const hours = settings.refreshHours || 12;
  if (hours < 6 || hours > 24) bad('cost refreshes every 6 to 24 hours');
  return {
    source: settings.source,
    scope: settings.scope,
    viaConnectionId: settings.scope === 'via' ? settings.viaConnectionId : undefined,
    export: settings.source === 'api' ? undefined : settings.export,
    refreshHours: hours,
    trackedTags: costSettings.get().trackedTags,
  };
}

function postureFrom(settings?: PostureSettings): PostureSettings {
  const source = settings?.source ?? 'auto';
  if (!['auto', 'native', 'baseline'].includes(source)) {
    bad('the posture source is auto, native or baseline');
  }
  const hours = settings?.refreshHours || 12;
  if (hours < 4 || hours > 24) bad('posture refreshes every 4 to 24 hours');
  return { source, refreshHours: hours };
}

/** The tag keys cost keeps on its rows, for every connection. */
const costSettings = value<CloudCostSettings>('cloud.costSettings', () => ({
  trackedTags: ['team', 'env'],
}));

/** How the seeded scans go: AWS fine (a little throttled), Azure missing one permission. */
function scanUse(connection: Pick<StoredConnection, 'provider' | 'scopeId'>): UseResult {
  if (connection.provider === 'azure' && connection.scopeId === AZURE_SUBSCRIPTION) {
    return {
      state: 'needs_permission',
      message:
        'Reader is missing on resource group rg-analytics-etl, so its function apps are not listed.',
      missing: ['Microsoft.Web/sites/read'],
    };
  }
  return { state: 'ok' };
}

function typesOf(resources: CloudResource[]) {
  const types: Record<string, number> = {};
  for (const r of resources) types[r.type] = (types[r.type] ?? 0) + 1;
  return types;
}

const regionsOf = (resources: CloudResource[]) =>
  [...new Set(resources.map((r) => r.region).filter(Boolean))].sort();

function matching(connection: StoredConnection, resources: CloudResource[]) {
  return resources.filter(
    (r) =>
      r.connectionId === connection.id &&
      (!connection.resourceTypes.length ||
        connection.resourceTypes.includes(r.type.replace(/^(aws|azure)_/, ''))) &&
      (!connection.regions.length ||
        connection.regions.includes(r.region) ||
        r.type === 'aws_s3_bucket'),
  );
}

function statusOf(connection: StoredConnection, now: number): CloudConnection['status'] {
  if (!connection.seeded) return {};
  const found = matching(connection, cloudResources());
  const member = probes.get(connection.probeId)?.members[0]?.name ?? '';
  const use = scanUse(connection);
  const uses = Object.fromEntries(connection.scanTypes.map((name) => [name, use]));
  const discoveryStep = connection.intervalSeconds * 1000;
  let discovered = Math.floor(now / discoveryStep) * discoveryStep + 95_000;
  if (discovered > now) discovered -= discoveryStep;
  const aws = connection.provider === 'aws';
  const scan: CloudScan = {
    kind: 'inventory',
    uses,
    resources: found.length,
    types: typesOf(found),
    regions: regionsOf(found),
    probe: member,
    startedAt: new Date(discovered).toISOString(),
    durationSeconds: aws ? 41.7 : 12.3,
    throttled: aws ? 3 : 0,
    stoodDownSeconds: aws ? 4.5 : 0,
  };
  const healthAt = lastHealthScan(now, connection.healthIntervalSeconds) - 40_000;
  const checked = found.filter((r) => r.type !== 'aws_s3_bucket');
  const health: CloudScan = {
    kind: 'health',
    uses,
    resources: checked.length,
    types: typesOf(checked),
    regions: regionsOf(checked),
    probe: member,
    startedAt: new Date(healthAt).toISOString(),
    durationSeconds: aws ? 6.2 : 3.1,
  };
  const ok = { state: 'ok' as const };
  const costAt = Math.floor(now / (12 * HOUR)) * 12 * HOUR + 7 * 60_000;
  const month = new Date(now).toISOString().slice(0, 7);
  const cost: CloudScan | undefined = connection.cost && {
    kind: 'cost',
    uses: { cost: ok },
    resources: 0,
    probe: member,
    startedAt: new Date(costAt > now ? costAt - 12 * HOUR : costAt).toISOString(),
    durationSeconds: aws ? 18.4 : 9.6,
    cost: aws
      ? {
          source: 'export',
          finalThrough: new Date(now - 2 * DAY).toISOString().slice(0, 10),
          rows: 1_184,
          lastFile: `focus/harborline/data/BILLING_PERIOD=${month}/harborline-00001.snappy.parquet`,
          lastFileAt: new Date(now - 9 * HOUR).toISOString(),
        }
      : {
          source: 'api',
          finalThrough: new Date(now - 2 * DAY).toISOString().slice(0, 10),
          rows: 36,
          requests: 2,
        },
  };
  const postureAt = Math.floor(now / (12 * HOUR)) * 12 * HOUR + 19 * 60_000;
  const posture: CloudScan | undefined = connection.posture && {
    kind: 'posture',
    uses: { posture: ok },
    resources: 0,
    probe: member,
    startedAt: new Date(postureAt > now ? postureAt - 12 * HOUR : postureAt).toISOString(),
    durationSeconds: aws ? 27.1 : 6.8,
    posture: aws
      ? {
          findings: 9,
          native: [`${AWS_ACCOUNT}/${REGION}`],
          baseline: [`${AWS_ACCOUNT}/us-east-1`],
        }
      : { findings: 3, baseline: [`${AZURE_SUBSCRIPTION}/global`] },
  };
  return {
    scan,
    health,
    cost,
    posture,
    reportedAt: new Date(healthAt + health.durationSeconds * 1000 + 800).toISOString(),
  };
}

function connectionView(connection: StoredConnection, now = Date.now()): CloudConnection {
  const probe = probes.get(connection.probeId);
  const destination = destinations.get(connection.destinationId);
  const { probeId, destinationId, seeded, createdBy, ...rest } = connection;
  void seeded;
  void createdBy;
  return {
    ...rest,
    probe: { id: probeId, name: probe?.name ?? '', location: probe?.location ?? '' },
    destination: {
      id: destinationId,
      name: destination?.name ?? '',
      siteId: destination?.siteId ?? '',
      projectId: destination?.projectId ?? '',
    },
    status: statusOf(connection, now),
  };
}

interface PendingCloudTest {
  test: CloudTest;
  created: number;
  connection: StoredConnection;
}

const cloudTests = new Map<string, PendingCloudTest>();
/** How long Test access takes: the probe picks the task up and samples two regions. */
export const CLOUD_TEST_DELAY_MS = 2_500;

/** What Test access finds: the seeded estate for the seeded accounts, a plausible sample otherwise. */
function sampleScan(connection: StoredConnection, probeName: string, created: number): CloudScan {
  const r = rng(mix(hashString(connection.scopeId), hashString(connection.provider)));
  const defaults =
    connection.provider === 'aws' ? ['eu-west-1', 'us-east-1'] : ['westeurope', 'northeurope'];
  const regions = (connection.regions.length ? connection.regions : defaults).slice(0, 2);
  const known =
    (connection.provider === 'aws' && connection.scopeId === AWS_ACCOUNT) ||
    (connection.provider === 'azure' && connection.scopeId === AZURE_SUBSCRIPTION);
  let types: Record<string, number>;
  if (known) {
    const found = cloudResources().filter(
      (res) =>
        res.provider === connection.provider &&
        (regions.includes(res.region) || res.type === 'aws_s3_bucket') &&
        (!connection.resourceTypes.length ||
          connection.resourceTypes.includes(res.type.replace(/^(aws|azure)_/, ''))),
    );
    types = typesOf(found);
  } else {
    const wanted = connection.resourceTypes.length
      ? connection.resourceTypes
      : connection.provider === 'aws'
        ? AWS_TYPES
        : AZURE_TYPES;
    types = {};
    for (const type of wanted) {
      const count = int(r, 0, type.includes('instance') || type.includes('machine') ? 9 : 4);
      if (count) types[`${connection.provider}_${type}`] = count;
    }
  }
  const use = known ? scanUse(connection) : { state: 'ok' as const };
  return {
    kind: 'inventory',
    uses: Object.fromEntries(connection.scanTypes.map((name) => [name, use])),
    resources: Object.values(types).reduce((sum, n) => sum + n, 0),
    types,
    regions,
    probe: probeName,
    startedAt: new Date(created + 600).toISOString(),
    durationSeconds: Math.round((1.6 + r() * 2.2) * 10) / 10,
  };
}

function startCloudTest(request: CloudConnectionRequest): CloudTest {
  const connection = connectionFrom({ ...request, name: request.name || 'Test access' });
  const probe = probes.get(connection.probeId)!;
  const view = probeView(probe);
  if (!view.online) bad(`no instance of probe group "${probe.name}" is online; start one first`);
  const test: CloudTest = { id: newId(), status: 'queued', probe: probe.name };
  cloudTests.set(test.id, { test, created: Date.now(), connection });
  return test;
}

function cloudTest(id: string, now = Date.now()): CloudTest {
  const pending = cloudTests.get(id) ?? notFound('Test');
  if (now - pending.created < CLOUD_TEST_DELAY_MS) return pending.test;
  const probe = probes.get(pending.connection.probeId);
  const member =
    probe?.members.find((m) => m.silentForMs === undefined)?.name ?? pending.test.probe;
  return {
    ...pending.test,
    status: 'done',
    result: sampleScan(pending.connection, member, pending.created),
  };
}

// --- routes -------------------------------------------------------------------------

const body = <T>(req: DemoRequest) => (req.body ?? {}) as T;

export function register(r: Router) {
  // The inventory (a Site's; a control plane reads it through /sites/:id, any id here).
  r.get('/inventory/summary', (req) => summarize(filtered(req)));
  r.get('/inventory/assets', (req) => {
    const assets = sortAssets(filtered(req));
    const limit = clamp(req.query.get('limit'), 2000, 5000);
    return { assets: assets.slice(0, limit), total: assets.length };
  });
  r.get('/inventory/assets/:id', (req) => assetDetail(req.params.id));
  r.get('/inventory/changes', (req) => {
    const hours = clamp(req.query.get('hours'), 24, 168);
    const limit = clamp(req.query.get('limit'), 100, 500);
    const projectId = req.query.get('projectId') ?? '';
    const now = Date.now();
    return changesBetween(now - hours * HOUR, now, now)
      .filter((c) => !projectId || c.projectId === projectId)
      .slice(0, limit);
  });

  // Cloud connections (control plane).
  r.get('/cloud-connections', () => {
    const now = Date.now();
    return cloudConnections
      .all()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => connectionView(c, now));
  });
  r.get('/cloud-connections/setup', (): CloudSetup => ({
    issuer: 'https://obzly.harborline.example.com',
    externalId: newExternalId(),
    audiences: { aws: 'sts.amazonaws.com', azure: 'api://AzureADTokenExchange' },
  }));
  r.post('/cloud-connections', (req) =>
    connectionView(cloudConnections.insert(connectionFrom(body<CloudConnectionRequest>(req)))),
  );
  r.post('/cloud-connections/test', (req) => startCloudTest(body<CloudConnectionRequest>(req)));
  r.get('/cloud-connections/tests/:id', (req) => cloudTest(req.params.id));
  r.get('/cloud-connections/cost-settings', () => costSettings.get());
  r.put('/cloud-connections/cost-settings', (req) => {
    const tags = [
      ...new Set(
        (body<CloudCostSettings>(req).trackedTags ?? []).map((t) => t.trim()).filter(Boolean),
      ),
    ];
    if (tags.length > 10) bad('track at most 10 tags');
    return costSettings.set({ trackedTags: tags });
  });
  r.get('/cloud-connections/:id', (req) =>
    connectionView(cloudConnections.get(req.params.id) ?? notFound('Cloud connection')),
  );
  r.put('/cloud-connections/:id', (req) => {
    const existing = cloudConnections.get(req.params.id) ?? notFound('Cloud connection');
    const request = body<CloudConnectionRequest>(req);
    if (request.version !== undefined && request.version !== existing.version) {
      throw new DemoError(
        409,
        'this cloud connection was changed by someone else; reload it to see their changes',
      );
    }
    const connection = connectionFrom(request, existing);
    cloudConnections.update(connection.id, connection);
    return connectionView(connection);
  });
  r.delete('/cloud-connections/:id', (req) => {
    const id = (cloudConnections.get(req.params.id) ?? notFound('Cloud connection')).id;
    cloudConnections.remove(id);
    return { message: 'Cloud connection deleted' };
  });
}
