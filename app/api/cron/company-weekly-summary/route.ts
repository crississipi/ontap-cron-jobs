import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/server/lib/notification-cron";
import { CompanyNotificationService } from "@/lib/services/company-notification.service";

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const service = new CompanyNotificationService("cron_company_weekly_summary");
    const result = await service.queueWeeklySummaryEmails(new Date());

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("[api/cron/company-weekly-summary GET] Unexpected error", { error });
    return NextResponse.json(
      {
        success: false,
        error: "Failed to queue company weekly summaries.",
      },
      { status: 500 }
    );
  }
}
