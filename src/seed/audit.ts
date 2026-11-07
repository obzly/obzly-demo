// The audit trail: a seeded history (sign-ins, member changes, keys, alert
// rules...) plus a real entry for each change the visitor makes in the
// admin, organization and AI areas. Other areas may call recordAudit too.
import type { AuditLog } from '../../entity/audit-logs';
import { hashString, mix, rng } from '../lib/rng';
import { collection, newId } from '../store';
import {
  DEMO_USER_ID,
  PROJECT_ID,
  PROJECT_NAME,
  STAGING_PROJECT_ID,
  STAGING_PROJECT_NAME,
} from '../world';
import { DAY, HOUR, MINUTE, PEOPLE, PERSON, type When, ago, isoOf, resolveWhen } from './people';

export interface AuditRecord {
  id: string;
  userId?: string;
  projectId?: string;
  message: string;
  at: When;
}

const seedEntry = (
  key: string,
  at: When,
  message: string,
  userId?: string,
  projectId?: string,
): AuditRecord => ({ id: `seed-${hashString(key).toString(16)}`, at, message, userId, projectId });

function seedHistory(): AuditRecord[] {
  const P = PERSON;
  const prod = PROJECT_ID;
  const stg = STAGING_PROJECT_ID;
  const entries: AuditRecord[] = [
    [13 * DAY + 2 * HOUR, 'Alert rule created: Checkout error rate > 2%', P.priya.id, prod],
    [13 * DAY + 1 * HOUR, 'Notification channel created: #shop-oncall (Slack)', P.priya.id, prod],
    [
      12 * DAY + 5 * HOUR,
      `API key created: batch-01 nightly export (obz_demo_4c1e...)`,
      P.daniel.id,
      prod,
    ],
    [
      11 * DAY + 7 * HOUR,
      'Member role changed: tomas.herrera@harborline.example.com from PROJECT_MEMBER to PROJECT_VIEWER',
      P.alex.id,
      prod,
    ],
    [11 * DAY + 3 * HOUR, 'AI budget created: Claude Code monthly', P.alex.id, prod],
    [10 * DAY + 6 * HOUR, 'AI model price added: claude-opus-4-1*', P.alex.id, prod],
    [10 * DAY + 4 * HOUR, 'Log field promoted: duration_ms (number)', P.priya.id, prod],
    [9 * DAY + 8 * HOUR, 'Dashboard created: Checkout health', P.marcus.id, prod],
    [9 * DAY + 2 * HOUR, 'SSO connector updated: Harborline Identity (generic_oidc)', P.alex.id],
    [
      8 * DAY + 9 * HOUR,
      'Access token created: Claude Code MCP (obz_demo_pat_9f2b...)',
      P.marcus.id,
    ],
    [8 * DAY + 1 * HOUR, 'OAuth app authorized for MCP: Claude Desktop (MCP)', P.alex.id],
    [7 * DAY + 6 * HOUR, 'Retention policy updated: traces 14 days, sample 25%', P.priya.id, prod],
    [
      6 * DAY + 10 * HOUR,
      'Silence created until incident review: PaymentsPoolExhausted',
      P.daniel.id,
      prod,
    ],
    [
      6 * DAY + 4 * HOUR,
      'API key updated: legacy fluent-bit (obz_demo_77ad...)',
      P.daniel.id,
      prod,
    ],
    [5 * DAY + 5 * HOUR, 'Team member added: hana.kobayashi@harborline.example.com', P.priya.id],
    [
      5 * DAY + 3 * HOUR,
      'SCIM (IdP provisioning): user hana.kobayashi@harborline.example.com created',
      undefined,
    ],
    [4 * DAY + 7 * HOUR, 'AI budget created: Per engineer weekly', P.alex.id, prod],
    [4 * DAY + 2 * HOUR, 'Synthetic check created: Storefront home (HTTP)', P.sofia.id, prod],
    [3 * DAY + 8 * HOUR, 'Alert rule updated: Payments p95 latency > 1.5s', P.marcus.id, prod],
    [3 * DAY + 1 * HOUR, 'User deactivated: ben.carter@harborline.example.com', P.alex.id],
    [
      2 * DAY + 3 * HOUR,
      'User invited to project: grace.mensah@harborline.example.com and added as PROJECT_MEMBER',
      P.priya.id,
      prod,
    ],
    [2 * DAY + 2 * HOUR, 'Team member added: grace.mensah@harborline.example.com', P.priya.id],
    [2 * DAY + 1 * HOUR, 'API key created: staging collector (obz_demo_b03f...)', P.sofia.id, stg],
    [1 * DAY + 9 * HOUR, 'AI budget created: LLM apps daily', P.priya.id, prod],
    [1 * DAY + 4 * HOUR, 'Alert rule created: Support assistant LLM errors > 5%', P.priya.id, prod],
    [20 * HOUR, 'Project updated: Harborline Staging', P.alex.id, stg],
    [7 * HOUR, 'Dashboard updated: Checkout health', P.marcus.id, prod],
    [
      3 * HOUR,
      'Member role changed: daniel.okafor@harborline.example.com from PROJECT_VIEWER to PROJECT_MEMBER',
      P.priya.id,
      prod,
    ],
  ].map(([offset, message, userId, projectId], i) =>
    seedEntry(
      `h${i}`,
      ago(offset as number),
      message as string,
      userId as string,
      projectId as string,
    ),
  );

  // Sign-ins: each active person most working days, plus MFA for those with it.
  const now = Date.now();
  const today = Math.floor(now / DAY);
  for (const person of PEOPLE) {
    if (person.lastLoginAt === null) continue;
    const lastLogin = resolveWhen(person.lastLoginAt, now);
    const firstDay = today - 13;
    for (let day = firstDay; day <= today; day++) {
      const r = rng(mix(hashString(person.email), day, 3));
      const weekday = new Date(day * DAY).getUTCDay();
      if (weekday === 0 || weekday === 6 ? r() > 0.15 : r() > 0.7) continue;
      const at = day * DAY + (6 + r() * 10) * HOUR;
      if (at > lastLogin) continue;
      if (!person.isActive && at > lastLogin) continue;
      entries.push(
        seedEntry(
          `login:${person.email}:${day}`,
          ago(now - at),
          `User signed in with email: ${person.email}`,
          person.id,
        ),
      );
    }
    entries.push(
      seedEntry(
        `login:${person.email}:last`,
        ago(now - lastLogin),
        `User signed in with email: ${person.email}`,
        person.id,
      ),
    );
  }
  entries.push(
    seedEntry(
      'grace-invite',
      ago(2 * DAY + 3 * HOUR + MINUTE),
      'User invited: grace.mensah@harborline.example.com',
      PERSON.priya.id,
    ),
  );
  return entries;
}

