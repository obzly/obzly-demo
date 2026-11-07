// What the app loads at start: the signed-in user, settings, MFA, disk and
// projects, plus sign-in/out (sign-out restarts the demo).
import type {
  Project,
  ProjectResponse,
  PromotedField,
  RetentionPolicy,
} from '../../entity/projects';
import type { UserProfile, UsersSettings } from '../../entity/users';
import { DemoError, type Router } from '../router';
import { users } from '../seed/users';
import { collection, newId, value } from '../store';
import {
  DATA_DAYS,
  DEMO_TOKEN,
  DEMO_USER,
  DEMO_USER_ID,
  PROJECT_ID,
  PROJECT_NAME,
  STAGING_PROJECT_ID,
  STAGING_PROJECT_NAME,
} from '../world';

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** MFA on the demo user's account (admin.ts's MFA setup changes it). */
const demoUserMfa = () => users.get(DEMO_USER_ID)?.mfaEnabled ?? true;

/** The sign-in MFA challenge; not a secret, the demo accepts any 6-digit code. */
export const DEMO_MFA_CHALLENGE = 'demo-mfa-challenge';

export const currentUser = (): UserProfile => ({
  ...DEMO_USER,
  role: 'ADMIN' as UserProfile['role'],
  isActive: true,
  createdAt: daysAgo(120) as unknown as Date,
  lastLoginAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastActiveAt: new Date().toISOString(),
  mfaEnabled: demoUserMfa(),
  isRootAdmin: true,
  ...profile.get(),
});

const profile = value<{ name?: string; email?: string }>('profile', () => ({}));

export const usersSettings = value<UsersSettings>('usersSettings', () => ({
  isAllowExternalRegistrations: false,
  isAllowMemberInvitations: true,
  isMemberAllowedToCreateProjects: false,
  isMfaRequiredForEveryone: false,
}));

const projectDefaults = (id: string, name: string, createdDaysAgo: number): Project => ({
  id,
  name,
  createdAt: daysAgo(createdDaysAgo) as unknown as Date,
  isApiKeyRequired: true,
  isFilterByDomain: false,
  isFilterByIp: false,
  allowedDomains: [],
  allowedIps: [],
  isRateLimitingEnabled: false,
  logsPerSecondLimit: 5000,
  maxLogsAmount: 0,
  maxLogsSizeMb: 0,
  maxLogsLifeDays: 30,
  maxLogSizeKb: 64,
});

export const projects = collection<Project & { userRole?: string; isSystem?: boolean }>(
  'projects',
  () => [
    { ...projectDefaults(PROJECT_ID, PROJECT_NAME, 96), userRole: 'OWNER' },
    {
      ...projectDefaults(STAGING_PROJECT_ID, STAGING_PROJECT_NAME, 61),
      userRole: 'OWNER',
      maxLogsLifeDays: 7,
    },
  ],
);

export const isKnownProject = (id: string) => !!projects.get(id);

export function requireProject(id: string) {
  const project = projects.get(id);
  if (!project) throw new DemoError(404, 'Project not found');
  return project;
}

const retention = collection<RetentionPolicy & { id: string }>('retention', () =>
  [PROJECT_ID, STAGING_PROJECT_ID].flatMap((projectId) => [
    {
      id: `${projectId}:logs`,
      projectId,
      signal: 'logs' as const,
      retentionDays: 30,
      rollupDays: 0,
      sampleRate: 1,
      slowMs: 0,
      sampleRules: [{ service: 'otel-collector', level: 'debug', rate: 0.1 }],
    },
    {
      id: `${projectId}:traces`,
      projectId,
      signal: 'traces' as const,
      retentionDays: 14,
      rollupDays: 0,
      sampleRate: 0.25,
      slowMs: 1500,
      sampleRules: [],
    },
    {
      id: `${projectId}:metrics`,
      projectId,
      signal: 'metrics' as const,
      retentionDays: 30,
      rollupDays: 395,
      sampleRate: 1,
      slowMs: 0,
      sampleRules: [],
    },
  ]),
);

const promoted = collection<PromotedField & { id: string }>('promotedFields', () => [
  {
    id: `${PROJECT_ID}:service_name`,
    projectId: PROJECT_ID,
    slot: 'str_1',
    field: 'service_name',
    createdAt: daysAgo(80),
  },
  {
    id: `${PROJECT_ID}:http_status_code`,
    projectId: PROJECT_ID,
    slot: 'str_2',
    field: 'http_status_code',
    createdAt: daysAgo(80),
  },
  {
    id: `${PROJECT_ID}:duration_ms`,
    projectId: PROJECT_ID,
    slot: 'num_1',
    field: 'duration_ms',
    createdAt: daysAgo(40),
  },
]);

