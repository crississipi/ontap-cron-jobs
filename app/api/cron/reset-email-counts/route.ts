import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { getLocalDateKey, requireCronAuth } from "@/server/lib/notification-cron";

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const prefs = await prisma.notificationPreference.findMany({
      select: {
        user_id: true,
        timezone: true,
        email_frequency_reset: true,
      },
    });

    const now = new Date();
    let resetCount = 0;
    for (const pref of prefs) {
      const currentKey = getLocalDateKey(now, pref.timezone || "UTC");
      const previousKey = pref.email_frequency_reset
        ? getLocalDateKey(pref.email_frequency_reset, pref.timezone || "UTC")
        : null;

      if (currentKey === previousKey) continue;

      await prisma.notificationPreference.update({
        where: { user_id: pref.user_id },
        data: {
          emails_sent_today: 0,
          email_frequency_reset: now,
        },
      });
      resetCount++;
    }

    return NextResponse.json({ success: true, reset_count: resetCount });
  } catch (error) {
    console.error("[reset-email-counts]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Reset email counts cron failed",
        tag: "[CRON_RESET_EMAIL_COUNTS]",
      },
      { status: 500 }
    );
  }
}
