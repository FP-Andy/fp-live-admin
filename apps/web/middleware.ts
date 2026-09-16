import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE_NAME = 'live_admin_session';

// The same Next.js container serves the operations console and the public
// showroom.  Nginx only needs to proxy the broadcast hostname; this rewrite
// maps its root to the isolated /broadcast route without affecting assets.
export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host')?.split(':')[0]?.toLowerCase();
  const pathname = request.nextUrl.pathname;
  if (hostname === 'broadcast.fineludens.kr') {
    if (pathname.startsWith('/api/') || pathname.startsWith('/_next/') || pathname === '/favicon.ico') return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = pathname === '/' ? '/broadcast' : `/broadcast${pathname}`;
    return NextResponse.rewrite(url);
  }

  // 로컬 앱(FinePlay Highlight)이 자기 안에서 이 서버를 띄울 때만 켜진다. 앱에는
  // 붙을 API 도 로그인도 없어서, 여기서 막으면 화면 자체가 뜨지 않는다.
  // 이 서버는 127.0.0.1 로만 듣고 앱과 함께 죽으므로 바깥에서 닿을 수 없다.
  const localApp = process.env.FHL_LOCAL_APP === '1';
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (pathname.startsWith('/admin') && !hasSession && !localApp) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }
  // Cookie presence cannot prove a session is valid: expired/revoked sessions
  // must be able to reach the login form without a redirect loop.
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
