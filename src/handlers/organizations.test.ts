import { beforeEach, describe, expect, it } from 'vitest';

import type {
  NewSCIMToken,
  OrgDetail,
  OrgMember,
  OrgPlan,
  Organization,
  Team,
} from '../../entity/organizations';
import type {
  SSOSiteGroupMapping,
  Site,
  SiteAdmin,
  SiteCheckResult,
  SiteGrant,
  SiteStatus,
} from '../../entity/sites';
import type { SystemUsage, UpgradeStatus } from '../../entity/system';
import { DemoError } from '../router';
import { ORG_ID, PERSON } from '../seed/people';
import { DEMO_SITE_ID } from '../seed/site';
import { resetDemo } from '../store';
import { PROJECT_ID } from '../world';
import { register as admin } from './admin';
import { call, routerWith } from './admin.testkit';
import { register as aiUsage } from './aiUsage';
import { register as bootstrap } from './bootstrap';
import { register } from './organizations';
import { register as sites } from './sites';

const router = routerWith(bootstrap, register, admin, sites, aiUsage);

describe('demo organizations', () => {
  beforeEach(() => resetDemo());

  it('has Harborline with members, teams and a plan', async () => {
    const orgs = await call<Organization[]>(router, 'GET', '/orgs');
    expect(orgs).toEqual([expect.objectContaining({ name: 'Harborline', myRole: 'ORG_OWNER' })]);
    const members = await call<OrgMember[]>(router, 'GET', `/orgs/${ORG_ID}/members`);
    expect(members[0].role).toBe('ORG_OWNER');
    expect(members.find((m) => m.userId === PERSON.ben.id)?.suspended).toBe(true);
    expect(members.find((m) => m.userId === PERSON.hana.id)?.externalId).toBeTruthy();
    const teams = await call<Team[]>(router, 'GET', `/orgs/${ORG_ID}/teams`);
    expect(teams.map((t) => t.name)).toEqual(['Customer support', 'Platform', 'Shop engineering']);
    expect(teams[0].grants[0]).toMatchObject({ siteId: DEMO_SITE_ID, projectId: PROJECT_ID });
    const plan = await call<OrgPlan>(router, 'GET', `/orgs/${ORG_ID}/plan`);
    expect(plan.maxMembers).toBe(25);
  });

  it('edits teams, grants, plan and SCIM tokens', async () => {
    const team = await call<Team>(router, 'POST', `/orgs/${ORG_ID}/teams`, { name: 'Data' });
    await call(router, 'POST', `/orgs/${ORG_ID}/teams/${team.id}/members`, {
      email: PERSON.hana.email,
    });
    await call(router, 'POST', `/orgs/${ORG_ID}/teams/${team.id}/grants`, {
      siteId: DEMO_SITE_ID,
      projectId: PROJECT_ID,
      role: 'PROJECT_VIEWER',
    });
    const teams = await call<Team[]>(router, 'GET', `/orgs/${ORG_ID}/teams`);
    const data = teams.find((t) => t.id === team.id);
    expect(data?.members.map((m) => m.name)).toEqual(['Hana Kobayashi']);
    expect(data?.grants).toHaveLength(1);

    const plan = await call<OrgPlan>(router, 'PUT', `/orgs/${ORG_ID}/plan`, {
      logsPerSecondLimit: 100,
      maxLogsAmount: 0,
      maxLogsSizeMb: 0,
      maxLogsLifeDays: 7,
      maxLogSizeKb: 64,
      maxProjects: 3,
      maxSites: 0,
      maxMembers: 10,
    });
    expect(plan.logsPerSecondLimit).toBe(100);

    const token = await call<NewSCIMToken>(router, 'POST', `/orgs/${ORG_ID}/scim-tokens`, {
      name: 'test',
    });
    expect(token.token).toMatch(/^obzscim_demo/);
    expect(token.token).toContain('notarealtoken');
    await call(router, 'DELETE', `/orgs/${ORG_ID}/scim-tokens/${token.id}`);

    const error = await call(router, 'DELETE', `/orgs/${ORG_ID}`).catch((e: unknown) => e);
    expect((error as DemoError).status).toBe(400);
  });
});

