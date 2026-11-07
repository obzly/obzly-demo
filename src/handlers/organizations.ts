// Organizations: Harborline with its members, teams (and their roles on the
// demo's one Site and its projects), plan limits, SCIM tokens and Sites. The
// demo runs as a control plane, so Harborline owns DEMO_SITE_ID.
import type {
  OrgMember,
  OrgPlan,
  OrgPlanLimits,
  OrgRole,
  Organization,
  SCIMToken,
  Team,
  TeamGrant,
} from '../../entity/organizations';
import { DemoError, type Router } from '../router';
import { recordAudit } from '../seed/audit';
import { DAY, HOUR, ORG_ID, PEOPLE, TEAMS, type When, ago, isoOf } from '../seed/people';
import { DEMO_SITE_ID } from '../seed/site';
import { collection, newId } from '../store';
import { DEMO_USER_ID } from '../world';
import { userByEmail, userIdentity, users } from './admin';
import { projects } from './bootstrap';

interface OrgRecord {
  id: string;
  name: string;
  slug: string;
  /** The Sites this organization owns (a Site belongs to one organization). */
  sites?: string[];
  createdAt: When;
}

const orgs = collection<OrgRecord>('orgs', () => [
  {
    id: ORG_ID,
    name: 'Harborline',
    slug: 'harborline',
    createdAt: ago(120 * DAY),
    sites: [DEMO_SITE_ID],
  },
]);

interface OrgMemberRecord {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  externalId?: string;
  suspended: boolean;
}

const orgMembers = collection<OrgMemberRecord>('orgMembers', () =>
  PEOPLE.map((p) => ({
    id: `${ORG_ID}:${p.id}`,
    orgId: ORG_ID,
    userId: p.id,
    role: p.orgRole,
    externalId: p.scimExternalId,
    suspended: !p.isActive,
  })),
);

interface TeamRecord {
  id: string;
  orgId: string;
  name: string;
  memberIds: string[];
  grants: { id: string; siteId?: string; projectId: string | null; role: string }[];
}

const teams = collection<TeamRecord>('orgTeams', () => TEAMS.map((t) => ({ ...t, orgId: ORG_ID })));

const planDefaults = (orgId: string): OrgPlan & { id: string } => ({
  id: orgId,
  orgId,
  logsPerSecondLimit: 5000,
  maxLogsAmount: 0,
  maxLogsSizeMb: 0,
  maxLogsLifeDays: 30,
  maxLogSizeKb: 64,
  maxProjects: 10,
  maxSites: 3,
  maxMembers: 25,
  updatedBy: DEMO_USER_ID,
  updatedAt: '',
});

interface PlanRecord extends Omit<OrgPlan, 'updatedAt'> {
  id: string;
  updatedAt: When;
}

const orgPlans = collection<PlanRecord>('orgPlans', () => [
  { ...planDefaults(ORG_ID), updatedAt: ago(30 * DAY) },
]);

interface ScimRecord extends Omit<SCIMToken, 'createdAt' | 'lastUsedAt'> {
  createdAt: When;
  lastUsedAt: When | null;
}

const scimTokens = collection<ScimRecord>('scimTokens', () => [
  {
    id: 'scim-idp-provisioning',
    orgId: ORG_ID,
    name: 'IdP provisioning',
    prefix: 'demo4f8a2c1e',
    createdAt: ago(46 * DAY),
    lastUsedAt: ago(2 * HOUR),
  },
]);

const ROLES: OrgRole[] = ['ORG_OWNER', 'ORG_ADMIN', 'ORG_MEMBER'];
const PLAN_KEYS: (keyof OrgPlanLimits)[] = [
  'logsPerSecondLimit',
  'maxLogsAmount',
  'maxLogsSizeMb',
  'maxLogsLifeDays',
  'maxLogSizeKb',
  'maxProjects',
  'maxSites',
  'maxMembers',
];

