import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next 16 renamed Middleware to Proxy. Same runtime, same file position.
 *
 * This does exactly one thing: stamp the requested path onto the request
 * headers so `app/(app)/layout.tsx` can build a `?next=` return address when it
 * bounces a signed-out visitor to sign-in. A layout cannot otherwise learn its
 * own URL.
 *
 * It deliberately does NOT gate auth. Gaja's session is an opaque token checked
 * against Postgres, and the Next docs are explicit that Proxy runs on every
 * request including prefetches and must not do database work. The real gate is
 * in the layout, next to the data it protects.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-gaja-pathname', request.nextUrl.pathname + request.nextUrl.search);
  // `request.headers`, not the top-level `headers` — the latter would leak the
  // path to the client instead of forwarding it upstream.
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // API routes do their own auth and never need the header. Static assets and
  // image optimisation are excluded so this does no work on the hot path.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
