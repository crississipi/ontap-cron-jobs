// ──────────────────────────────────────────────────────────────
// GET /api/cron/cleanup — Scheduled Session & Data Cleanup
// ──────────────────────────────────────────────────────────────
// Triggered by Vercel Cron (vercel.json) on a daily schedule.
// Protected by CRON_SECRET to prevent unauthorized invocation.
//
// Cleans up:
// - Expired/revoked sessions (older than 7 days)
// - Old login attempt records (older than 30 days)
// - Old audit logs (older than 90 days)
// ──────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { prismaAnalytics } from "@/server/lib/prisma-analytics";
import { cleanupExpiredSessions } from "@/server/lib/session-cleanup";
import { requireCronAuth } from "@/server/lib/notification-cron";

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const sessionsDeleted = await cleanupExpiredSessions();

    // Clean old login attempts (older than 30 days)
    const loginAttemptsDeleted = await prismaAnalytics.loginAttempt.deleteMany({
      where: {
        created_at: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });

    // Clean old audit logs (older than 90 days)
    const auditLogsDeleted = await prismaAnalytics.auditLog.deleteMany({
      where: {
        created_at: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      },
    });

    return NextResponse.json({
      message: "Cleanup completed.",
      sessionsDeleted,
      loginAttemptsDeleted: loginAttemptsDeleted.count,
      auditLogsDeleted: auditLogsDeleted.count,
    });
  } catch (error) {
    console.error("Cleanup cron error:", error);
    return NextResponse.json(
      { error: "Cleanup failed." },
      { status: 500 }
    );
  }
}
