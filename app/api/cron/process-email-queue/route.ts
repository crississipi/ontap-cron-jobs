import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { renderNotificationTemplate } from "@/server/lib/notification-templates";
import { sendEmailMessage } from "@/server/lib/email";
import { recordDeliveryEvent } from "@/server/lib/notifications";
import { getEmailDailyLimit, requireCronAuth, resetEmailCountIfNeeded } from "@/server/lib/notification-cron";

function normalizeTemplateData(input: unknown): Record<string, unknown> {
  if (!input) return {};

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  return typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const batchSize = Math.min(Number(process.env.EMAIL_QUEUE_BATCH_SIZE ?? "100"), 100);
    const dailyLimit = getEmailDailyLimit();

    const queuedEmails = await prisma.notificationEmailQueue.findMany({
      where: { status: "queued" },
      orderBy: [{ priority: "desc" }, { created_at: "asc" }],
      take: batchSize,
    });

    let sent = 0;
    let failed = 0;
    let deferred = 0;

    for (const email of queuedEmails) {
      const pref = await prisma.notificationPreference.findUnique({
        where: { user_id: email.user_id },
        select: {
          user_id: true,
          timezone: true,
          email_frequency_reset: true,
          emails_sent_today: true,
        },
      });

      const emailsSentToday = pref ? await resetEmailCountIfNeeded(pref) : 0;
      if (emailsSentToday >= dailyLimit) {
        deferred++;
        await prisma.notificationEmailQueue.update({
          where: { id: email.id },
          data: { last_attempt: new Date(), error_message: "Deferred due to daily email limit." },
        });
        continue;
      }

      try {
        const rendered = renderNotificationTemplate(
          email.template_name ?? "default",
          normalizeTemplateData(email.template_data)
        );
        await sendEmailMessage({
          to: email.recipient_email,
          subject: email.subject || rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });

        await prisma.notificationEmailQueue.update({
          where: { id: email.id },
          data: {
            status: "sent",
            sent_at: new Date(),
            last_attempt: new Date(),
            attempts: { increment: 1 },
            error_message: null,
          },
        });

        await prisma.notificationPreference.upsert({
          where: { user_id: email.user_id },
          create: {
            id: `npref_${email.user_id.toString()}`,
            user_id: email.user_id,
            email_verified: true,
            digest_schedule: "daily",
            digest_time: "08:00",
            timezone: "UTC",
            preferences: "{}",
            emails_sent_today: 1,
            email_frequency_reset: new Date(),
          },
          update: {
            emails_sent_today: { increment: 1 },
            email_frequency_reset: new Date(),
          },
        });

        if (email.notification_id) {
          await prisma.notificationDelivery.updateMany({
            where: { notification_id: email.notification_id, channel: "email" },
            data: {
              status: "delivered",
              delivered_at: new Date(),
              error_message: null,
            },
          });

          await recordDeliveryEvent({
            notificationId: email.notification_id,
            userId: email.user_id,
            eventType: "delivered",
            channel: "email",
          });
        }

        sent++;
      } catch (error) {
        failed++;
        await prisma.notificationEmailQueue.update({
          where: { id: email.id },
          data: {
            status: "failed",
            attempts: { increment: 1 },
            last_attempt: new Date(),
            error_message: error instanceof Error ? error.message.slice(0, 1000) : "Unknown email send failure.",
          },
        });

        if (email.notification_id) {
          await prisma.notificationDelivery.updateMany({
            where: { notification_id: email.notification_id, channel: "email" },
            data: {
              status: "failed",
              error_message: error instanceof Error ? error.message.slice(0, 1000) : "Unknown email send failure.",
            },
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      processed: queuedEmails.length,
      sent,
      failed,
      deferred,
    });
  } catch (error) {
    console.error("[process-email-queue]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Email queue processing failed",
        tag: "[CRON_EMAIL_QUEUE]",
      },
      { status: 500 }
    );
  }
}
