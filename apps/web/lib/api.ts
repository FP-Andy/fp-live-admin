import { errorFromBody, errorFromResponse, FpcError } from './error-messages';

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '/api';
export { errorFromResponse, FpcError };

export type SessionUser = {
  id: string;
  name: string;
  role: 'OPERATOR' | 'SUPERADMIN';
};

const SESSION_USER_CACHE_KEY = 'fpc.session-user.v1';
let lastPublishedId:string|null|undefined;
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
  const previous=lastPublishedId===undefined?readCachedSessionUser()?.id:lastPublishedId;
  lastPublishedId=user.id;
  try{window.sessionStorage.setItem(SESSION_USER_CACHE_KEY, JSON.stringify(user));}catch{}
  if(previous!==user.id)publishSessionChange(user.id);
}

export function clearCachedSessionUser(): void {
  if (typeof window === 'undefined') return;
  try{window.sessionStorage.removeItem(SESSION_USER_CACHE_KEY);}catch{}
  if(lastPublishedId!==null){lastPublishedId=null;publishSessionChange(null);}
}

function publishSessionChange(id:string|null){
 window.dispatchEvent(new CustomEvent('fpc-session-changed',{detail:{id}}));
 if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel('fpc-session');channel.postMessage({id});channel.close();}
}

export function displayRole(role: SessionUser['role'] | string | null | undefined) {
  if (role === 'SUPERADMIN') return 'ADMIN';
  return role || '';
}

export async function apiFetch(input: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE}${input}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (response.status === 401 && !input.startsWith('/session/') && typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')) {
    clearCachedSessionUser();
    window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  return response;
}

/** 농구 화면(/admin/basketball/**)은 apiJson 오류를 예전처럼 서버 본문 그대로 던진다. */
function legacyErrorSurface(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/admin/basketball');
}

export async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(input, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // 농구 화면은 대표 작업 중 — 보이는 오류 문구를 예전(서버 본문 그대로)과 똑같이 둔다.
    if (legacyErrorSurface()) throw new Error(text || `Request failed (${response.status})`);
    // 서버 detail 은 변환표를 거친 한국어로(message), 원문은 status·detail·raw 로 남긴다.
    throw errorFromBody(response.status, text, { url: `${init?.method || 'GET'} ${API_BASE}${input}` });
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
