// Sites and system. The demo runs as a control plane with one Site
// (DEMO_SITE_ID): the Site registry, statuses, per-Site grants and SSO
// group -> Site mappings live here. Site data calls arrive as
// /sites/<id>/api/v1/... with req.siteId set, so /site/info and
// /system/upgrade-status answer as the Site or as the control plane.
import type {
  SSOSiteGroupMapping,
  Site,
  SiteAdmin,
  SiteEnvironment,
  SiteGrant,
  SiteStatus,
} from '../../entity/sites';
import type { SystemUsage, UpgradeStatus, UsageHour } from '../../entity/system';
import { SLOT_MS, slotMean } from '../gen/logs';
import { hashString, uuidFrom } from '../lib/rng';
import { DemoError, type DemoRequest, type Router, notInDemo } from '../router';
import { recordAudit } from '../seed/audit';
import { DAY, HOUR, MINUTE, PEOPLE, PERSON, type When, ago, isoOf } from '../seed/people';
import {
  DEMO_SITE_API_URL,
  DEMO_SITE_DISPLAY_NAME,
  DEMO_SITE_ENVIRONMENT,
  DEMO_SITE_ID,
  DEMO_SITE_NAME,
  isSiteCall,
} from '../seed/site';
import { users } from '../seed/users';
import { collection, newId } from '../store';
import { PROJECT_ID, STAGING_PROJECT_ID, dataStart, traffic } from '../world';
import { projects } from './bootstrap';

const MORE_SITES = 'Registering another Site (it needs a real Obzly Site to connect to)';

export const DEMO_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined) || '1.0.0';

/** Schema: the newest migration this build ships, applied 9 days ago. */
const SCHEMA_VERSION = 20261112090000;
const RECENT_MIGRATIONS = [
  20261112090000, 20261111090000, 20261110090000, 20261102120000, 20261027110000,
];

const fromVersion = (version: number) => {
  const s = String(version);
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10));
};

// Average bytes per row before compression, and how well each compresses.
const SIGNALS = {
  logs: { rawBytesPerRow: 410, ratio: 9 },
  traces: { rawBytesPerRow: 620, ratio: 7 },
  metrics: { rawBytesPerRow: 64, ratio: 14 },
} as const;
/** Spans per log line (requests fan out across services, but traces are sampled). */
const SPANS_PER_LOG = 0.85;
/** Active metric series, scraped every 30 s. */
const METRIC_SERIES = 1_800;

/** Generated log rows (both projects) between from and to, by the logs generator's slot means. */
function logRows(from: number, to: number): number {
  let total = 0;
  for (let slot = Math.floor(from / SLOT_MS); slot * SLOT_MS < to; slot++) {
    total += slotMean(slot, PROJECT_ID) + slotMean(slot, STAGING_PROJECT_ID);
  }
  return total;
}

const metricRows = (ms: number, t: number) =>
  ((METRIC_SERIES * ms) / 30_000) * (0.97 + 0.03 * traffic(t));

function usage(now = Date.now()): SystemUsage {
  const hours: UsageHour[] = [];
  const thisHour = Math.floor(now / HOUR) * HOUR;
  for (let start = thisHour - 23 * HOUR; start <= thisHour; start += HOUR) {
    const end = Math.min(start + HOUR, now);
    const logs = Math.round(logRows(start, end));
    const spans = Math.round(logs * SPANS_PER_LOG);
    const metrics = Math.round(metricRows(end - start, start));
    const hour = new Date(start).toISOString();
    hours.push(
      { hour, signal: 'logs', rows: logs, rawBytes: logs * SIGNALS.logs.rawBytesPerRow },
      { hour, signal: 'traces', rows: spans, rawBytes: spans * SIGNALS.traces.rawBytesPerRow },
      {
        hour,
        signal: 'metrics',
        rows: metrics,
        rawBytes: metrics * SIGNALS.metrics.rawBytesPerRow,
      },
    );
  }
  // Data kept: everything since the demo's data start (hourly steps are close enough).
  const start = dataStart(now);
  let logsKept = 0;
  for (let t = start; t < now; t += HOUR) logsKept += logRows(t, Math.min(t + HOUR, now));
  const kept = {
    logs: logsKept * SIGNALS.logs.rawBytesPerRow,
    traces: logsKept * SPANS_PER_LOG * SIGNALS.traces.rawBytesPerRow,
    metrics: metricRows(now - start, now) * SIGNALS.metrics.rawBytesPerRow,
  };
  const oldest = new Date(start).toISOString();
  return {
    hours,
    storage: (['logs', 'traces', 'metrics'] as const).map((signal) => ({
      signal,
      rawBytes: Math.round(kept[signal]),
      bytes: Math.round(kept[signal] / SIGNALS[signal].ratio),
      oldest,
    })),
  };
}

