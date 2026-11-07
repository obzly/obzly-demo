// The user accounts (the people seed plus whoever the visitor invites).
// Kept apart from handlers/admin.ts so bootstrap.ts can read the signed-in
// user's MFA state without an import cycle.
import { collection } from '../store';
import { PEOPLE, type When } from './people';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MEMBER';
  isActive: boolean;
  createdAt: When;
  lastLoginAt: When | null;
  lastActiveAt: When | null;
  mfaEnabled: boolean;
  isRootAdmin?: boolean;
}

export const users = collection<UserRecord>('users', () =>
  PEOPLE.map((p) => ({
    id: p.id,
    name: p.name,
    email: p.email,
    role: p.role,
    isActive: p.isActive,
    createdAt: p.createdAt,
    lastLoginAt: p.lastLoginAt,
    lastActiveAt: p.lastActiveAt,
    mfaEnabled: p.mfaEnabled,
    isRootAdmin: p.isRootAdmin,
  })),
);
