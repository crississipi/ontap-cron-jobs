// CRON /api/cron/cleanup-checkout-sessions
// Removes expired checkout sessions that have not been completed
// Triggered by external cron service (e.g., cron-job.org)

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { requireCronAuth } from "@/server/lib/notification-cron";

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const now = new Date();

    // Delete expired pending sessions (older than 24 hours)
    const result = await prisma.checkoutSession.deleteMany({
      where: {
        status: "pending",
        expires_at: {
          lt: now,
        },
      },
    });

    console.log(`[cleanup-checkout-sessions] Deleted ${result.count} expired checkout sessions`);

    // Also clean up failed/expired sessions older than 7 days
    const resultOldSessions = await prisma.checkoutSession.deleteMany({
      where: {
        status: {
          in: ["failed", "expired"],
        },
        updated_at: {
          lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      },
    });

    console.log(
      `[cleanup-checkout-sessions] Deleted ${resultOldSessions.count} old failed/expired sessions`
    );

    return NextResponse.json({
      success: true,
      message: "Cleanup completed",
      deletedPending: result.count,
      deletedOld: resultOldSessions.count,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[cleanup-checkout-sessions]", message, error);
    return NextResponse.json(
      {
        success: false,
        error: message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
