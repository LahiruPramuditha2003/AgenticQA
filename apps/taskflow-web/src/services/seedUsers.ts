/**
 * Seeded demo accounts for TaskFlow.
 *
 * These are REAL literals on purpose: AgenticQA's knowledge-pack generator statically scans source for
 * email/password pairs (`core/knowledge/generate/extractCredentials.ts`) and must never invent one. This
 * file is what it is expected to find.
 */

import type { MemberRole } from '../types';

export interface SeedUser {
  email: string;
  password: string;
  displayName: string;
  role: MemberRole;
}

export const SEED_USERS: SeedUser[] = [
  {
    email: 'ada@taskflow.test',
    password: 'Taskflow123!',
    displayName: 'Ada Lovelace',
    role: 'Member',
  },
  {
    email: 'grace@taskflow.test',
    password: 'Admin123!',
    displayName: 'Grace Hopper',
    role: 'Admin',
  },
];

export function findSeedUser(email: string, password: string): SeedUser | undefined {
  const needle = email.trim().toLowerCase();
  return SEED_USERS.find((u) => u.email === needle && u.password === password);
}
