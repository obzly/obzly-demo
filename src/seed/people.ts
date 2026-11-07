// Harborline's people: the users, their project roles, which of them use
// Claude Code, and the organization's teams. Every name and address is made
// up (harborline.example.com).
import { uuidFrom } from '../lib/rng';
import { DEMO_USER, PROJECT_ID, STAGING_PROJECT_ID } from '../world';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A time either absolute (epoch ms, > 0) or relative to now (< 0, ms ago).
 * Seeds use relative times so they stay fresh however long ago the visitor
 * first opened the demo; what a visitor creates is stamped absolutely.
 */
export type When = number;
export const ago = (ms: number): When => -Math.max(1, ms);
export const resolveWhen = (when: When, now = Date.now()): number => (when < 0 ? now + when : when);
export const isoOf = (when: When, now = Date.now()) =>
  new Date(resolveWhen(when, now)).toISOString();

export type GlobalRole = 'ADMIN' | 'MEMBER';
export type ProjectRoleName = 'OWNER' | 'PROJECT_ADMIN' | 'PROJECT_MEMBER' | 'PROJECT_VIEWER';
export type OrgRoleName = 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_MEMBER';

export interface Person {
  id: string;
  name: string;
  email: string;
  title: string;
  role: GlobalRole;
  isActive: boolean;
  createdAt: When;
  /** null: invited, never signed in. */
  lastLoginAt: When | null;
  lastActiveAt: When | null;
  mfaEnabled: boolean;
  isRootAdmin?: boolean;
  orgRole: OrgRoleName;
  /** Provisioned by SCIM from the identity provider. */
  scimExternalId?: string;
  projects: { projectId: string; role: ProjectRoleName; since: When }[];
}

const email = (local: string) => `${local}@harborline.example.com`;
const personId = (address: string) => uuidFrom(`person:${address}`);

export const PEOPLE: Person[] = [
  {
    id: DEMO_USER.id,
    name: DEMO_USER.name,
    email: DEMO_USER.email,
    title: 'Head of Platform',
    role: 'ADMIN',
    isActive: true,
    createdAt: ago(120 * DAY),
    lastLoginAt: ago(HOUR),
    lastActiveAt: ago(MINUTE),
    mfaEnabled: true,
    isRootAdmin: true,
    orgRole: 'ORG_OWNER',
    projects: [
      { projectId: PROJECT_ID, role: 'OWNER', since: ago(96 * DAY) },
      { projectId: STAGING_PROJECT_ID, role: 'OWNER', since: ago(61 * DAY) },
    ],
  },
  {
    id: personId(email('priya.natarajan')),
    name: 'Priya Natarajan',
    email: email('priya.natarajan'),
    title: 'Staff SRE',
    role: 'ADMIN',
    isActive: true,
    createdAt: ago(118 * DAY),
    lastLoginAt: ago(5 * HOUR),
    lastActiveAt: ago(14 * MINUTE),
    mfaEnabled: true,
    orgRole: 'ORG_ADMIN',
    projects: [
      { projectId: PROJECT_ID, role: 'PROJECT_ADMIN', since: ago(95 * DAY) },
      { projectId: STAGING_PROJECT_ID, role: 'PROJECT_ADMIN', since: ago(61 * DAY) },
    ],
  },
  {
    id: personId(email('marcus.webb')),
    name: 'Marcus Webb',
    email: email('marcus.webb'),
    title: 'Senior Backend Engineer (payments)',
    role: 'MEMBER',
    isActive: true,
    createdAt: ago(101 * DAY),
    lastLoginAt: ago(26 * HOUR),
    lastActiveAt: ago(38 * MINUTE),
    mfaEnabled: true,
    orgRole: 'ORG_MEMBER',
    projects: [
      { projectId: PROJECT_ID, role: 'PROJECT_MEMBER', since: ago(90 * DAY) },
      { projectId: STAGING_PROJECT_ID, role: 'PROJECT_MEMBER', since: ago(60 * DAY) },
    ],
  },
  {
    id: personId(email('sofia.lindqvist')),
    name: 'Sofia Lindqvist',
    email: email('sofia.lindqvist'),
    title: 'Frontend Engineer (storefront)',
    role: 'MEMBER',
    isActive: true,
    createdAt: ago(88 * DAY),
    lastLoginAt: ago(2 * DAY),
    lastActiveAt: ago(3 * HOUR),
    mfaEnabled: false,
    orgRole: 'ORG_MEMBER',
    projects: [
      { projectId: PROJECT_ID, role: 'PROJECT_MEMBER', since: ago(87 * DAY) },
      { projectId: STAGING_PROJECT_ID, role: 'PROJECT_MEMBER', since: ago(58 * DAY) },
    ],
  },
  {
    id: personId(email('daniel.okafor')),
    name: 'Daniel Okafor',
    email: email('daniel.okafor'),
    title: 'Platform Engineer',
    role: 'MEMBER',
    isActive: true,
    createdAt: ago(74 * DAY),
    lastLoginAt: ago(9 * HOUR),
    lastActiveAt: ago(52 * MINUTE),
    mfaEnabled: true,
    orgRole: 'ORG_MEMBER',
    projects: [{ projectId: PROJECT_ID, role: 'PROJECT_MEMBER', since: ago(73 * DAY) }],
  },
  {
    id: personId(email('hana.kobayashi')),
    name: 'Hana Kobayashi',
    email: email('hana.kobayashi'),
    title: 'Data Engineer',
    role: 'MEMBER',
    isActive: true,
    createdAt: ago(45 * DAY),
    lastLoginAt: ago(4 * DAY),
    lastActiveAt: ago(4 * DAY - 2 * HOUR),
    mfaEnabled: false,
    orgRole: 'ORG_MEMBER',
    scimExternalId: 'idp-00u7h2k9harb',
    projects: [{ projectId: PROJECT_ID, role: 'PROJECT_MEMBER', since: ago(44 * DAY) }],
  },
  {
    id: personId(email('tomas.herrera')),
    name: 'Tomás Herrera',
    email: email('tomas.herrera'),
    title: 'Customer Support Lead',
    role: 'MEMBER',
    isActive: true,
    createdAt: ago(39 * DAY),
    lastLoginAt: ago(3 * DAY),
    lastActiveAt: ago(3 * DAY - 40 * MINUTE),
    mfaEnabled: false,
    orgRole: 'ORG_MEMBER',
    projects: [{ projectId: PROJECT_ID, role: 'PROJECT_VIEWER', since: ago(39 * DAY) }],
  },
  {
    id: personId(email('grace.mensah')),
    name: 'Grace Mensah',
    email: email('grace.mensah'),
    title: 'Backend Engineer (new hire)',
    role: 'MEMBER',
    isActive: true,
    createdAt: ago(2 * DAY + 3 * HOUR),
    lastLoginAt: null,
    lastActiveAt: null,
    mfaEnabled: false,
    orgRole: 'ORG_MEMBER',
    projects: [{ projectId: PROJECT_ID, role: 'PROJECT_MEMBER', since: ago(2 * DAY + 3 * HOUR) }],
  },
  {
    id: personId(email('ben.carter')),
    name: 'Ben Carter',
    email: email('ben.carter'),
    title: 'Contractor (ended)',
    role: 'MEMBER',
    isActive: false,
    createdAt: ago(110 * DAY),
    lastLoginAt: ago(23 * DAY),
    lastActiveAt: ago(23 * DAY),
    mfaEnabled: true,
    orgRole: 'ORG_MEMBER',
    projects: [],
  },
];

