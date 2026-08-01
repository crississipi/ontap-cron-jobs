// GET /api/cron/init-subscription-system
// One-time initialization endpoint for subscription tiers.
// Run this after deployment to seed the 4-tier system.
// Protected by CRON_SECRET.

import { NextRequest, NextResponse } from "next/server";
import { initializeSubscriptionSystem } from "@/lib/subscription/seed-tiers";
import { generateRequestId } from "@/lib/utils/request-utils";
import { requireCronAuth } from "@/server/lib/notification-cron";

export async function GET(request: NextRequest) {
  const requestId = generateRequestId();

  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    await initializeSubscriptionSystem();

    return NextResponse.json({
      success: true,
      data: {
        message: "Subscription system initialized successfully",
        tiers: ["free_trial", "basic", "standard", "premium"],
      },
      meta: { requestId, timestamp: new Date().toISOString() },
    });
  } catch (error) {
    console.error("[Init Subscription System] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to initialize subscription system",
        },
        meta: { requestId, timestamp: new Date().toISOString() },
      },
      { status: 500 }
    );
  }
}