function requireOrg(id: string) {
  const org = orgs.get(id);
  if (!org) throw new DemoError(404, 'Organization not found');
  return org;
}

const myRole = (orgId: string): OrgRole | '' =>
  orgMembers.find((m) => m.orgId === orgId && m.userId === DEMO_USER_ID)[0]?.role ?? '';

const toOrg = (o: OrgRecord): Organization => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  createdAt: isoOf(o.createdAt),
  myRole: myRole(o.id),
});

function toMember(m: OrgMemberRecord): OrgMember | undefined {
  const identity = userIdentity(m.userId);
  if (!identity) return undefined;
  return {
    orgId: m.orgId,
    userId: m.userId,
    role: m.role,
    externalId: m.externalId,
    suspended: m.suspended,
    email: identity.email,
    name: identity.name,
  };
}

function toTeam(t: TeamRecord): Team {
  return {
    id: t.id,
    orgId: t.orgId,
    name: t.name,
    members: t.memberIds.flatMap((userId) => {
      const identity = userIdentity(userId);
      return identity ? [{ userId, ...identity }] : [];
    }),
    grants: t.grants.map((g) => ({ ...g, teamId: t.id, siteId: g.siteId ?? DEMO_SITE_ID })),
  };
}

function requireTeam(orgId: string, teamId: string) {
  requireOrg(orgId);
  const team = teams.get(teamId);
  if (!team || team.orgId !== orgId) throw new DemoError(404, 'Team not found');
  return team;
}

function requireUserByEmail(email: unknown) {
  const user = typeof email === 'string' ? userByEmail(email) : undefined;
  if (!user) throw new DemoError(404, 'No user with that email');
  return user;
}

const toPlan = (p: PlanRecord): OrgPlan => {
  const { id: _id, ...rest } = p;
  void _id;
  return { ...rest, updatedAt: isoOf(p.updatedAt) };
};

