/**
 * Cron-worker minimal auth surface.
 * Intentionally does NOT include login, CSRF, sessions API, or impersonation.
 */
import type { NextRequest } from "next/server";
import { cleanupExpiredSessions as cleanupSessions } from "@/server/lib/session-cleanup";

export function getClientIp(_request?: NextRequest): string | null {
  return null;
}

export function getUserAgent(_request?: NextRequest): string | null {
  return null;
}

export async function resolveRequestSession(_request: NextRequest): Promise<{
  authenticated: false;
  user: null;
  session: null;
  refreshed: false;
}> {
  return { authenticated: false, user: null, session: null, refreshed: false };
}

export const cleanupExpiredSessions = cleanupSessions;