export const personByEmail = (address: string) =>
  PEOPLE.find((p) => p.email.toLowerCase() === address.trim().toLowerCase());
export const personById = (id: string) => PEOPLE.find((p) => p.id === id);

export const PERSON = {
  alex: PEOPLE[0],
  priya: PEOPLE[1],
  marcus: PEOPLE[2],
  sofia: PEOPLE[3],
  daniel: PEOPLE[4],
  hana: PEOPLE[5],
  tomas: PEOPLE[6],
  grace: PEOPLE[7],
  ben: PEOPLE[8],
};

/** Engineers whose Claude Code sends OpenTelemetry to the Harborline Shop project. */
export interface ClaudeCodeUser {
  email: string;
  terminal: string;
  /** Share of sessions on Opus (the rest on Sonnet). */
  opusShare: number;
  /** First working hour, UTC. */
  startHour: number;
  /** Sessions on a weekday, min..max. */
  sessions: [number, number];
}

export const CLAUDE_CODE_USERS: ClaudeCodeUser[] = [
  { email: PERSON.alex.email, terminal: 'vscode', opusShare: 0.15, startHour: 8, sessions: [1, 3] },
  {
    email: PERSON.priya.email,
    terminal: 'iTerm.app',
    opusShare: 0.2,
    startHour: 6,
    sessions: [1, 3],
  },
  {
    email: PERSON.marcus.email,
    terminal: 'tmux',
    opusShare: 0.45,
    startHour: 9,
    sessions: [2, 4],
  },
  {
    email: PERSON.sofia.email,
    terminal: 'vscode',
    opusShare: 0.05,
    startHour: 8,
    sessions: [1, 3],
  },
  {
    email: PERSON.daniel.email,
    terminal: 'ghostty',
    opusShare: 0.1,
    startHour: 11,
    sessions: [1, 2],
  },
];

export const ORG_ID = uuidFrom('org:harborline');

export interface TeamSeed {
  id: string;
  name: string;
  memberIds: string[];
  grants: { id: string; projectId: string | null; role: string }[];
}

export const TEAMS: TeamSeed[] = [
  {
    id: uuidFrom('team:platform'),
    name: 'Platform',
    memberIds: [PERSON.alex.id, PERSON.priya.id, PERSON.daniel.id],
    grants: [{ id: uuidFrom('grant:platform:site'), projectId: null, role: 'MEMBER' }],
  },
  {
    id: uuidFrom('team:shop-engineering'),
    name: 'Shop engineering',
    memberIds: [PERSON.marcus.id, PERSON.sofia.id, PERSON.hana.id, PERSON.grace.id],
    grants: [
      { id: uuidFrom('grant:shop:prod'), projectId: PROJECT_ID, role: 'PROJECT_MEMBER' },
      { id: uuidFrom('grant:shop:staging'), projectId: STAGING_PROJECT_ID, role: 'PROJECT_MEMBER' },
    ],
  },
  {
    id: uuidFrom('team:support'),
    name: 'Customer support',
    memberIds: [PERSON.tomas.id],
    grants: [{ id: uuidFrom('grant:support:prod'), projectId: PROJECT_ID, role: 'PROJECT_VIEWER' }],
  },
];

export { DAY, HOUR, MINUTE };
