// app/api/cron/subscription-expiry/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/server/lib/notification-cron";
import { runSubscriptionExpiryReminders } from "@/lib/services/subscription-expiry-reminder.service";

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await runSubscriptionExpiryReminders(new Date());

    return NextResponse.json({
      success: true,
      message: `Processed ${result.processed} candidates; notified ${result.notified}; emails ${result.emailsSent}; deduped ${result.skippedDeduped}.`,
      data: result,
    });
  } catch (error) {
    console.error("[subscription-expiry cron] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
        tag: "[CRON_SUBSCRIPTION_EXPIRY]",
      },
      { status: 500 },
    );
  }
}
