// Everything administrative on the user side: the user list and management,
// invites, MFA setup, SSO connectors, personal access tokens, connected OAuth
// apps, plans, project members, API keys and the audit logs. Sign-in flows
// that need a real identity provider answer "not in the demo".
import type { ApiKey } from '../../entity/api-keys';
import type { ProjectMemberResponse } from '../../entity/projects';
import type {
  AccessToken,
  CreatePlanRequest,
  CreateSSOConnectorRequest,
  OAuthConnectedApp,
  SSOConnector,
  SSOGroupMapping,
  UpdateSSOConnectorRequest,
  UserPlan,
  UserProfile,
} from '../../entity/users';
import { hashString, hex } from '../lib/rng';
import { DemoError, type Router, notInDemo } from '../router';
import { type AuditDirectory, auditQueryFrom, queryAudit, recordAudit } from '../seed/audit';
import {
  DAY,
  HOUR,
  MINUTE,
  PEOPLE,
  type ProjectRoleName,
  type When,
  ago,
  isoOf,
  resolveWhen,
} from '../seed/people';
import { type UserRecord, users } from '../seed/users';
import { collection, newId } from '../store';
import { DEMO_TOKEN, DEMO_USER_ID, PROJECT_ID, STAGING_PROJECT_ID } from '../world';
import { currentUser, projects, requireProject } from './bootstrap';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export { type UserRecord, users };

export const userByEmail = (email: string) => {
  const needle = email.trim().toLowerCase();
  return users.all().find((u) => u.email.toLowerCase() === needle);
};

/** A user's current name and email (the signed-in user's may be edited in Profile). */
export function userIdentity(id: string): { name: string; email: string } | undefined {
  if (id === DEMO_USER_ID) {
    const me = currentUser();
    return { name: me.name, email: me.email };
  }
  const user = users.get(id);
  return user && { name: user.name, email: user.email };
}

export function toProfile(u: UserRecord, now = Date.now()): UserProfile {
  const identity = userIdentity(u.id) ?? u;
  return {
    id: u.id,
    name: identity.name,
    email: identity.email,
    role: u.role as UserProfile['role'],
    isActive: u.isActive,
    createdAt: isoOf(u.createdAt, now) as unknown as Date,
    lastLoginAt: u.lastLoginAt === null ? null : isoOf(u.lastLoginAt, now),
    lastActiveAt: u.lastActiveAt === null ? null : isoOf(u.lastActiveAt, now),
    mfaEnabled: u.mfaEnabled,
    isRootAdmin: u.isRootAdmin,
  };
}

function requireUser(id: string) {
  const user = users.get(id);
  if (!user) throw new DemoError(404, 'User not found');
  return user;
}

const auditDirectory: AuditDirectory = {
  user: userIdentity,
  project: (id) => projects.get(id)?.name,
};

const fakeToken = (kind: string) =>
  `obz_demo_${kind ? `${kind}_` : ''}${newId().replace(/-/g, '')}`;
const prefixOf = (token: string, kind: string) =>
  `${token.slice(0, 'obz_demo_'.length + (kind ? kind.length + 1 : 0) + 6)}...`;

const validEmail = (email: unknown): string => {
  const value = typeof email === 'string' ? email.trim() : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))
    throw new DemoError(400, 'A valid email is required');
  return value.toLowerCase();
};

function inviteUser(email: string): UserRecord {
  const user: UserRecord = {
    id: newId(),
    name: email
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    email,
    role: 'MEMBER',
    isActive: true,
    createdAt: Date.now(),
    lastLoginAt: null,
    lastActiveAt: null,
    mfaEnabled: false,
  };
  users.insert(user);
  return user;
}

// ---------------------------------------------------------------------------
// Project memberships
// ---------------------------------------------------------------------------

interface MembershipRecord {
  id: string;
  userId: string;
  projectId: string;
  role: ProjectRoleName;
  createdAt: When;
}

const memberships = collection<MembershipRecord>('projectMemberships', () =>
  PEOPLE.flatMap((p) =>
    p.projects.map((m) => ({
      id: `m-${hashString(`${p.id}:${m.projectId}`).toString(16)}`,
      userId: p.id,
      projectId: m.projectId,
      role: m.role,
      createdAt: m.since,
    })),
  ),
);

/** A project's members; a project the visitor created has them as its owner. */
function projectMembers(projectId: string): MembershipRecord[] {
  const mine = memberships.find((m) => m.projectId === projectId);
  if (mine.length) return mine;
  const project = projects.get(projectId);
  return [
    {
      id: `m-owner-${projectId}`,
      userId: DEMO_USER_ID,
      projectId,
      role: 'OWNER',
      createdAt: project ? Date.parse(String(project.createdAt)) || Date.now() : Date.now(),
    },
  ];
}

