import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/server/lib/notification-cron";
import { NewsletterCampaignService } from "@/lib/services/newsletter-campaign.service";
import { generateRequestId } from "@/lib/utils/request-utils";

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const requestId = generateRequestId();

  try {
    const service = new NewsletterCampaignService(requestId);
    const result = await service.processScheduledCampaigns();

    return NextResponse.json({
      success: true,
      ...result,
      meta: { requestId, timestamp: new Date().toISOString() },
    });
  } catch (error) {
    console.error("[send-scheduled-newsletters]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Scheduled newsletter cron failed",
        tag: "[CRON_SCHEDULED_NEWSLETTERS]",
        meta: { requestId, timestamp: new Date().toISOString() },
      },
      { status: 500 }
    );
  }
}