export const auditLog = collection<AuditRecord>('auditLog', () => []);

let seeded: { at: number; items: AuditRecord[] } | undefined;
const seedRecords = () => {
  // Rebuilt hourly so the generated sign-ins move with "now".
  const hour = Math.floor(Date.now() / HOUR);
  if (!seeded || seeded.at !== hour) seeded = { at: hour, items: seedHistory() };
  return seeded.items;
};

/** Records one entry in the audit trail, as the signed-in user by default. */
export function recordAudit(
  message: string,
  projectId?: string,
  userId: string | null = DEMO_USER_ID,
): AuditRecord {
  return auditLog.insert({
    id: newId(),
    message,
    projectId,
    userId: userId ?? undefined,
    at: Date.now(),
  });
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  beforeDate?: string;
  user?: string;
  action?: string;
  sortBy?: string;
  sortOrder?: string;
}

export const auditQueryFrom = (query: URLSearchParams): AuditQuery => ({
  limit: Number(query.get('limit')) || undefined,
  offset: Number(query.get('offset')) || undefined,
  beforeDate: query.get('beforeDate') ?? undefined,
  user: query.get('user') ?? undefined,
  action: query.get('action') ?? undefined,
  sortBy: query.get('sortBy') ?? undefined,
  sortOrder: query.get('sortOrder') ?? undefined,
});

export interface AuditDirectory {
  user: (id: string) => { name: string; email: string } | undefined;
  project: (id: string) => string | undefined;
}

const defaultProjects: Record<string, string> = {
  [PROJECT_ID]: PROJECT_NAME,
  [STAGING_PROJECT_ID]: STAGING_PROJECT_NAME,
};

/** Every entry matching `scope`, filtered, sorted and paged like the backend. */
export function queryAudit(
  scope: (record: AuditRecord) => boolean,
  q: AuditQuery,
  directory: AuditDirectory,
) {
  const now = Date.now();
  const before = q.beforeDate ? Date.parse(q.beforeDate) : undefined;
  const userNeedle = q.user?.trim().toLowerCase();
  const actionNeedle = q.action?.trim().toLowerCase();
  const rows: AuditLog[] = [];
  // Insertion order breaks ties between entries written in the same millisecond.
  const order = new Map<string, number>();
  for (const record of [...seedRecords(), ...auditLog.all()]) {
    order.set(record.id, order.size);
    if (!scope(record)) continue;
    const at = resolveWhen(record.at, now);
    if (before !== undefined && Number.isFinite(before) && at >= before) continue;
    const user = record.userId ? directory.user(record.userId) : undefined;
    if (userNeedle) {
      const haystack = `${user?.name ?? ''} ${user?.email ?? ''}`.toLowerCase();
      if (!haystack.includes(userNeedle)) continue;
    }
    if (actionNeedle && !record.message.toLowerCase().includes(actionNeedle)) continue;
    rows.push({
      id: record.id,
      userId: record.userId,
      projectId: record.projectId,
      message: record.message,
      createdAt: isoOf(record.at, now),
      userEmail: user?.email,
      userName: user?.name,
      projectName: record.projectId
        ? (directory.project(record.projectId) ?? defaultProjects[record.projectId])
        : undefined,
    });
  }
  const desc = q.sortOrder !== 'asc';
  const byTime = (a: AuditLog, b: AuditLog) =>
    a.createdAt.localeCompare(b.createdAt) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  if (q.sortBy === 'user') {
    rows.sort((a, b) => {
      // System entries (no user) sort after named users either way.
      const an = a.userName || a.userEmail;
      const bn = b.userName || b.userEmail;
      if (!an !== !bn) return an ? -1 : 1;
      const byName = (an ?? '').localeCompare(bn ?? '');
      if (byName !== 0) return desc ? -byName : byName;
      return byTime(b, a);
    });
  } else {
    rows.sort((a, b) => (desc ? byTime(b, a) : byTime(a, b)));
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
  const offset = Math.max(q.offset ?? 0, 0);
  return {
    auditLogs: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
  };
}
