import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { buildDigestItems, queueEmailForNotification } from "@/server/lib/notifications";
import { isDigestDue, requireCronAuth } from "@/server/lib/notification-cron";

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const now = new Date();
    const prefs = await prisma.notificationPreference.findMany({
      where: {
        digest_schedule: "daily",
        unsubscribed_at: null,
      },
      take: 200,
    });

    let queued = 0;
    for (const pref of prefs) {
      if (!isDigestDue({
        now,
        timezone: pref.timezone,
        digestTime: pref.digest_time,
        schedule: "daily",
        lastDigestSent: pref.last_digest_sent,
      })) {
        continue;
      }

      const user = await prisma.user.findUnique({
        where: { user_id: pref.user_id },
        select: { email: true, first_name: true, is_active: true },
      });
      if (!user || !user.is_active || !pref.email_verified) continue;

      const notifications = await prisma.userNotification.findMany({
        where: {
          user_id: pref.user_id,
          created_at: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
          is_archived: false,
        },
        orderBy: { created_at: "desc" },
        take: 100,
      });
      if (notifications.length === 0) continue;

      const items = buildDigestItems(notifications);
      await queueEmailForNotification({
        userId: pref.user_id,
        notificationId: null,
        recipientEmail: user.email,
        recipientName: user.first_name,
        subject: "Your daily notification digest",
        templateName: "daily-digest",
        templateData: {
          app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
          user_name: user.first_name,
          app_url: process.env.FRONTEND_URL ?? "",
          items,
        },
        emailType: "digest",
        priority: 25,
      });

      await prisma.notificationPreference.update({
        where: { user_id: pref.user_id },
        data: { last_digest_sent: now },
      });
      queued++;
    }

    return NextResponse.json({ success: true, queued });
  } catch (error) {
    console.error("[send-daily-digests]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Daily digest cron failed",
        tag: "[CRON_DAILY_DIGEST]",
      },
      { status: 500 }
    );
  }
}
