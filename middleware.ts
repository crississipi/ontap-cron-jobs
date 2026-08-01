import { NextRequest, NextResponse } from "next/server";

/**
 * Cron-only API surface: allow /api/cron/*, block every other /api/* path.
 * UI routes remain available for a static status page only.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/cron/")) {
    return NextResponse.json(
      {
        success: false,
        error: "Not found.",
        code: "CRON_API_NOT_FOUND",
        tag: "[CRON_MIDDLEWARE]",
      },
      { status: 404 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
