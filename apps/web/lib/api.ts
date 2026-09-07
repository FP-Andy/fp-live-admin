export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';

export type SessionUser = {
  id: string;
  name: string;
  role: 'OPERATOR' | 'SUPERADMIN';
};

const SESSION_USER_CACHE_KEY = 'fpc.session-user.v1';
let sessionUserRequest: Promise<SessionUser> | null = null;

function isSessionUser(value: unknown): value is SessionUser {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionUser>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && (candidate.role === 'OPERATOR' || candidate.role === 'SUPERADMIN');
}

/** Last verified user for instant sidebar rendering during a tab session. */
export function readCachedSessionUser(): SessionUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(SESSION_USER_CACHE_KEY) || 'null');
    return isSessionUser(value) ? value : null;
  } catch {
    return null;
  }
}

export function primeSessionUser(user: SessionUser): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(SESSION_USER_CACHE_KEY, JSON.stringify(user));
}

export function clearCachedSessionUser(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(SESSION_USER_CACHE_KEY);
}

export function displayRole(role: SessionUser['role'] | string | null | undefined) {
  if (role === 'SUPERADMIN') return 'ADMIN';
  return role || '';
}

export async function apiFetch(input: string, init?: RequestInit) {
  return fetch(`${API_BASE}${input}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

export async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(input, init);
  if (!response.ok) {
    throw new Error(await response.text() || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

/** Share one /session/me request between the shell and the opening page. */
export function fetchSessionUser(): Promise<SessionUser> {
  if (!sessionUserRequest) {
    sessionUserRequest = apiJson<SessionUser>('/session/me')
      .then((user) => {
        primeSessionUser(user);
        return user;
      })
      .catch((error) => {
        clearCachedSessionUser();
        throw error;
      })
      .finally(() => {
        sessionUserRequest = null;
      });
  }
  return sessionUserRequest;
}