/** Writes a project's member list, materializing the implicit owner first. */
function ensureMemberships(projectId: string) {
  if (memberships.find((m) => m.projectId === projectId).length) return;
  for (const m of projectMembers(projectId)) memberships.insert(m);
}

const PROJECT_ROLES: ProjectRoleName[] = ['PROJECT_ADMIN', 'PROJECT_MEMBER', 'PROJECT_VIEWER'];

function projectRole(value: unknown): ProjectRoleName {
  if (!PROJECT_ROLES.includes(value as ProjectRoleName))
    throw new DemoError(400, 'role must be PROJECT_ADMIN, PROJECT_MEMBER or PROJECT_VIEWER');
  return value as ProjectRoleName;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

interface ApiKeyRecord {
  id: string;
  name: string;
  projectId: string;
  tokenPrefix: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: When;
  lastUsedAt: When | null;
}

const keySeed = (
  key: string,
  projectId: string,
  name: string,
  status: ApiKeyRecord['status'],
  createdAgo: number,
  usedAgo: number | null,
): ApiKeyRecord => ({
  id: `key-${hashString(key).toString(16)}`,
  name,
  projectId,
  tokenPrefix: `obz_demo_${hex(hashString(key), 4)}...`,
  status,
  createdAt: ago(createdAgo),
  lastUsedAt: usedAgo === null ? null : ago(usedAgo),
});

const apiKeys = collection<ApiKeyRecord>('apiKeys', () => [
  keySeed(
    'prod-collector',
    PROJECT_ID,
    'otel-collector (harborline-prod)',
    'ACTIVE',
    95 * DAY,
    2 * MINUTE,
  ),
  keySeed('batch-export', PROJECT_ID, 'batch-01 nightly export', 'ACTIVE', 12 * DAY, 22 * HOUR),
  keySeed('probe', PROJECT_ID, 'synthetics probe (eu-west)', 'ACTIVE', 30 * DAY, MINUTE),
  keySeed('legacy-fluentbit', PROJECT_ID, 'legacy fluent-bit', 'DISABLED', 90 * DAY, 41 * DAY),
  keySeed(
    'staging-collector',
    STAGING_PROJECT_ID,
    'staging collector',
    'ACTIVE',
    2 * DAY,
    4 * MINUTE,
  ),
]);

const toApiKey = (k: ApiKeyRecord, now = Date.now()) =>
  ({
    id: k.id,
    name: k.name,
    projectId: k.projectId,
    tokenPrefix: k.tokenPrefix,
    status: k.status,
    createdAt: isoOf(k.createdAt, now),
    lastUsedAt: k.lastUsedAt === null ? null : isoOf(k.lastUsedAt, now),
  }) as unknown as ApiKey;

function requireKey(projectId: string, id: string) {
  const key = apiKeys.get(id);
  if (!key || key.projectId !== projectId) throw new DemoError(404, 'API key not found');
  return key;
}

// ---------------------------------------------------------------------------
// Access tokens, OAuth apps, MFA, SSO, plans
// ---------------------------------------------------------------------------

interface AccessTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: When;
  /** Valid for this long after createdAt, ms. */
  validFor: number;
  lastUsedAt: When | null;
}

const tokenSeed = (
  key: string,
  name: string,
  createdAgo: number,
  days: number,
  usedAgo: number | null,
): AccessTokenRecord => ({
  id: `pat-${hashString(key).toString(16)}`,
  userId: DEMO_USER_ID,
  name,
  tokenPrefix: `obz_demo_pat_${hex(hashString(key), 6)}...`,
  scopes: ['mcp:read'],
  createdAt: ago(createdAgo),
  validFor: days * DAY,
  lastUsedAt: usedAgo === null ? null : ago(usedAgo),
});

const accessTokens = collection<AccessTokenRecord>('accessTokens', () => [
  tokenSeed('claude-code', 'Claude Code MCP (laptop)', 21 * DAY, 90, 35 * MINUTE),
  tokenSeed('ci-runbooks', 'Runbook automation', 48 * DAY, 365, 3 * HOUR),
]);

const toAccessToken = (t: AccessTokenRecord, now = Date.now()): AccessToken => ({
  id: t.id,
  name: t.name,
  tokenPrefix: t.tokenPrefix,
  scopes: t.scopes,
  createdAt: isoOf(t.createdAt, now),
  expiresAt: new Date(resolveWhen(t.createdAt, now) + t.validFor).toISOString(),
  lastUsedAt: t.lastUsedAt === null ? null : isoOf(t.lastUsedAt, now),
});

interface OAuthAppRecord {
  id: string;
  clientName: string;
  clientId: string;
  lastUsedAt: When;
  /** ms from now (positive: future). */
  expiresIn: number;
}

