import { beforeEach, describe, expect, it } from 'vitest';

import type { SettingsChannel, SettingsSync } from '../../entity/alerting';
import type { ApiKey } from '../../entity/api-keys';
import type { GetAuditLogsResponse } from '../../entity/audit-logs';
import type { GetMembersResponse } from '../../entity/projects';
import type {
  AccessToken,
  CreateAccessTokenResponse,
  InviteUserResponse,
  ListUsersResponse,
  OAuthConnectedApp,
  SSOConnector,
  SignInResponse,
  UserProfile,
} from '../../entity/users';
import { DemoError } from '../router';
import { PERSON } from '../seed/people';
import { DEMO_SITE_ID } from '../seed/site';
import { resetDemo } from '../store';
import { DEMO_USER_ID, PROJECT_ID } from '../world';
import { register } from './admin';
import { call, routerWith } from './admin.testkit';
import { register as alerting } from './alerting';
import { register as bootstrap } from './bootstrap';

const router = routerWith(bootstrap, register);

const rejects = async (promise: Promise<unknown>, status: number) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DemoError);
  expect((error as DemoError).status).toBe(status);
};

describe('demo admin area', () => {
  beforeEach(() => resetDemo());

  it('lists, searches and pages users', async () => {
    const all = await call<ListUsersResponse>(router, 'GET', '/users?limit=50');
    expect(all.total).toBe(9);
    expect(all.users.every((u) => u.email.endsWith('@harborline.example.com'))).toBe(true);
    expect(all.users.find((u) => u.id === PERSON.grace.id)?.lastLoginAt).toBeNull();
    const page = await call<ListUsersResponse>(router, 'GET', '/users?limit=3&offset=3');
    expect(page.users).toHaveLength(3);
    const found = await call<ListUsersResponse>(router, 'GET', '/users?query=marcus');
    expect(found.users.map((u) => u.name)).toEqual(['Marcus Webb']);
    // /users/me stays bootstrap's.
    const me = await call<UserProfile>(router, 'GET', '/users/me');
    expect(me.id).toBe(DEMO_USER_ID);
  });

  it('manages users and records it in the audit log', async () => {
    const id = PERSON.sofia.id;
    await call(router, 'PUT', `/users/${id}/role`, { role: 'ADMIN' });
    await call(router, 'POST', `/users/${id}/deactivate`);
    const sofia = await call<UserProfile>(router, 'GET', `/users/${id}`);
    expect(sofia.role).toBe('ADMIN');
    expect(sofia.isActive).toBe(false);
    await rejects(call(router, 'POST', `/users/${DEMO_USER_ID}/deactivate`), 400);

    const invite = await call<InviteUserResponse>(router, 'POST', '/users/invite', {
      email: 'new.hire@harborline.example.com',
      intendedProjectId: PROJECT_ID,
      intendedProjectRole: 'PROJECT_VIEWER',
    });
    expect(invite.inviteToken).toMatch(/^obz_demo_invite_/);
    await rejects(
      call(router, 'POST', '/users/invite', { email: 'new.hire@harborline.example.com' }),
      409,
    );

    const log = await call<GetAuditLogsResponse>(router, 'GET', '/audit-logs/global?limit=5');
    expect(log.auditLogs[0].message).toBe('User invited: new.hire@harborline.example.com');
    expect(log.auditLogs[0].userName).toBe('Alex Rivera');
    const filtered = await call<GetAuditLogsResponse>(
      router,
      'GET',
      '/audit-logs/global?action=deactivated&user=alex',
    );
    expect(filtered.auditLogs.map((l) => l.message)).toContain(
      'User deactivated: sofia.lindqvist@harborline.example.com',
    );
    const mine = await call<GetAuditLogsResponse>(
      router,
      'GET',
      `/audit-logs/users/${PERSON.marcus.id}`,
    );
    expect(mine.total).toBeGreaterThan(0);
    expect(mine.auditLogs.every((l) => l.userId === PERSON.marcus.id)).toBe(true);
  });

  it('project members: add, invite, change role, transfer ownership', async () => {
    const members = await call<GetMembersResponse>(
      router,
      'GET',
      `/projects/memberships/${PROJECT_ID}/members`,
    );
    expect(members.members.find((m) => m.userId === DEMO_USER_ID)?.role).toBe('OWNER');
    const added = await call<{ status: string }>(
      router,
      'POST',
      `/projects/memberships/${PROJECT_ID}/members`,
      { email: 'ben.carter@harborline.example.com', role: 'PROJECT_VIEWER' },
    );
    expect(added.status).toBe('ADDED');
    const invited = await call<{ status: string; inviteToken: string }>(
      router,
      'POST',
      `/projects/memberships/${PROJECT_ID}/members`,
      { email: 'someone@example.com', role: 'PROJECT_MEMBER' },
    );
    expect(invited.status).toBe('INVITED');
    await call(
      router,
      'PUT',
      `/projects/memberships/${PROJECT_ID}/members/${PERSON.tomas.id}/role`,
      {
        role: 'PROJECT_MEMBER',
      },
    );
    await rejects(
      call(router, 'DELETE', `/projects/memberships/${PROJECT_ID}/members/${DEMO_USER_ID}`),
      400,
    );
    await call(router, 'POST', `/projects/memberships/${PROJECT_ID}/transfer-ownership`, {
      newOwnerEmail: PERSON.priya.email,
    });
    const after = await call<GetMembersResponse>(
      router,
      'GET',
      `/projects/memberships/${PROJECT_ID}/members`,
    );
    expect(after.members.find((m) => m.userId === PERSON.priya.id)?.role).toBe('OWNER');
    expect(after.members.find((m) => m.userId === DEMO_USER_ID)?.role).toBe('PROJECT_ADMIN');
    expect(after.members).toHaveLength(members.members.length + 2);

    const audit = await call<GetAuditLogsResponse>(
      router,
      'GET',
      `/projects/${PROJECT_ID}/audit-logs?limit=3`,
    );
    expect(audit.auditLogs[0].message).toBe(
      `Project ownership transferred to: ${PERSON.priya.email}`,
    );
    expect(audit.auditLogs[0].projectName).toBe('Harborline Shop');
  });

  it('API keys show the token once and verify by it', async () => {
    const created = await call<ApiKey>(router, 'POST', `/projects/api-keys/${PROJECT_ID}`, {
      name: 'test key',
    });
    expect(created.token).toMatch(/^obz_demo_[0-9a-f]{32}$/);
    const verify = await call<{ isValid: boolean }>(
      router,
      'POST',
      `/projects/api-keys/${PROJECT_ID}/verify`,
      { token: created.token },
    );
    expect(verify.isValid).toBe(true);
    const list = await call<{ apiKeys: ApiKey[] }>(
      router,
      'GET',
      `/projects/api-keys/${PROJECT_ID}`,
    );
    expect(list.apiKeys.every((k) => k.token === undefined)).toBe(true);
    await call(router, 'PUT', `/projects/api-keys/${PROJECT_ID}/${created.id}`, {
      status: 'DISABLED',
    });
    const bulk = await call<{ deletedCount: number }>(
      router,
      'POST',
      `/projects/api-keys/${PROJECT_ID}/bulk-delete`,
      { apiKeyIds: [created.id] },
    );
    expect(bulk.deletedCount).toBe(1);
  });

  it('signs in with any credentials, then any 6-digit code', async () => {
    const signIn = { email: 'alex.rivera@harborline.example.com', password: 'Xk3m9qrt7wze-42' };
    const first = await call<SignInResponse>(router, 'POST', '/users/signin', signIn);
    expect(first).toMatchObject({ mfaRequired: true });
    expect(first.token).toBeUndefined();
    expect(first.mfaToken).toBeTruthy();

    const body = (code: string) => ({ mfaToken: first.mfaToken, code });
    await rejects(call(router, 'POST', '/users/mfa/login-verify', body('12345')), 400);
    const verified = await call<SignInResponse>(
      router,
      'POST',
      '/users/mfa/login-verify',
      body('482913'),
    );
    expect(verified).toMatchObject({ userId: DEMO_USER_ID });
    expect(verified.token).toBeTruthy();

    // With MFA turned off in the profile, sign-in skips the code.
    await call(router, 'POST', '/users/mfa/disable', { code: '123456' });
    const direct = await call<SignInResponse>(router, 'POST', '/users/signin', signIn);
    expect(direct.token).toBeTruthy();
    expect(direct.mfaRequired).toBeUndefined();
  });

  it('access tokens, connected apps, MFA and SSO', async () => {
    const created = await call<CreateAccessTokenResponse>(router, 'POST', '/access-tokens', {
      name: 'cli',
      expiresInDays: 30,
    });
    expect(created.token).toMatch(/^obz_demo_pat_/);
    const tokens = await call<{ accessTokens: AccessToken[] }>(router, 'GET', '/access-tokens');
    expect(tokens.accessTokens).toHaveLength(3);
    for (const t of tokens.accessTokens)
      expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.now());
    await call(router, 'DELETE', `/access-tokens/${created.accessToken.id}`);

    const apps = await call<{ apps: OAuthConnectedApp[] }>(router, 'GET', '/oauth/connected-apps');
    expect(apps.apps.map((a) => a.clientName)).toContain('Claude Desktop (MCP)');

    await rejects(call(router, 'POST', '/users/mfa/disable', { code: 'abc' }), 400);
    await call(router, 'POST', '/users/mfa/disable', { code: '123456' });
    const me = await call<UserProfile>(router, 'GET', `/users/${DEMO_USER_ID}`);
    expect(me.mfaEnabled).toBe(false);
    // bootstrap's /users/me and /users/mfa/status follow the same record.
    expect((await call<UserProfile>(router, 'GET', '/users/me')).mfaEnabled).toBe(false);
    expect(await call(router, 'GET', '/users/mfa/status')).toMatchObject({ enabled: false });
    await call(router, 'POST', '/users/mfa/enable', { code: '654321' });
    expect(await call(router, 'GET', '/users/mfa/status')).toMatchObject({ enabled: true });

    const connectors = await call<{ connectors: SSOConnector[] }>(router, 'GET', '/sso/connectors');
    expect(connectors.connectors[0].issuerUrl).toBe('https://id.harborline.example.com');
    const created2 = await call<SSOConnector>(router, 'POST', '/sso/connectors', {
      name: 'Contoso ID',
      providerType: 'entra_id',
      issuerUrl: 'https://login.example.com/contoso',
      clientId: 'abc',
      clientSecret: 'x',
      scopes: '',
      groupsClaim: '',
      requireVerifiedEmail: true,
      trustIdpMfa: false,
      buttonLabel: '',
      enabled: false,
    });
    expect(created2.hasClientSecret).toBe(true);
    expect(JSON.stringify(created2)).not.toContain('clientSecret');
    await rejects(call(router, 'POST', '/auth/sso/callback', {}), 403);
  });
});

describe('demo central notification settings', () => {
  const settings = routerWith(alerting);
  beforeEach(() => resetDemo());

  it('is the control plane view with the one Site in sync', async () => {
    const sync = await call<SettingsSync>(settings, 'GET', '/settings/sync');
    expect(sync.mode).toBe('control-plane');
    expect(sync.sites).toEqual([expect.objectContaining({ siteId: DEMO_SITE_ID, current: true })]);
    const channels = await call<SettingsChannel[]>(settings, 'GET', '/settings/channels');
    expect(channels.length).toBeGreaterThan(0);
    expect(channels.every((c) => c.source === 'central' && c.scope)).toBe(true);
    expect(await call(settings, 'GET', '/settings/smtp')).toMatchObject({ source: 'central' });
  });
});
