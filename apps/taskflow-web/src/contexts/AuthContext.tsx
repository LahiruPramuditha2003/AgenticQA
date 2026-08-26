import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { findSeedUser } from '../services/seedUsers';
import type { User } from '../types';

interface AuthValue {
  user: User | null;
  signIn: (email: string, password: string) => boolean;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);
const STORAGE_KEY = 'taskflow.user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  // Restore the session so a generated test can navigate after signing in.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setUser(JSON.parse(raw) as User);
    } catch {
      /* ignore malformed storage */
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      signIn(email, password) {
        const found = findSeedUser(email, password);
        if (!found) return false;
        const next: User = {
          email: found.email,
          displayName: found.displayName,
          role: found.role,
        };
        setUser(next);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return true;
      },
      signOut() {
        setUser(null);
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      },
    }),
    [user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