export function register(r: Router) {
  // --- organizations -----------------------------------------------------------
  r.get('/orgs', () => orgs.all().map(toOrg));
  r.post('/orgs', (req) => {
    const body = (req.body ?? {}) as { name?: string; slug?: string };
    const name = (body.name ?? '').trim();
    const slug = (body.slug ?? '').trim().toLowerCase();
    if (!name) throw new DemoError(400, 'name is required');
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug))
      throw new DemoError(400, 'slug must be 2-63 lowercase letters, digits or hyphens');
    if (orgs.all().some((o) => o.slug === slug))
      throw new DemoError(409, 'An organization with this slug already exists');
    const org = orgs.insert({ id: newId(), name, slug, createdAt: Date.now(), sites: [] });
    orgMembers.insert({
      id: `${org.id}:${DEMO_USER_ID}`,
      orgId: org.id,
      userId: DEMO_USER_ID,
      role: 'ORG_OWNER',
      suspended: false,
    });
    recordAudit(`Organization created: ${name}`);
    return toOrg(org);
  });
  r.get('/orgs/:orgId', (req) => {
    const org = requireOrg(req.params.orgId);
    return { ...toOrg(org), sites: org.sites ?? [] };
  });
  r.put('/orgs/:orgId', (req) => {
    const org = requireOrg(req.params.orgId);
    const name = String((req.body as { name?: string } | undefined)?.name ?? '').trim();
    if (!name) throw new DemoError(400, 'name is required');
    const updated = orgs.update(org.id, { name }) as OrgRecord;
    recordAudit(`Organization renamed: ${org.name} to ${name}`);
    return toOrg(updated);
  });
  r.delete('/orgs/:orgId', (req) => {
    const org = requireOrg(req.params.orgId);
    if (org.id === ORG_ID)
      throw new DemoError(400, "Harborline is the demo's organization and can't be deleted");
    orgs.remove(org.id);
    orgMembers.replaceAll(orgMembers.all().filter((m) => m.orgId !== org.id));
    teams.replaceAll(teams.all().filter((t) => t.orgId !== org.id));
    recordAudit(`Organization deleted: ${org.name}`);
    return { message: 'Organization deleted' };
  });

  // --- members -------------------------------------------------------------------
  r.get('/orgs/:orgId/members', (req) => {
    requireOrg(req.params.orgId);
    return orgMembers
      .find((m) => m.orgId === req.params.orgId)
      .map(toMember)
      .filter((m): m is OrgMember => !!m)
      .sort(
        (a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.name.localeCompare(b.name),
      );
  });
  r.post('/orgs/:orgId/members', (req) => {
    const org = requireOrg(req.params.orgId);
    const body = (req.body ?? {}) as { userId?: string; email?: string; role?: OrgRole };
    if (!ROLES.includes(body.role as OrgRole))
      throw new DemoError(400, 'role must be ORG_OWNER, ORG_ADMIN or ORG_MEMBER');
    const user = body.userId ? users.get(body.userId) : requireUserByEmail(body.email);
    if (!user) throw new DemoError(404, 'User not found');
    const id = `${org.id}:${user.id}`;
    const existing = orgMembers.get(id);
    if (existing?.role === 'ORG_OWNER' && body.role !== 'ORG_OWNER') {
      const owners = orgMembers.find((m) => m.orgId === org.id && m.role === 'ORG_OWNER');
      if (owners.length === 1) throw new DemoError(400, 'An organization needs at least one owner');
    }
    if (existing) orgMembers.update(id, { role: body.role });
    else
      orgMembers.insert({
        id,
        orgId: org.id,
        userId: user.id,
        role: body.role as OrgRole,
        suspended: false,
      });
    recordAudit(
      `Organization member ${existing ? 'updated' : 'added'}: ${user.email} as ${body.role}`,
    );
    return { message: 'Member saved' };
  });
  r.delete('/orgs/:orgId/members/:userId', (req) => {
    const org = requireOrg(req.params.orgId);
    const member = orgMembers.get(`${org.id}:${req.params.userId}`);
    if (!member) throw new DemoError(404, 'Member not found');
    if (member.role === 'ORG_OWNER') {
      const owners = orgMembers.find((m) => m.orgId === org.id && m.role === 'ORG_OWNER');
      if (owners.length === 1) throw new DemoError(400, 'An organization needs at least one owner');
    }
    orgMembers.remove(member.id);
    teams.replaceAll(
      teams
        .all()
        .map((t) =>
          t.orgId === org.id
            ? { ...t, memberIds: t.memberIds.filter((id) => id !== member.userId) }
            : t,
        ),
    );
    recordAudit(
      `Organization member removed: ${userIdentity(member.userId)?.email ?? member.userId}`,
    );
    return { message: 'Member removed' };
  });
  // Moving a Site removes the old organization's team roles there.
  r.put('/orgs/:orgId/sites/:siteId', (req) => {
    const org = requireOrg(req.params.orgId);
    const siteId = req.params.siteId;
    if (siteId !== DEMO_SITE_ID) throw new DemoError(404, 'Site not found');
    for (const other of orgs.all()) {
      if (other.id === org.id || !other.sites?.includes(siteId)) continue;
      orgs.update(other.id, { sites: other.sites.filter((id) => id !== siteId) });
      for (const team of teams.find((t) => t.orgId === other.id)) {
        const kept = team.grants.filter((g) => (g.siteId ?? DEMO_SITE_ID) !== siteId);
        if (kept.length !== team.grants.length) teams.update(team.id, { grants: kept });
      }
    }
    if (!org.sites?.includes(siteId))
      orgs.update(org.id, { sites: [...(org.sites ?? []), siteId] });
    recordAudit(`Site ${siteId} assigned to organization ${org.name}`);
    return { message: 'Site assigned' };
  });

  // --- plan ------------------------------------------------------------------------
  r.get('/orgs/:orgId/plan', (req) => {
    const org = requireOrg(req.params.orgId);
    const plan = orgPlans.get(org.id) ?? {
      ...planDefaults(org.id),
      updatedBy: null,
      updatedAt: ago(1),
    };
    return toPlan(plan);
  });
  r.put('/orgs/:orgId/plan', (req) => {
    const org = requireOrg(req.params.orgId);
    const body = (req.body ?? {}) as Partial<OrgPlanLimits>;
    const limits = {} as OrgPlanLimits;
    for (const key of PLAN_KEYS) {
      const value = body[key] ?? 0;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        throw new DemoError(400, `${key} must be a whole number, 0 for unlimited`);
      limits[key] = value;
    }
    const record: PlanRecord = {
      ...limits,
      id: org.id,
      orgId: org.id,
      updatedBy: DEMO_USER_ID,
      updatedAt: Date.now(),
    };
    if (orgPlans.get(org.id)) orgPlans.update(org.id, record);
    else orgPlans.insert(record);
    recordAudit(`Organization plan set for ${org.name}`);
    return toPlan(record);
  });

  // --- teams -----------------------------------------------------------------------
  r.get('/orgs/:orgId/teams', (req) => {
    requireOrg(req.params.orgId);
    return teams
      .find((t) => t.orgId === req.params.orgId)
      .map(toTeam)
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  r.post('/orgs/:orgId/teams', (req) => {
    const org = requireOrg(req.params.orgId);
    const name = String((req.body as { name?: string } | undefined)?.name ?? '').trim();
    if (!name) throw new DemoError(400, 'name is required');
    if (teams.find((t) => t.orgId === org.id && t.name.toLowerCase() === name.toLowerCase()).length)
      throw new DemoError(409, 'A team with this name already exists');
    const team = teams.insert({ id: newId(), orgId: org.id, name, memberIds: [], grants: [] });
    recordAudit(`Team created: ${name}`);
    return toTeam(team);
  });
  r.put('/orgs/:orgId/teams/:teamId', (req) => {
    const team = requireTeam(req.params.orgId, req.params.teamId);
    const name = String((req.body as { name?: string } | undefined)?.name ?? '').trim();
    if (!name) throw new DemoError(400, 'name is required');
    const updated = teams.update(team.id, { name }) as TeamRecord;
    recordAudit(`Team renamed: ${team.name} to ${name}`);
    return toTeam(updated);
  });
  r.delete('/orgs/:orgId/teams/:teamId', (req) => {
    const team = requireTeam(req.params.orgId, req.params.teamId);
    teams.remove(team.id);
    recordAudit(`Team deleted: ${team.name}`);
    return { message: 'Team deleted' };
  });
  r.post('/orgs/:orgId/teams/:teamId/members', (req) => {
    const team = requireTeam(req.params.orgId, req.params.teamId);
    const user = requireUserByEmail((req.body as { email?: string } | undefined)?.email);
    if (!orgMembers.get(`${team.orgId}:${user.id}`))
      throw new DemoError(400, 'Add the user to the organization first');
    if (team.memberIds.includes(user.id)) throw new DemoError(409, 'Already a member of this team');
    teams.update(team.id, { memberIds: [...team.memberIds, user.id] });
    recordAudit(`Team member added: ${user.email}`);
    return { message: 'Team member added' };
  });
  r.delete('/orgs/:orgId/teams/:teamId/members/:userId', (req) => {
    const team = requireTeam(req.params.orgId, req.params.teamId);
    if (!team.memberIds.includes(req.params.userId))
      throw new DemoError(404, 'Team member not found');
    teams.update(team.id, { memberIds: team.memberIds.filter((id) => id !== req.params.userId) });
    recordAudit(
      `Team member removed: ${userIdentity(req.params.userId)?.email ?? req.params.userId}`,
    );
    return { message: 'Team member removed' };
  });
  r.post('/orgs/:orgId/teams/:teamId/grants', (req) => {
    const team = requireTeam(req.params.orgId, req.params.teamId);
    const body = (req.body ?? {}) as { siteId?: string; projectId?: string | null; role?: string };
    const siteId = body.siteId ?? '';
    if (!requireOrg(team.orgId).sites?.includes(siteId))
      throw new DemoError(400, "The Site isn't this organization's");
    const projectId = body.projectId || null;
    const role = body.role ?? '';
    if (projectId) {
      if (!projects.get(projectId)) throw new DemoError(404, 'Project not found');
      if (!['PROJECT_ADMIN', 'PROJECT_MEMBER', 'PROJECT_VIEWER'].includes(role))
        throw new DemoError(
          400,
          'A project role must be PROJECT_ADMIN, PROJECT_MEMBER or PROJECT_VIEWER',
        );
    } else if (!['ADMIN', 'MEMBER', 'VIEWER'].includes(role)) {
      throw new DemoError(400, 'A Site-wide role must be ADMIN, MEMBER or VIEWER');
    }
    if (team.grants.some((g) => (g.siteId ?? DEMO_SITE_ID) === siteId && g.projectId === projectId))
      throw new DemoError(409, 'The team already has a role there');
    const grant = { id: newId(), siteId, projectId, role };
    teams.update(team.id, { grants: [...team.grants, grant] });
    const where = projectId
      ? `project ${projects.get(projectId)?.name ?? projectId}`
      : 'all projects';
    recordAudit(`Team grant added: team ${team.name}, site "${siteId}", ${role} on ${where}`);
    const result: TeamGrant = { ...grant, teamId: team.id };
    return result;
  });
  r.delete('/orgs/:orgId/teams/:teamId/grants/:grantId', (req) => {
    const team = requireTeam(req.params.orgId, req.params.teamId);
    const grant = team.grants.find((g) => g.id === req.params.grantId);
    if (!grant) throw new DemoError(404, 'Team grant not found');
    teams.update(team.id, { grants: team.grants.filter((g) => g.id !== grant.id) });
    recordAudit(
      `Team grant removed: team ${team.name}, site "${grant.siteId ?? DEMO_SITE_ID}", ${grant.role}`,
    );
    return { message: 'Team grant removed' };
  });

  // --- SCIM tokens -------------------------------------------------------------------
  r.get('/orgs/:orgId/scim-tokens', (req) => {
    requireOrg(req.params.orgId);
    return scimTokens
      .find((t) => t.orgId === req.params.orgId)
      .map((t) => ({
        ...t,
        createdAt: isoOf(t.createdAt),
        lastUsedAt: t.lastUsedAt === null ? null : isoOf(t.lastUsedAt),
      }));
  });
  r.post('/orgs/:orgId/scim-tokens', (req) => {
    const org = requireOrg(req.params.orgId);
    const name = String((req.body as { name?: string } | undefined)?.name ?? '').trim();
    if (!name) throw new DemoError(400, 'name is required');
    if (scimTokens.find((t) => t.orgId === org.id).length >= 10)
      throw new DemoError(400, 'an organization has at most 10 SCIM tokens');
    // Obviously fake: "demo" plus random hex, shown once like the real thing.
    const body = `demo${newId().replace(/-/g, '')}notarealtoken`;
    const record = scimTokens.insert({
      id: newId(),
      orgId: org.id,
      name,
      prefix: body.slice(0, 12),
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    recordAudit(`SCIM token created: ${name} for organization ${org.id}`);
    return {
      ...record,
      createdAt: isoOf(record.createdAt),
      lastUsedAt: null,
      token: `obzscim_${body}`,
    };
  });
  r.delete('/orgs/:orgId/scim-tokens/:tokenId', (req) => {
    requireOrg(req.params.orgId);
    const token = scimTokens.get(req.params.tokenId);
    if (!token || token.orgId !== req.params.orgId)
      throw new DemoError(404, 'SCIM token not found');
    scimTokens.remove(token.id);
    recordAudit(`SCIM token revoked: ${token.name}`);
    return { message: 'SCIM token revoked' };
  });
}