function schemaStatus(now: number): UpgradeStatus['schema'] {
  return {
    currentVersion: SCHEMA_VERSION,
    latestAvailable: SCHEMA_VERSION,
    appliedCount: 71,
    state: 'up-to-date',
    releasesAhead: 0,
    recent: RECENT_MIGRATIONS.map((version) => ({
      version,
      // Applied when this release rolled out, or when the migration shipped if later.
      appliedAt: new Date(
        Math.min(Math.max(fromVersion(version) + 6 * HOUR, now - 9 * DAY), now - HOUR),
      ).toISOString(),
    })),
  };
}

/** The control plane's own status: it holds no signal data. */
function centralUpgradeStatus(now = Date.now()): UpgradeStatus {
  return {
    version: DEMO_VERSION,
    serviceMode: 'control-plane',
    checkedAt: new Date(now).toISOString(),
    schema: schemaStatus(now),
    objectStorageEnabled: false,
    verdict: { safeToUpgrade: true, blockers: [], warnings: [] },
  };
}

function siteUpgradeStatus(now = Date.now()): UpgradeStatus {
  const before = (ms: number) => new Date(now - ms).toISOString();
  return {
    version: DEMO_VERSION,
    serviceMode: 'all',
    checkedAt: new Date(now).toISOString(),
    schema: schemaStatus(now),
    rewrites: {
      completed: [{ name: 'attribute-names-v2', completedAt: before(12 * DAY) }],
      streams: ['logs', 'spans', 'metrics'].map((stream) => ({
        stream,
        legacy: 0,
        total: 0,
        skipped: 0,
      })),
      remaining: 0,
      workerOnThisReplica: true,
    },
    segments: ['logs', 'spans', 'metrics'].map((stream, i) => ({
      stream,
      total: [18_412, 15_906, 4_221][i],
      pendingUpload: [3, 2, 1][i],
      smallSegments: [11, 9, 2][i],
      oldestPendingUploadAt: before((40 + i * 15) * 1000),
    })),
    ingestBuffer: ['INGEST_LOGS', 'INGEST_SPANS', 'INGEST_METRICS'].map((stream, i) => ({
      stream,
      messages: [42, 31, 8][i],
      bytes: [182_000, 240_000, 21_000][i],
      maxBytes: 8 * 1024 ** 3,
      oldestAt: before(1_500 + i * 400),
      replicasLagging: 0,
    })),
    integrityAudit: {
      finishedAt: before(3 * DAY + 2 * HOUR + 17 * MINUTE),
      sampled: 500,
      failed: 0,
      failures: [],
    },
    objectStorageEnabled: true,
    verdict: { safeToUpgrade: true, blockers: [], warnings: [] },
  };
}

// ---------------------------------------------------------------------------
// The Site registry (one Site), grants and SSO group -> Site mappings
// ---------------------------------------------------------------------------

interface SiteRecord {
  id: string;
  name: string;
  apiUrl: string;
  enabled: boolean;
  displayName: string;
  environment: SiteEnvironment;
  createdAt: When;
  updatedAt: When;
}

const sites = collection<SiteRecord>('sites', () => [
  {
    id: DEMO_SITE_ID,
    name: DEMO_SITE_NAME,
    apiUrl: DEMO_SITE_API_URL,
    enabled: true,
    displayName: DEMO_SITE_DISPLAY_NAME,
    environment: DEMO_SITE_ENVIRONMENT,
    createdAt: ago(118 * DAY),
    updatedAt: ago(40 * DAY),
  },
]);

const toSiteAdmin = (site: SiteRecord): SiteAdmin => ({
  ...site,
  createdAt: isoOf(site.createdAt),
  updatedAt: isoOf(site.updatedAt),
});