describe('demo control plane and its Site', () => {
  beforeEach(() => resetDemo());
  const site = `/sites/${DEMO_SITE_ID}/api/v1`;

  it('answers /site/info and upgrade status as the control plane or the Site', async () => {
    const central = await call<{ mode: string; siteId: string }>(router, 'GET', '/site/info');
    expect(central).toMatchObject({ mode: 'control-plane', siteId: '' });
    const proxied = await call<{ mode: string; siteId: string }>(
      router,
      'GET',
      `${site}/site/info`,
    );
    expect(proxied).toMatchObject({ mode: 'site', siteId: DEMO_SITE_ID });

    const cp = await call<UpgradeStatus>(router, 'GET', '/system/upgrade-status');
    expect(cp.serviceMode).toBe('control-plane');
    expect(cp.segments).toBeUndefined();
    const st = await call<UpgradeStatus>(router, 'GET', `${site}/system/upgrade-status`);
    expect(st.verdict.safeToUpgrade).toBe(true);
    expect(st.schema.state).toBe('up-to-date');
    expect(st.segments).toHaveLength(3);
  });

  it('reports usage per Site only', async () => {
    const error = await call(router, 'GET', '/system/usage').catch((e: unknown) => e);
    expect((error as DemoError).status).toBe(404);
    const usage = await call<SystemUsage>(router, 'GET', `${site}/system/usage`);
    expect(usage.hours).toHaveLength(24 * 3);
    const logs = usage.hours.filter((h) => h.signal === 'logs');
    // ~2.4 logs/s at traffic 1: thousands of rows an hour.
    expect(logs.slice(0, -1).every((h) => h.rows > 2_000 && h.rows < 20_000)).toBe(true);
    expect(usage.storage.map((s) => s.signal)).toEqual(['logs', 'traces', 'metrics']);
  });

  it('lists the one Site with its status and refuses removing it', async () => {
    const sites = await call<Site[]>(router, 'GET', '/control-plane/sites');
    expect(sites).toEqual([
      expect.objectContaining({
        id: DEMO_SITE_ID,
        name: 'eu-west-1',
        displayName: 'Harborline EU',
        environment: 'production',
        siteRole: 'ADMIN',
      }),
    ]);
    const admin = await call<SiteAdmin[]>(router, 'GET', '/control-plane/admin/sites');
    expect(admin[0].apiUrl).toBe('https://obzly-eu.harborline.example.com');
    const statuses = await call<{ statuses: SiteStatus[] }>(
      router,
      'GET',
      '/control-plane/admin/sites/status',
    );
    expect(statuses.statuses[0]).toMatchObject({ siteId: DEMO_SITE_ID, status: 'up' });
    expect(statuses.statuses[0].latencyMs).toBeGreaterThan(0);
    const check = await call<SiteCheckResult>(
      router,
      'POST',
      `/control-plane/admin/sites/${DEMO_SITE_ID}/check`,
    );
    expect(check).toMatchObject({ reachable: true, siteIdMatches: true });
    const removal = await call(
      router,
      'DELETE',
      `/control-plane/admin/sites/${DEMO_SITE_ID}`,
    ).catch((e: unknown) => e);
    expect((removal as DemoError).message).toContain("only Site, so it can't be removed");
    const updated = await call<SiteAdmin>(
      router,
      'PUT',
      `/control-plane/admin/sites/${DEMO_SITE_ID}`,
      {
        name: 'eu-west-1',
        apiUrl: admin[0].apiUrl,
        enabled: true,
        displayName: 'Harborline Europe',
      },
    );
    expect(updated.displayName).toBe('Harborline Europe');
  });

  it('keeps grants and SSO Site mappings', async () => {
    const grants = await call<SiteGrant[]>(
      router,
      'GET',
      `/control-plane/admin/sites/${DEMO_SITE_ID}/grants`,
    );
    expect(grants.find((g) => g.userId === PERSON.priya.id)?.role).toBe('ADMIN');
    expect(grants.find((g) => g.userId === PERSON.tomas.id)?.ssoManaged).toBe(true);
    const created = await call<SiteGrant>(router, 'POST', '/control-plane/admin/grants', {
      userId: PERSON.ben.id,
      siteId: DEMO_SITE_ID,
      projectId: null,
      role: 'VIEWER',
    });
    expect(created.userEmail).toBe(PERSON.ben.email);
    await call(router, 'DELETE', `/control-plane/admin/grants/${created.id}`);

    const base = '/control-plane/admin/sso/connectors/sso-harborline-identity/site-group-mappings';
    const before = await call<{ mappings: SSOSiteGroupMapping[] }>(router, 'GET', base);
    const mapping = await call<SSOSiteGroupMapping>(router, 'POST', base, {
      groupName: 'sre',
      siteId: DEMO_SITE_ID,
      projectId: null,
      role: 'MEMBER',
    });
    const after = await call<{ mappings: SSOSiteGroupMapping[] }>(router, 'GET', base);
    expect(after.mappings).toHaveLength(before.mappings.length + 1);
    await call(router, 'DELETE', `${base}/${mapping.id}`);
  });

  it('owns the Site in Harborline', async () => {
    const org = await call<OrgDetail>(router, 'GET', `/orgs/${ORG_ID}`);
    expect(org.sites).toEqual([DEMO_SITE_ID]);
    await call(router, 'PUT', `/orgs/${ORG_ID}/sites/${DEMO_SITE_ID}`);
  });
});

