import { NextRequest, NextResponse } from "next/server";
import { cleanupOldWebhookEvents } from "@/lib/webhook-idempotency";
import { requireCronAuth } from "@/server/lib/notification-cron";

const RETENTION_DAYS = 30;

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const deletedCount = await cleanupOldWebhookEvents(RETENTION_DAYS);
    return NextResponse.json({
      success: true,
      processed: deletedCount,
      retentionDays: RETENTION_DAYS,
    });
  } catch (error) {
    console.error("[cleanup-webhook-events]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Webhook cleanup failed",
        tag: "[CRON_WEBHOOK_CLEANUP]",
      },
      { status: 500 }
    );
  }
}