const toSite = (site: SiteRecord): Site => ({
  id: site.id,
  name: site.name,
  enabled: site.enabled,
  displayName: site.displayName,
  environment: site.environment,
  // The signed-in user is a central admin.
  siteRole: 'ADMIN',
});

function requireSite(id: string) {
  const site = sites.get(id);
  if (!site) throw new DemoError(404, 'Site not found');
  return site;
}

/** A believable, slowly wandering round-trip time to the Site. */
const latencyMs = (now: number) => 14 + (hashString(String(Math.floor(now / 30_000))) % 23);

function statusOf(site: SiteRecord, now: number): SiteStatus {
  if (!site.enabled)
    return { siteId: site.id, status: 'disabled', checkedAt: new Date(now).toISOString() };
  return {
    siteId: site.id,
    status: 'up',
    version: DEMO_VERSION,
    latencyMs: latencyMs(now),
    checkedAt: new Date(now - (now % 30_000)).toISOString(),
  };
}

interface GrantRecord {
  id: string;
  userId: string;
  siteId: string;
  projectId: string | null;
  role: string;
  createdAt: When;
  ssoManaged?: boolean;
}

const SITE_ROLES = ['ADMIN', 'MEMBER', 'VIEWER'];
const PROJECT_ROLES = ['PROJECT_ADMIN', 'PROJECT_MEMBER', 'PROJECT_VIEWER'];

/** Admins get the whole Site; everyone else their projects (owners as project admins). */
function seedGrants(): GrantRecord[] {
  const out: GrantRecord[] = [];
  for (const person of PEOPLE) {
    if (person.role === 'ADMIN') {
      out.push({
        id: uuidFrom(`grant:${person.id}:site`),
        userId: person.id,
        siteId: DEMO_SITE_ID,
        projectId: null,
        role: 'ADMIN',
        createdAt: person.createdAt,
      });
      continue;
    }
    for (const membership of person.projects) {
      out.push({
        id: uuidFrom(`grant:${person.id}:${membership.projectId}`),
        userId: person.id,
        siteId: DEMO_SITE_ID,
        projectId: membership.projectId,
        role: membership.role === 'OWNER' ? 'PROJECT_ADMIN' : membership.role,
        createdAt: membership.since,
        // Tomás's access comes from the customer-support SSO group mapping.
        ssoManaged: person.id === PERSON.tomas.id || undefined,
      });
    }
  }
  return out;
}

const grants = collection<GrantRecord>('siteGrants', seedGrants);

const toGrant = (g: GrantRecord): SiteGrant => ({
  id: g.id,
  userId: g.userId,
  userEmail: users.get(g.userId)?.email ?? '',
  siteId: g.siteId,
  projectId: g.projectId,
  role: g.role,
  createdAt: isoOf(g.createdAt),
  ssoManaged: g.ssoManaged,
});

function grantRole(projectId: string | null, role: unknown): string {
  const allowed = projectId ? PROJECT_ROLES : SITE_ROLES;
  if (!allowed.includes(role as string))
    throw new DemoError(
      400,
      projectId
        ? 'A project role must be PROJECT_ADMIN, PROJECT_MEMBER or PROJECT_VIEWER'
        : 'A Site-wide role must be ADMIN, MEMBER or VIEWER',
    );
  return role as string;
}

function grantTarget(body: { siteId?: string; projectId?: string | null }) {
  const site = requireSite(String(body.siteId ?? ''));
  const projectId = body.projectId || null;
  if (projectId && !projects.get(projectId))
    throw new DemoError(404, 'Project not found on this Site');
  return { siteId: site.id, projectId };
}

type MappingRecord = Omit<SSOSiteGroupMapping, 'createdAt'> & { createdAt: When };