// Every URL the admin/AI entity modules call has a demo route.
describe('demo route coverage for the admin and AI areas', () => {
  const sources = import.meta.glob<string>('../../entity/*/api/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const modules = [
    'aiUsage',
    'organizations',
    'users',
    'api-keys',
    'audit-logs',
    'projects',
    'sites',
    'system',
  ];
  const sample = (template: string) =>
    template
      .replace(/\$\{[^}]*\}/g, 'x')
      .replace(/\?.*$/, '')
      .replace(/^x?\/api\/v1/, '')
      .replace(/^x\/sites\/x\/api\/v1/, '')
      .replace(/^x/, '');
  const calls: { method: string; path: string; file: string }[] = [];
  for (const [file, source] of Object.entries(sources)) {
    const name = file.split('/')[3];
    if (!modules.includes(name)) continue;
    const base = /const (?:base|baseUrl) = \([^)]*\) =>\s*`([^`]*)`/.exec(source)?.[1];
    const pattern =
      /(fetch(Get|Post|Put|Delete)(?:Json|Raw)|postConsent)\(\s*`([^`]*)`|fetch\(\s*`([^`]*)`,\s*\{\s*method: '(\w+)'/g;
    for (const m of source.matchAll(pattern)) {
      let template = m[3] ?? m[4];
      // oauthApi's postConsent helper itself; its callers are matched below.
      if (template.includes('${path}')) continue;
      const method = (m[2] ?? m[5] ?? 'POST').toUpperCase();
      if (m[1] === 'postConsent') template = `\${baseUrl()}/oauth${template}`;
      if (base) template = template.replace(/\$\{(base|baseUrl)\([^)]*\)\}/, base);
      const path = sample(template);
      // Answered by the logs area.
      if (path === '/logs/query/system-dashboard') continue;
      calls.push({ method, path, file });
    }
  }

  // Calls the parser above can't see (URLs built in variables or helpers).
  for (const [method, path] of [
    ['GET', '/access-tokens'],
    ['POST', '/access-tokens'],
    ['GET', '/users'],
    ['GET', '/audit-logs/global'],
    ['GET', '/audit-logs/users/x'],
    ['GET', '/projects/x/audit-logs'],
    ['GET', '/auth/oauth/state'],
    ['GET', '/auth/sso/connectors'],
    ['POST', '/oauth/authorize/validate'],
    ['POST', '/oauth/authorize/decision'],
    ['GET', '/control-plane/admin/sso/connectors/x/site-group-mappings'],
    ['POST', '/control-plane/admin/sso/connectors/x/site-group-mappings'],
    ['GET', '/system/data-migration'],
    ['GET', '/site/info'],
    ['GET', '/system/live'],
    ['GET', '/system/ready'],
    ['GET', '/downdetect/is-available'],
  ])
    calls.push({ method, path, file: 'listed by hand' });

  it('finds the entity calls', () => {
    expect(calls.length).toBeGreaterThan(80);
  });

  it.each(calls.map((c) => [`${c.method} ${c.path}`, c] as const))('%s', (_label, c) => {
    expect(router.match(c.method, c.path), `${c.file}`).toBeTruthy();
  });
});
