import { createContext, useContext } from 'react';
import type { User } from './api.ts';

export interface AuthValue {
  user: User;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthContext');
  return value;
}