const CONNECTOR = 'sso-harborline-identity';
const siteMappings = collection<MappingRecord>('ssoSiteGroupMappings', () => [
  {
    id: 'site-map-admins',
    connectorId: CONNECTOR,
    groupName: 'obzly-admins',
    siteId: DEMO_SITE_ID,
    projectId: null,
    role: 'ADMIN',
    createdAt: ago(60 * DAY),
  },
  {
    id: 'site-map-shop',
    connectorId: CONNECTOR,
    groupName: 'shop-engineering',
    siteId: DEMO_SITE_ID,
    projectId: PROJECT_ID,
    role: 'PROJECT_MEMBER',
    createdAt: ago(58 * DAY),
  },
  {
    id: 'site-map-support',
    connectorId: CONNECTOR,
    groupName: 'customer-support',
    siteId: DEMO_SITE_ID,
    projectId: PROJECT_ID,
    role: 'PROJECT_VIEWER',
    createdAt: ago(39 * DAY),
  },
]);

const toMapping = (m: MappingRecord): SSOSiteGroupMapping => ({
  ...m,
  createdAt: isoOf(m.createdAt),
});

const ENVIRONMENTS: SiteEnvironment[] = ['', 'production', 'staging', 'development'];

/** The proxied Site answers as itself; the control plane as a control plane. */
const siteInfo = (req: DemoRequest) =>
  isSiteCall(req)
    ? {
        siteId: DEMO_SITE_ID,
        siteName: DEMO_SITE_NAME,
        version: DEMO_VERSION,
        mode: 'site',
        controlPlaneConfigured: true,
        sharedConfigKey: 'ZGVtby1oYXJib3JsaW5lLWV1LWtleS1ub3QtcmVhbA==',
      }
    : {
        siteId: '',
        siteName: '',
        version: DEMO_VERSION,
        mode: 'control-plane',
        controlPlaneConfigured: false,
      };