const oauthApps = collection<OAuthAppRecord>('oauthApps', () => [
  {
    id: 'oauth-claude-desktop',
    clientName: 'Claude Desktop (MCP)',
    clientId: 'demo-client-claude-desktop',
    lastUsedAt: ago(25 * MINUTE),
    expiresIn: 52 * DAY,
  },
  {
    id: 'oauth-ops-bot',
    clientName: 'Harborline ops bot',
    clientId: 'demo-client-harborline-ops-bot',
    lastUsedAt: ago(2 * DAY + 4 * HOUR),
    expiresIn: 18 * DAY,
  },
]);

const MFA_SECRET = 'DEMODEMODEMODEMONOTASECRET234567';
const mfaSetup = () => ({
  secret: MFA_SECRET,
  otpAuthUrl: `otpauth://totp/Obzly%20demo:${encodeURIComponent(currentUser().email)}?secret=${MFA_SECRET}&issuer=Obzly%20demo`,
});
const requireCode = (body: unknown) => {
  const code = String((body as { code?: string } | undefined)?.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw new DemoError(400, 'Enter the 6-digit code from your app');
};

type SSORecord = Omit<SSOConnector, 'createdAt' | 'updatedAt'> & {
  createdAt: When;
  updatedAt: When;
};

const ssoConnectors = collection<SSORecord>('ssoConnectors', () => [
  {
    id: 'sso-harborline-identity',
    name: 'Harborline Identity',
    providerType: 'generic_oidc' as SSOConnector['providerType'],
    issuerUrl: 'https://id.harborline.example.com',
    clientId: 'obzly-demo-client',
    hasClientSecret: true,
    scopes: 'openid email profile groups',
    groupsClaim: 'groups',
    requireVerifiedEmail: true,
    trustIdpMfa: true,
    buttonLabel: 'Sign in with Harborline Identity',
    enabled: true,
    createdAt: ago(60 * DAY),
    updatedAt: ago(9 * DAY + 2 * HOUR),
  },
]);

const toConnector = (c: SSORecord): SSOConnector => ({
  ...c,
  createdAt: isoOf(c.createdAt),
  updatedAt: isoOf(c.updatedAt),
});

type MappingRecord = Omit<SSOGroupMapping, 'createdAt'> & { createdAt: When };

const ssoMappings = collection<MappingRecord>('ssoGroupMappings', () => [
  {
    id: 'map-platform',
    connectorId: 'sso-harborline-identity',
    groupName: 'obzly-admins',
    projectId: null,
    role: 'ADMIN',
    createdAt: ago(60 * DAY),
  },
  {
    id: 'map-shop',
    connectorId: 'sso-harborline-identity',
    groupName: 'shop-engineering',
    projectId: PROJECT_ID,
    role: 'PROJECT_MEMBER',
    createdAt: ago(58 * DAY),
  },
  {
    id: 'map-support',
    connectorId: 'sso-harborline-identity',
    groupName: 'customer-support',
    projectId: PROJECT_ID,
    role: 'PROJECT_VIEWER',
    createdAt: ago(39 * DAY),
  },
]);

function connectorFields(body: unknown, existing?: SSORecord) {
  const b = (body ?? {}) as Partial<CreateSSOConnectorRequest & UpdateSSOConnectorRequest>;
  const name = (b.name ?? '').trim();
  if (!name) throw new DemoError(400, 'name is required');
  const issuerUrl = (b.issuerUrl ?? '').trim();
  if (!/^https:\/\//.test(issuerUrl)) throw new DemoError(400, 'issuerUrl must be an https URL');
  if (!(b.clientId ?? '').trim()) throw new DemoError(400, 'clientId is required');
  const hasSecret = !!b.clientSecret?.trim() || !!existing?.hasClientSecret;
  if (!hasSecret) throw new DemoError(400, 'clientSecret is required');
  return {
    name,
    providerType: (b.providerType ?? 'generic_oidc') as SSOConnector['providerType'],
    issuerUrl,
    clientId: (b.clientId ?? '').trim(),
    // The secret itself is never kept, not even in this browser.
    hasClientSecret: true,
    scopes: b.scopes?.trim() || 'openid email profile',
    groupsClaim: b.groupsClaim?.trim() ?? '',
    requireVerifiedEmail: b.requireVerifiedEmail ?? true,
    trustIdpMfa: !!b.trustIdpMfa,
    buttonLabel: b.buttonLabel?.trim() || `Sign in with ${name}`,
    enabled: b.enabled ?? true,
  };
}

function requireConnector(id: string) {
  const connector = ssoConnectors.get(id);
  if (!connector) throw new DemoError(404, 'SSO connector not found');
  return connector;
}

const plans = collection<UserPlan>('userPlans', () => [
  {
    id: 'plan-default',
    name: 'Default',
    type: 'DEFAULT' as UserPlan['type'],
    isPublic: true,
    allowedProjectsCount: 3,
    warningText: '',
    upgradeText: 'Ask a Harborline platform admin for the Extended plan.',
    logsPerSecondLimit: 1000,
    maxLogsAmount: 0,
    maxLogsSizeMb: 0,
    maxLogsLifeDays: 30,
    maxLogSizeKb: 64,
  },
  {
    id: 'plan-extended',
    name: 'Extended',
    type: 'EXTENDED' as UserPlan['type'],
    isPublic: false,
    allowedProjectsCount: 20,
    warningText: '',
    upgradeText: '',
    logsPerSecondLimit: 10000,
    maxLogsAmount: 0,
    maxLogsSizeMb: 0,
    maxLogsLifeDays: 90,
    maxLogSizeKb: 256,
  },
]);

const PLAN_NUMBERS = [
  'allowedProjectsCount',
  'logsPerSecondLimit',
  'maxLogsAmount',
  'maxLogsSizeMb',
  'maxLogsLifeDays',
  'maxLogSizeKb',
] as const;

function planFields(body: unknown, partial: boolean): Partial<UserPlan> {
  const b = (body ?? {}) as Partial<CreatePlanRequest>;
  const out: Partial<UserPlan> = {};
  if (b.name !== undefined || !partial) {
    const name = (b.name ?? '').trim();
    if (!name) throw new DemoError(400, 'name is required');
    out.name = name;
  }
  if (b.type !== undefined) out.type = b.type as unknown as UserPlan['type'];
  if (b.isPublic !== undefined) out.isPublic = b.isPublic;
  if (b.warningText !== undefined) out.warningText = b.warningText;
  if (b.upgradeText !== undefined) out.upgradeText = b.upgradeText;
  for (const key of PLAN_NUMBERS) {
    const value = b[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || value < 0)
      throw new DemoError(400, `${key} must be 0 or more`);
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function register(r: Router) {
  registerUsers(r);
  registerIdentity(r);
  registerProjectAdmin(r);
  registerAuditLogs(r);
}

function registerUsers(r: Router) {
  r.get('/users', (req) => {
    const now = Date.now();
    const query = (req.query.get('query') ?? '').trim().toLowerCase();
    const before = req.query.get('beforeDate')
      ? Date.parse(req.query.get('beforeDate') as string)
      : NaN;
    const limit = Math.min(Math.max(Number(req.query.get('limit')) || 20, 1), 200);
    const offset = Math.max(Number(req.query.get('offset')) || 0, 0);
    const list = users
      .all()
      .map((u) => toProfile(u, now))
      .filter(
        (u) =>
          (!query ||
            u.name.toLowerCase().includes(query) ||
            u.email.toLowerCase().includes(query)) &&
          (!Number.isFinite(before) || Date.parse(String(u.createdAt)) < before),
      )
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { users: list.slice(offset, offset + limit), total: list.length };
  });
  r.get('/users/:userId', (req) => toProfile(requireUser(req.params.userId)));
  r.post('/users/invite', (req) => {
    const body = (req.body ?? {}) as {
      email?: string;
      intendedProjectId?: string;
      intendedProjectRole?: string;
    };
    const email = validEmail(body.email);
    if (userByEmail(email)) throw new DemoError(409, 'A user with this email already exists');
    if (body.intendedProjectId) requireProject(body.intendedProjectId);
    const user = inviteUser(email);
    if (body.intendedProjectId) {
      ensureMemberships(body.intendedProjectId);
      memberships.insert({
        id: newId(),
        userId: user.id,
        projectId: body.intendedProjectId,
        role: body.intendedProjectRole ? projectRole(body.intendedProjectRole) : 'PROJECT_MEMBER',
        createdAt: Date.now(),
      });
    }
    recordAudit(`User invited: ${email}`, body.intendedProjectId);
    return {
      id: user.id,
      email,
      intendedProjectId: body.intendedProjectId,
      intendedProjectRole: body.intendedProjectRole,
      createdAt: isoOf(user.createdAt),
      // No email is sent by Obzly either: the inviter relays this link.
      inviteToken: fakeToken('invite'),
    };
  });
  r.post('/users/:userId/deactivate', (req) => {
    const user = requireUser(req.params.userId);
    if (user.id === DEMO_USER_ID) throw new DemoError(400, "You can't deactivate yourself");
    if (user.isRootAdmin) throw new DemoError(400, "The root admin can't be deactivated");
    users.update(user.id, { isActive: false });
    recordAudit(`User deactivated: ${user.email}`);
    return { message: 'User deactivated' };
  });
  r.post('/users/:userId/activate', (req) => {
    const user = requireUser(req.params.userId);
    users.update(user.id, { isActive: true });
    recordAudit(`User activated: ${user.email}`);
    return { message: 'User activated' };
  });
  r.delete('/users/:userId', (req) => {
    const user = requireUser(req.params.userId);
    if (user.id === DEMO_USER_ID) throw new DemoError(400, "You can't delete yourself");
    if (user.isRootAdmin) throw new DemoError(400, "The root admin can't be deleted");
    users.remove(user.id);
    memberships.replaceAll(memberships.all().filter((m) => m.userId !== user.id));
    recordAudit(`User deleted: ${user.email}`);
    return { message: 'User deleted' };
  });
  r.put('/users/:userId/role', (req) => {
    const user = requireUser(req.params.userId);
    const role = (req.body as { role?: string } | undefined)?.role;
    if (role !== 'ADMIN' && role !== 'MEMBER')
      throw new DemoError(400, 'role must be ADMIN or MEMBER');
    if (user.id === DEMO_USER_ID) throw new DemoError(400, "You can't change your own role");
    users.update(user.id, { role });
    recordAudit(`User role changed: ${user.email} from ${user.role} to ${role}`);
    return { message: 'User role changed' };
  });
  r.post('/users/:userId/set-password', (req) => {
    const user = requireUser(req.params.userId);
    const password = String((req.body as { password?: string } | undefined)?.password ?? '');
    if (password.length < 8) throw new DemoError(400, 'Password must be at least 8 characters');
    recordAudit(`User password set by admin: ${user.email}`);
    return { message: 'Password set (demo: nothing was stored)' };
  });
  r.post('/users/:userId/reset-mfa', (req) => {
    const user = requireUser(req.params.userId);
    users.update(user.id, { mfaEnabled: false });
    recordAudit(`MFA reset for ${user.email}`);
    return { message: 'MFA reset' };
  });
}

function registerIdentity(r: Router) {
  // --- sign-in flows that need a real provider or server ----------------------
  r.post('/users/signup', () => notInDemo('Signing up'));
  r.post('/users/admin/set-password', () => ({
    message: 'Password set (demo: nothing was stored)',
  }));
  r.get('/auth/oauth/state', () => notInDemo('GitHub and Google sign-in'));
  r.post('/auth/github/callback', () => notInDemo('GitHub sign-in'));
  r.post('/auth/google/callback', () => notInDemo('Google sign-in'));
  r.get('/auth/sso/connectors', () => ({ connectors: [] }));
  r.post('/auth/sso/callback', () => notInDemo('SSO sign-in'));
  r.post('/oauth/authorize/validate', () => notInDemo('Authorizing an OAuth app'));
  r.post('/oauth/authorize/decision', () => notInDemo('Authorizing an OAuth app'));

  // --- MFA -----------------------------------------------------------------
  r.post('/users/mfa/setup', () => mfaSetup());
  r.post('/users/mfa/enable', (req) => {
    requireCode(req.body);
    users.update(DEMO_USER_ID, { mfaEnabled: true });
    recordAudit('MFA enabled');
    return { message: 'MFA enabled' };
  });
  r.post('/users/mfa/disable', (req) => {
    requireCode(req.body);
    users.update(DEMO_USER_ID, { mfaEnabled: false });
    recordAudit('MFA disabled');
    return { message: 'MFA disabled' };
  });
  r.post('/users/mfa/login-setup', () => mfaSetup());
  r.post('/users/mfa/login-enable', (req) => {
    requireCode(req.body);
    return { token: DEMO_TOKEN, userId: DEMO_USER_ID, email: currentUser().email };
  });
  r.post('/users/mfa/login-verify', (req) => {
    requireCode(req.body);
    return { token: DEMO_TOKEN, userId: DEMO_USER_ID, email: currentUser().email };
  });

  // --- personal access tokens ---------------------------------------------------
  r.get('/access-tokens', () => {
    const now = Date.now();
    return {
      accessTokens: accessTokens
        .find((t) => t.userId === DEMO_USER_ID)
        .sort((a, b) => resolveWhen(b.createdAt, now) - resolveWhen(a.createdAt, now))
        .map((t) => toAccessToken(t, now)),
    };
  });
  r.post('/access-tokens', (req) => {
    const body = (req.body ?? {}) as { name?: string; expiresInDays?: number };
    const name = (body.name ?? '').trim();
    if (!name) throw new DemoError(400, 'name is required');
    if (![30, 90, 365].includes(Number(body.expiresInDays)))
      throw new DemoError(400, 'expiresInDays must be 30, 90 or 365');
    if (accessTokens.find((t) => t.userId === DEMO_USER_ID).length >= 20)
      throw new DemoError(400, 'You have the maximum of 20 access tokens');
    const token = fakeToken('pat');
    const now = Date.now();
    const record = accessTokens.insert({
      id: newId(),
      userId: DEMO_USER_ID,
      name,
      tokenPrefix: prefixOf(token, 'pat'),
      scopes: ['mcp:read'],
      createdAt: now,
      validFor: Number(body.expiresInDays) * DAY,
      lastUsedAt: null,
    });
    recordAudit(`Access token created: ${name} (${record.tokenPrefix})`);
    return { token, accessToken: toAccessToken(record, now) };
  });
  r.delete('/access-tokens/:id', (req) => {
    const token = accessTokens.get(req.params.id);
    if (!token || token.userId !== DEMO_USER_ID) throw new DemoError(404, 'Access token not found');
    accessTokens.remove(token.id);
    recordAudit(`Access token revoked: ${token.id}`);
    return { message: 'Access token revoked' };
  });

  // --- connected OAuth apps ------------------------------------------------------
  r.get('/oauth/connected-apps', () => {
    const now = Date.now();
    const apps: OAuthConnectedApp[] = oauthApps.all().map((a) => ({
      id: a.id,
      clientName: a.clientName,
      clientId: a.clientId,
      lastUsedAt: isoOf(a.lastUsedAt, now),
      expiresAt: new Date(now + a.expiresIn).toISOString(),
    }));
    return { apps };
  });
  r.delete('/oauth/connected-apps/:id', (req) => {
    const app = oauthApps.get(req.params.id);
    if (!app) throw new DemoError(404, 'Connected app not found');
    oauthApps.remove(app.id);
    recordAudit(`OAuth app access revoked: ${app.clientName}`);
    return { message: 'Access revoked' };
  });

  // --- SSO connectors ---------------------------------------------------------
  r.get('/sso/connectors', () => ({ connectors: ssoConnectors.all().map(toConnector) }));
  r.post('/sso/connectors', (req) => {
    const now = Date.now();
    const connector = ssoConnectors.insert({
      ...connectorFields(req.body),
      id: newId(),
      createdAt: now,
      updatedAt: now,
    });
    recordAudit(`SSO connector created: ${connector.name} (${connector.providerType})`);
    return toConnector(connector);
  });
  r.put('/sso/connectors/:connectorId', (req) => {
    const existing = requireConnector(req.params.connectorId);
    const updated = ssoConnectors.update(existing.id, {
      ...connectorFields(req.body, existing),
      updatedAt: Date.now(),
    }) as SSORecord;
    recordAudit(`SSO connector updated: ${updated.name} (${updated.providerType})`);
    return toConnector(updated);
  });
  r.delete('/sso/connectors/:connectorId', (req) => {
    const existing = requireConnector(req.params.connectorId);
    ssoConnectors.remove(existing.id);
    ssoMappings.replaceAll(ssoMappings.all().filter((m) => m.connectorId !== existing.id));
    recordAudit(`SSO connector deleted: ${existing.name} (${existing.providerType})`);
    return { message: 'SSO connector deleted' };
  });
  r.get('/sso/connectors/:connectorId/group-mappings', (req) => {
    requireConnector(req.params.connectorId);
    return {
      mappings: ssoMappings
        .find((m) => m.connectorId === req.params.connectorId)
        .map((m) => ({ ...m, createdAt: isoOf(m.createdAt) })),
    };
  });
  r.post('/sso/connectors/:connectorId/group-mappings', (req) => {
    requireConnector(req.params.connectorId);
    const body = (req.body ?? {}) as {
      groupName?: string;
      projectId?: string | null;
      role?: string;
    };
    const groupName = (body.groupName ?? '').trim();
    if (!groupName) throw new DemoError(400, 'groupName is required');
    const projectId = body.projectId || null;
    if (projectId) {
      requireProject(projectId);
      projectRole(body.role);
    } else if (body.role !== 'ADMIN') {
      throw new DemoError(400, 'Without a project the role must be ADMIN');
    }
    const mapping = ssoMappings.insert({
      id: newId(),
      connectorId: req.params.connectorId,
      groupName,
      projectId,
      role: body.role as string,
      createdAt: Date.now(),
    });
    recordAudit(`SSO group mapping created: ${groupName} → ${projectId ? body.role : 'ADMIN'}`);
    return { ...mapping, createdAt: isoOf(mapping.createdAt) };
  });
  r.delete('/sso/connectors/:connectorId/group-mappings/:mappingId', (req) => {
    const mapping = ssoMappings.get(req.params.mappingId);
    if (!mapping || mapping.connectorId !== req.params.connectorId)
      throw new DemoError(404, 'Group mapping not found');
    ssoMappings.remove(mapping.id);
    recordAudit('SSO group mapping deleted');
    return { message: 'Group mapping deleted' };
  });

  // --- plans -------------------------------------------------------------------
  r.get('/plans', () => plans.all());
  r.post('/plans', (req) => {
    const fields = planFields(req.body, false);
    const plan = plans.insert({
      id: newId(),
      type: 'DEFAULT' as UserPlan['type'],
      isPublic: false,
      allowedProjectsCount: 3,
      warningText: '',
      upgradeText: '',
      logsPerSecondLimit: 0,
      maxLogsAmount: 0,
      maxLogsSizeMb: 0,
      maxLogsLifeDays: 0,
      maxLogSizeKb: 0,
      ...fields,
      name: fields.name as string,
    });
    recordAudit(`Plan created: ${plan.name} (type: ${plan.type})`);
    return plan;
  });
  r.put('/plans/:planId', (req) => {
    if (!plans.get(req.params.planId)) throw new DemoError(404, 'Plan not found');
    const plan = plans.update(req.params.planId, planFields(req.body, true)) as UserPlan;
    recordAudit(`Plan updated: ${plan.name}`);
    return plan;
  });
  r.delete('/plans/:planId', (req) => {
    const plan = plans.get(req.params.planId);
    if (!plan) throw new DemoError(404, 'Plan not found');
    if (
      plan.type === ('DEFAULT' as UserPlan['type']) &&
      plans.all().filter((p) => p.type === plan.type).length === 1
    )
      throw new DemoError(400, "The only default plan can't be deleted");
    plans.remove(plan.id);
    recordAudit(`Plan deleted: ${plan.name}`);
    return { message: 'Plan deleted' };
  });
}

function registerProjectAdmin(r: Router) {
  // --- members ---------------------------------------------------------------
  r.get('/projects/memberships/:projectId/members', (req) => {
    requireProject(req.params.projectId);
    const now = Date.now();
    const members: ProjectMemberResponse[] = projectMembers(req.params.projectId)
      .map((m) => {
        const identity = userIdentity(m.userId);
        return {
          id: m.id,
          userId: m.userId,
          email: identity?.email ?? '',
          name: identity?.name ?? '',
          role: m.role as ProjectMemberResponse['role'],
          createdAt: isoOf(m.createdAt, now) as unknown as Date,
        };
      })
      .filter((m) => m.email);
    return { members };
  });
  r.post('/projects/memberships/:projectId/members', (req) => {
    const project = requireProject(req.params.projectId);
    const body = (req.body ?? {}) as { email?: string; role?: string };
    const email = validEmail(body.email);
    const role = projectRole(body.role);
    ensureMemberships(project.id);
    const existing = userByEmail(email);
    if (
      existing &&
      memberships.find((m) => m.projectId === project.id && m.userId === existing.id).length
    )
      throw new DemoError(409, 'This user is already a member of the project');
    const user = existing ?? inviteUser(email);
    memberships.insert({
      id: newId(),
      userId: user.id,
      projectId: project.id,
      role,
      createdAt: Date.now(),
    });
    if (existing) {
      recordAudit(`User added to project: ${email} as ${role}`, project.id);
      return { status: 'ADDED' };
    }
    recordAudit(`User invited to project: ${email} and added as ${role}`, project.id);
    return { status: 'INVITED', inviteToken: fakeToken('invite') };
  });
  r.put('/projects/memberships/:projectId/members/:userId/role', (req) => {
    requireProject(req.params.projectId);
    ensureMemberships(req.params.projectId);
    const role = projectRole((req.body as { role?: string } | undefined)?.role);
    const membership = memberships.find(
      (m) => m.projectId === req.params.projectId && m.userId === req.params.userId,
    )[0];
    if (!membership) throw new DemoError(404, 'Member not found');
    if (membership.role === 'OWNER')
      throw new DemoError(400, "The owner's role can't be changed: transfer ownership instead");
    memberships.update(membership.id, { role });
    const email = userIdentity(membership.userId)?.email ?? membership.userId;
    recordAudit(
      `Member role changed: ${email} from ${membership.role} to ${role}`,
      req.params.projectId,
    );
    return { message: 'Member role changed' };
  });
  r.delete('/projects/memberships/:projectId/members/:userId', (req) => {
    requireProject(req.params.projectId);
    ensureMemberships(req.params.projectId);
    const membership = memberships.find(
      (m) => m.projectId === req.params.projectId && m.userId === req.params.userId,
    )[0];
    if (!membership) throw new DemoError(404, 'Member not found');
    if (membership.role === 'OWNER') throw new DemoError(400, "The project owner can't be removed");
    memberships.remove(membership.id);
    const email = userIdentity(membership.userId)?.email ?? membership.userId;
    recordAudit(`Member removed from project: ${email}`, req.params.projectId);
    return { message: 'Member removed' };
  });
  r.post('/projects/memberships/:projectId/transfer-ownership', (req) => {
    const project = requireProject(req.params.projectId);
    ensureMemberships(project.id);
    const email = validEmail((req.body as { newOwnerEmail?: string } | undefined)?.newOwnerEmail);
    const target = userByEmail(email);
    const members = memberships.find((m) => m.projectId === project.id);
    const next = target && members.find((m) => m.userId === target.id);
    if (!next) throw new DemoError(400, 'The new owner must already be a member of the project');
    for (const m of members)
      if (m.role === 'OWNER') memberships.update(m.id, { role: 'PROJECT_ADMIN' });
    memberships.update(next.id, { role: 'OWNER' });
    recordAudit(`Project ownership transferred to: ${email}`, project.id);
    return { message: 'Ownership transferred' };
  });

  // --- API keys ----------------------------------------------------------------
  r.get('/projects/api-keys/:projectId', (req) => {
    requireProject(req.params.projectId);
    const now = Date.now();
    return {
      apiKeys: apiKeys
        .find((k) => k.projectId === req.params.projectId)
        .sort((a, b) => resolveWhen(b.createdAt, now) - resolveWhen(a.createdAt, now))
        .map((k) => toApiKey(k, now)),
    };
  });
  r.post('/projects/api-keys/:projectId', (req) => {
    const project = requireProject(req.params.projectId);
    const name = String((req.body as { name?: string } | undefined)?.name ?? '').trim();
    if (!name) throw new DemoError(400, 'name is required');
    const token = fakeToken('');
    const record = apiKeys.insert({
      id: newId(),
      name,
      projectId: project.id,
      tokenPrefix: prefixOf(token, ''),
      status: 'ACTIVE',
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    recordAudit(`API key created: ${name} (${record.tokenPrefix})`, project.id);
    return { ...toApiKey(record), token };
  });
  r.put('/projects/api-keys/:projectId/:apiKeyId', (req) => {
    const key = requireKey(req.params.projectId, req.params.apiKeyId);
    const body = (req.body ?? {}) as { name?: string; status?: string };
    const patch: Partial<ApiKeyRecord> = {};
    if (body.name !== undefined) {
      if (!body.name.trim()) throw new DemoError(400, 'name is required');
      patch.name = body.name.trim();
    }
    if (body.status !== undefined) {
      if (body.status !== 'ACTIVE' && body.status !== 'DISABLED')
        throw new DemoError(400, 'status must be ACTIVE or DISABLED');
      patch.status = body.status;
    }
    const updated = apiKeys.update(key.id, patch) as ApiKeyRecord;
    recordAudit(`API key updated: ${updated.name} (${updated.tokenPrefix})`, req.params.projectId);
    return { message: 'API key updated successfully' };
  });
  r.delete('/projects/api-keys/:projectId/:apiKeyId', (req) => {
    const key = requireKey(req.params.projectId, req.params.apiKeyId);
    apiKeys.remove(key.id);
    recordAudit(`API key deleted: ${key.name} (${key.tokenPrefix})`, req.params.projectId);
    return { message: 'API key deleted successfully' };
  });
  r.post('/projects/api-keys/:projectId/bulk-delete', (req) => {
    requireProject(req.params.projectId);
    const ids = ((req.body as { apiKeyIds?: string[] } | undefined)?.apiKeyIds ?? []).filter(
      Boolean,
    );
    const found = ids.map((id) => apiKeys.get(id)).filter((k): k is ApiKeyRecord => !!k);
    if (found.some((k) => k.projectId !== req.params.projectId))
      throw new DemoError(400, 'API key does not belong to this project');
    for (const key of found) apiKeys.remove(key.id);
    if (found.length)
      recordAudit(`${found.length} inactive API key(s) bulk-deleted`, req.params.projectId);
    return { deletedCount: found.length };
  });
  r.post('/projects/api-keys/:projectId/verify', (req) => {
    requireProject(req.params.projectId);
    const token = String((req.body as { token?: string } | undefined)?.token ?? '').trim();
    const key = apiKeys
      .find((k) => k.projectId === req.params.projectId && k.status === 'ACTIVE')
      .find((k) => token.startsWith(k.tokenPrefix.replace(/\.\.\.$/, '')));
    return key ? { isValid: true, apiKeyId: key.id } : { isValid: false };
  });
}

function registerAuditLogs(r: Router) {
  r.get('/audit-logs/global', (req) =>
    queryAudit(() => true, auditQueryFrom(req.query), auditDirectory),
  );
  r.get('/audit-logs/users/:userId', (req) => {
    requireUser(req.params.userId);
    return queryAudit(
      (record) => record.userId === req.params.userId,
      auditQueryFrom(req.query),
      auditDirectory,
    );
  });
  r.get('/projects/:projectId/audit-logs', (req) => {
    requireProject(req.params.projectId);
    return queryAudit(
      (record) => record.projectId === req.params.projectId,
      auditQueryFrom(req.query),
      auditDirectory,
    );
  });
}