const toProjectResponse = (
  p: Project & { userRole?: string; isSystem?: boolean },
): ProjectResponse => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt,
  userRole: (p.userRole ?? 'OWNER') as ProjectResponse['userRole'],
  isSystem: p.isSystem,
});

export function register(r: Router) {
  // --- identity --------------------------------------------------------------
  r.get('/users/me', () => currentUser());
  r.put('/users/me', (req) => {
    const body = (req.body ?? {}) as { name?: string; email?: string };
    profile.set({ ...profile.get(), ...body });
    return { message: 'Profile updated' };
  });
  r.get('/users/settings', () => usersSettings.get());
  r.put('/users/settings', (req) =>
    usersSettings.set({ ...usersSettings.get(), ...(req.body as UsersSettings) }),
  );
  r.get('/users/mfa/status', () => ({
    enabled: demoUserMfa(),
    required: false,
    satisfiedByIdentityProvider: false,
  }));
  r.get('/users/is-any-user-exist', () => ({ isExist: true }));
  r.get('/users/admin/has-password', () => ({ hasPassword: true, isRegistrationEnabled: false }));
  // Any email and password sign in as the demo user. With MFA on (the seed)
  // the app asks for a code next, which admin.ts's login-verify accepts.
  r.post('/users/signin', () =>
    demoUserMfa()
      ? { mfaRequired: true, mfaToken: DEMO_MFA_CHALLENGE }
      : { token: DEMO_TOKEN, userId: DEMO_USER_ID, email: currentUser().email },
  );
  r.post('/users/logout', () => ({ message: 'Signed out' }));
  r.put('/users/change-password', () => ({
    message: 'Password changed (demo: nothing was stored)',
  }));

  // --- disk ------------------------------------------------------------------
  r.get('/disk/usage', () => {
    const total = 500 * 1024 ** 3;
    const used = Math.round(total * 0.37);
    return {
      platform: 'linux',
      totalSpaceBytes: total,
      usedSpaceBytes: used,
      freeSpaceBytes: total - used,
    };
  });

  // --- projects --------------------------------------------------------------
  r.get('/projects', () => ({ projects: projects.all().map(toProjectResponse) }));
  r.post('/projects', (req) => {
    const body = (req.body ?? {}) as { name?: string };
    if (!body.name?.trim()) throw new DemoError(400, 'Project name is required');
    const project = { ...projectDefaults(newId(), body.name.trim(), 0), userRole: 'OWNER' };
    projects.insert(project);
    return toProjectResponse(project);
  });
  r.get('/projects/:id', (req) => {
    const { userRole: _role, isSystem: _system, ...project } = requireProject(req.params.id);
    void _role;
    void _system;
    return project;
  });
  r.put('/projects/:id', (req) => {
    requireProject(req.params.id);
    return projects.update(req.params.id, req.body as Partial<Project>);
  });
  r.delete('/projects/:id', (req) => {
    if (req.params.id === PROJECT_ID)
      throw new DemoError(400, "The demo's main project can't be deleted");
    requireProject(req.params.id);
    projects.remove(req.params.id);
    return { message: 'Project deleted' };
  });
  r.get('/projects/:id/retention-policies', (req) =>
    retention.find((p) => p.projectId === req.params.id).map(({ id: _id, ...p }) => (void _id, p)),
  );
  r.put('/projects/:id/retention-policies', (req) => {
    const next = (req.body as RetentionPolicy[]) ?? [];
    const others = retention.find((p) => p.projectId !== req.params.id);
    const now = new Date().toISOString();
    const mine = next.map((p) => ({
      ...p,
      projectId: req.params.id,
      id: `${req.params.id}:${p.signal}`,
      updatedAt: now,
    }));
    retention.replaceAll([...others, ...mine]);
    return mine.map(({ id: _id, ...p }) => (void _id, p));
  });
  r.get('/projects/:id/promoted-fields', (req) =>
    promoted.find((p) => p.projectId === req.params.id).map(({ id: _id, ...p }) => (void _id, p)),
  );
  r.post('/projects/:id/promoted-fields', (req) => {
    const body = req.body as { field: string; type: 'string' | 'number' };
    const mine = promoted.find((p) => p.projectId === req.params.id);
    const prefix = body.type === 'number' ? 'num' : 'str';
    const used = mine.filter((p) => p.slot.startsWith(prefix)).length;
    const field = {
      id: `${req.params.id}:${body.field}`,
      projectId: req.params.id,
      slot: `${prefix}_${used + 1}`,
      field: body.field,
      createdAt: new Date().toISOString(),
    };
    promoted.insert(field);
    return field;
  });
  r.delete('/projects/:id/promoted-fields/:field', (req) => {
    promoted.remove(`${req.params.id}:${req.params.field}`);
    return { message: 'Field retired' };
  });
}

export { DATA_DAYS };