export function register(r: Router) {
  // --- this deployment (the control plane) or the proxied Site --------------------
  r.get('/site/info', siteInfo);
  r.get('/system/health', () => ({ status: 'healthy' }));
  r.get('/system/ready', () => ({ status: 'ready' }));
  r.get('/system/live', () => ({ status: 'alive' }));
  r.get('/downdetect/is-available', () => ({
    message: 'API, DB (PostgreSQL), logs storage and cache (Valkey) are available',
  }));
  r.get('/system/upgrade-status', (req) =>
    isSiteCall(req) ? siteUpgradeStatus() : centralUpgradeStatus(),
  );
  r.get('/system/usage', (req) => {
    // A control plane holds no signal data; the UI asks each Site.
    if (!isSiteCall(req)) throw new DemoError(404, 'Usage is reported by each Site');
    return usage();
  });
  r.get('/system/data-migration', () => ({
    streams: ['logs', 'spans', 'metrics'].map((stream) => ({
      stream,
      legacy: 0,
      total: 0,
      skipped: 0,
    })),
  }));

  // --- the Site registry ----------------------------------------------------------
  r.get('/control-plane/sites', () => sites.all().map(toSite));
  r.get('/control-plane/sites/status', () => {
    const now = Date.now();
    return {
      statuses: sites.all().map((site) => {
        const { siteId, status } = statusOf(site, now);
        return { siteId, status };
      }),
    };
  });
  r.get('/control-plane/admin/sites', () => sites.all().map(toSiteAdmin));
  r.get('/control-plane/admin/sites/status', () => {
    const now = Date.now();
    return { statuses: sites.all().map((site) => statusOf(site, now)) };
  });
  r.post('/control-plane/admin/sites', () => notInDemo(MORE_SITES));
  r.put('/control-plane/admin/sites/:id', (req) => {
    const site = requireSite(req.params.id);
    const body = (req.body ?? {}) as {
      name?: string;
      apiUrl?: string;
      enabled?: boolean;
      displayName?: string;
      environment?: SiteEnvironment;
    };
    const name = (body.name ?? '').trim();
    if (!name) throw new DemoError(400, 'name is required');
    const apiUrl = (body.apiUrl ?? '').trim();
    if (!/^https?:\/\//.test(apiUrl)) throw new DemoError(400, 'apiUrl must be an http(s) URL');
    if (body.environment !== undefined && !ENVIRONMENTS.includes(body.environment))
      throw new DemoError(400, 'environment must be production, staging, development or empty');
    const enabled = body.enabled ?? site.enabled;
    if (!enabled && sites.all().filter((s) => s.enabled).length === 1)
      throw new DemoError(
        400,
        `${site.displayName || site.id} is the demo's only Site: it stays enabled`,
      );
    const updated = sites.update(site.id, {
      name,
      apiUrl,
      enabled,
      displayName: body.displayName === undefined ? site.displayName : body.displayName.trim(),
      environment: body.environment ?? site.environment,
      updatedAt: Date.now(),
    }) as SiteRecord;
    recordAudit(`Site updated: ${site.id}`);
    return toSiteAdmin(updated);
  });
  r.delete('/control-plane/admin/sites/:id', (req) => {
    const site = requireSite(req.params.id);
    if (sites.all().length === 1)
      throw new DemoError(
        400,
        `${site.displayName || site.id} is the demo's only Site, so it can't be removed`,
      );
    sites.remove(site.id);
    recordAudit(`Site removed: ${site.id}`);
    return { success: true };
  });
  r.post('/control-plane/admin/sites/:id/check', (req) => {
    const site = requireSite(req.params.id);
    return { reachable: true, siteIdMatches: true, reportedSiteId: site.id, version: DEMO_VERSION };
  });

  // --- per-Site grants --------------------------------------------------------------
  r.get('/control-plane/admin/sites/:siteId/grants', (req) => {
    requireSite(req.params.siteId);
    return grants
      .find((g) => g.siteId === req.params.siteId)
      .map(toGrant)
      .sort(
        (a, b) => a.userEmail.localeCompare(b.userEmail) || a.createdAt.localeCompare(b.createdAt),
      );
  });
  r.post('/control-plane/admin/grants', (req) => {
    const body = (req.body ?? {}) as {
      userId?: string;
      siteId?: string;
      projectId?: string | null;
      role?: string;
    };
    const user = body.userId ? users.get(body.userId) : undefined;
    if (!user) throw new DemoError(404, 'User not found');
    const { siteId, projectId } = grantTarget(body);
    const role = grantRole(projectId, body.role);
    if (
      grants.find((g) => g.userId === user.id && g.siteId === siteId && g.projectId === projectId)
        .length
    )
      throw new DemoError(409, 'This user already has a role there');
    const grant = grants.insert({
      id: newId(),
      userId: user.id,
      siteId,
      projectId,
      role,
      createdAt: Date.now(),
    });
    recordAudit(
      `Site grant added: ${user.email} ${role} on ${siteId}${projectId ? ` project ${projectId}` : ''}`,
    );
    return toGrant(grant);
  });
  r.delete('/control-plane/admin/grants/:id', (req) => {
    const grant = grants.get(req.params.id);
    if (!grant) throw new DemoError(404, 'Grant not found');
    grants.remove(grant.id);
    recordAudit(
      `Site grant removed: ${users.get(grant.userId)?.email ?? grant.userId} on ${grant.siteId}`,
    );
    return { success: true };
  });

  // --- SSO group -> Site mappings ---------------------------------------------------------
  const mappingsBase = '/control-plane/admin/sso/connectors/:connectorId/site-group-mappings';
  r.get(mappingsBase, (req) => ({
    mappings: siteMappings.find((m) => m.connectorId === req.params.connectorId).map(toMapping),
  }));
  r.post(mappingsBase, (req) => {
    const body = (req.body ?? {}) as {
      groupName?: string;
      siteId?: string;
      projectId?: string | null;
      role?: string;
    };
    const groupName = (body.groupName ?? '').trim();
    if (!groupName) throw new DemoError(400, 'groupName is required');
    const { siteId, projectId } = grantTarget(body);
    const role = grantRole(projectId, body.role);
    const mapping = siteMappings.insert({
      id: newId(),
      connectorId: req.params.connectorId,
      groupName,
      siteId,
      projectId,
      role,
      createdAt: Date.now(),
    });
    recordAudit(`SSO Site group mapping created: ${groupName} → ${role} on ${siteId}`);
    return toMapping(mapping);
  });
  r.delete(`${mappingsBase}/:mappingId`, (req) => {
    const mapping = siteMappings.get(req.params.mappingId);
    if (!mapping || mapping.connectorId !== req.params.connectorId)
      throw new DemoError(404, 'Mapping not found');
    siteMappings.remove(mapping.id);
    recordAudit(`SSO Site group mapping deleted: ${mapping.groupName}`);
    return { message: 'mapping deleted' };
  });
}
