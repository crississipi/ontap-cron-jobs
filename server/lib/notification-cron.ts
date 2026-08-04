import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { safeCompare } from "@/server/lib/timing-safe";

/**
 * Cron auth for all /api/cron/* routes (ontap-cron-jobs dedicated worker).
 *
 * Setup on https://cron-job.org / Hostinger cron:
 * - URL: https://YOUR_CRON_DOMAIN/api/cron/<endpoint>
 * - Header: Authorization: Bearer <CRON_SECRET>  (or x-cron-secret)
 * - Optional: CRON_ALLOWED_USER_AGENTS=cron-job.org
 *
 * CRON_SECRET is required. Missing secret = all callers rejected (no open endpoints).
 */
export function requireCronAuth(request: NextRequest): NextResponse | null {
  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  const tokenFromHeader = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : null;
  const tokenFromAltHeader = request.headers.get("x-cron-secret")?.trim() ?? null;

  const primary = (process.env.CRON_SECRET ?? "").trim();
  const secondary = (process.env.CRON_JOB_SECRET ?? "").trim();
  const allowedSecrets = [primary, secondary].filter(Boolean);

  // Dedicated cron worker: never allow unauthenticated access, even in development.
  if (!primary) {
    return NextResponse.json(
      {
        success: false,
        error: "Cron authentication is not configured.",
        code: "CRON_SECRET_MISSING",
        tag: "[CRON_AUTH]",
      },
      { status: 503 },
    );
  }

  const suppliedSecret = tokenFromHeader ?? tokenFromAltHeader;
  const matchedSecret =
    Boolean(suppliedSecret) &&
    allowedSecrets.some((candidate) => safeCompare(suppliedSecret as string, candidate));

  if (!suppliedSecret || !matchedSecret) {
    return NextResponse.json(
      {
        success: false,
        error: "Unauthorized.",
        code: "CRON_UNAUTHORIZED",
        tag: "[CRON_AUTH]",
        hint: "Send Authorization: Bearer <CRON_SECRET> or x-cron-secret header. App auth failures are 401 (not 403).",
      },
      { status: 401 },
    );
  }

  const allowedAgents = (process.env.CRON_ALLOWED_USER_AGENTS ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (allowedAgents.length > 0) {
    const ua = (request.headers.get("user-agent") ?? "").toLowerCase();
    const matched = allowedAgents.some((token) => ua.includes(token));
    if (!matched) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized scheduler.",
          code: "CRON_UA_REJECTED",
          tag: "[CRON_AUTH]",
          hint: `User-Agent must include one of: ${allowedAgents.join(", ")}. Clear CRON_ALLOWED_USER_AGENTS on the host if schedulers use a custom UA. App returns 401 for this case — HTML 403 is usually Hostinger/WAF.`,
        },
        { status: 401 },
      );
    }
  }

  return null;
}

export function getEmailDailyLimit(): number {
  return Math.max(1, Number(process.env.EMAIL_DAILY_LIMIT_PER_USER ?? "10"));
}

export function getLocalDateKey(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

export function getLocalParts(date: Date, timezone: string): { hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    hour,
    minute,
    weekday: weekdayMap[weekdayLabel] ?? 0,
  };
}

export function isDigestDue(params: {
  now: Date;
  timezone: string;
  digestTime: string;
  schedule: "daily" | "weekly";
  lastDigestSent: Date | null;
}): boolean {
  const [targetHour, targetMinute] = params.digestTime.split(":").map((value) => Number(value));
  if (!Number.isFinite(targetHour) || !Number.isFinite(targetMinute)) return false;

  const local = getLocalParts(params.now, params.timezone);
  if (local.hour !== targetHour) return false;
  if (Math.abs(local.minute - targetMinute) > 15) return false;
  if (params.schedule === "weekly" && local.weekday !== 1) return false;

  if (!params.lastDigestSent) return true;

  const currentKey = getLocalDateKey(params.now, params.timezone);
  const lastKey = getLocalDateKey(params.lastDigestSent, params.timezone);
  if (params.schedule === "daily") return currentKey !== lastKey;

  const hoursSinceLast = (params.now.getTime() - params.lastDigestSent.getTime()) / (60 * 60 * 1000);
  return hoursSinceLast >= 6 * 24;
}

export async function resetEmailCountIfNeeded(preference: {
  user_id: bigint;
  timezone: string;
  email_frequency_reset: Date | null;
  emails_sent_today: number;
}): Promise<number> {
  const now = new Date();
  const currentKey = getLocalDateKey(now, preference.timezone || "UTC");
  const lastKey = preference.email_frequency_reset
    ? getLocalDateKey(preference.email_frequency_reset, preference.timezone || "UTC")
    : null;

  if (lastKey === currentKey) {
    return preference.emails_sent_today;
  }

  try {
    // Keep compatibility with deployments where notification preference tables
    // exist but are not represented in the current Prisma schema.
    await prisma.$executeRawUnsafe(
      "UPDATE NotificationPreference SET emails_sent_today = 0, email_frequency_reset = ? WHERE user_id = ?",
      now,
      preference.user_id
    );
  } catch {
    return 0;
  }

  return 0;
}