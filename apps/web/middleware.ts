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

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (pathname.startsWith('/admin') && !hasSession) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }
  if (pathname === '/login' && hasSession) {
    return NextResponse.redirect(new URL('/admin/dashboard', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
