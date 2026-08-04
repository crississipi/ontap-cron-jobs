import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/server/lib/notification-cron";
import { runTrialExperienceFollowup } from "@/lib/services/trial-experience-followup.service";

/**
 * GET /api/cron/trial-experience-followup
 *
 * One-time email to free-trial users whose trial expired more than 7 days ago:
 * ask about their experience and encourage BizCards / marketplace products.
 *
 * Query:
 * - dryRun=true — count candidates without sending
 * - limit — batch size (default 40, max 100)
 *
 * Suggested schedule: daily, e.g. 0 10 * * *
 */
export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const limitRaw = Number(searchParams.get("limit") ?? "40");
    const limit = Number.isFinite(limitRaw) ? limitRaw : 40;

    const result = await runTrialExperienceFollowup(new Date(), { limit, dryRun });

    return NextResponse.json({
      success: true,
      message: dryRun
        ? `Dry run: ${result.candidates} candidates eligible for trial experience follow-up.`
        : `Sent ${result.sent} trial experience follow-ups (${result.candidates} eligible in batch).`,
      data: result,
    });
  } catch (error) {
    console.error("[trial-experience-followup cron]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Cron failed",
        tag: "[CRON_TRIAL_EXPERIENCE]",
      },
      { status: 500 },
    );
  }
}
