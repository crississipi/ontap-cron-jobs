import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { requireCronAuth } from "@/server/lib/notification-cron";

const BACKOFF_MINUTES = [5, 30, 120, 360, 1440];

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const candidates = await prisma.notificationEmailQueue.findMany({
      where: { status: "failed" },
      orderBy: { last_attempt: "asc" },
      take: 100,
    });

    let retried = 0;
    let permanentlyFailed = 0;

    for (const email of candidates) {
      if (email.attempts >= email.max_attempts) {
        await prisma.notificationEmailQueue.update({
          where: { id: email.id },
          data: { status: "permanently_failed" },
        });
        permanentlyFailed++;
        continue;
      }

      const backoffMinutes = BACKOFF_MINUTES[email.attempts] ?? 1440;
      const retryAt = new Date(
        (email.last_attempt ?? email.created_at).getTime() + backoffMinutes * 60 * 1000
      );
      if (retryAt > new Date()) continue;

      await prisma.notificationEmailQueue.update({
        where: { id: email.id },
        data: {
          status: "queued",
          error_message: null,
        },
      });
      retried++;
    }

    return NextResponse.json({ success: true, retried, permanently_failed: permanentlyFailed });
  } catch (error) {
    console.error("[retry-failed-emails]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Retry failed emails cron failed",
        tag: "[CRON_RETRY_EMAILS]",
      },
      { status: 500 }
    );
  }
}
