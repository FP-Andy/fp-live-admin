export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';

export type SessionUser = {
  id: string;
  name: string;
};

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
