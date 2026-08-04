import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/server/lib/notification-cron";
import { runBizcardDailyReport } from "@/lib/services/bizcard-daily-report.service";

/**
 * GET /api/cron/bizcard-daily-report
 *
 * Emails users a BizCard daily activity report for the previous UTC day,
 * only when they had new profile views, contact saves, or inquiries.
 *
 * Query:
 * - dryRun=true — count candidates without sending
 * - limit — batch size (default 200, max 500)
 *
 * Suggested schedule: daily after midnight UTC, e.g. 15 0 * * * (or 8:00 Asia/Manila)
 */
export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const limitRaw = Number(searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(limitRaw) ? limitRaw : 200;

    const result = await runBizcardDailyReport(new Date(), { limit, dryRun });

    return NextResponse.json({
      success: true,
      message: dryRun
        ? `Dry run: ${result.candidates} users with BizCard activity on ${result.reportDate}.`
        : `Sent ${result.sent} BizCard daily reports for ${result.reportDate} (${result.candidates} with activity).`,
      data: result,
    });
  } catch (error) {
    console.error("[bizcard-daily-report cron]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Cron failed",
        tag: "[CRON_BIZCARD_DAILY_REPORT]",
      },
      { status: 500 },
    );
  }
}
