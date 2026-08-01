import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/server/lib/notification-cron";
import {
  createAndSendOrderFeedbackInvite,
  listOrdersNeedingFeedbackInvite,
} from "@/server/lib/order-feedback";

/**
 * GET /api/cron/order-feedback-requests
 *
 * Finds shop orders marked completed/delivered and queues a one-time
 * appreciation + feedback-request email (via NotificationEmailQueue).
 *
 * Query:
 * - dryRun=true — list candidates without creating rows or queuing email
 * - limit — batch size (default 40, max 100)
 */
export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const limitRaw = Number(searchParams.get("limit") ?? "40");
    const limit = Number.isFinite(limitRaw) ? limitRaw : 40;

    const candidates = await listOrdersNeedingFeedbackInvite(limit);

    if (dryRun) {
      return NextResponse.json({
        success: true,
        dryRun: true,
        candidates: candidates.length,
        orders: candidates.map((o) => ({
          order_id: o.id.toString(),
          order_number: o.order_number,
          user_id: o.user_id.toString(),
          email: o.user.email,
        })),
      });
    }

    let queued = 0;
    let skipped = 0;
    const errors: Array<{ order_number: string; error: string }> = [];

    for (const order of candidates) {
      try {
        const result = await createAndSendOrderFeedbackInvite(order);
        if (result.queued) queued += 1;
        else skipped += 1;
      } catch (err) {
        skipped += 1;
        errors.push({
          order_number: order.order_number,
          error: err instanceof Error ? err.message : "Unknown error",
        });
        console.error(
          `[CRON_ORDER_FEEDBACK] Failed for ${order.order_number}:`,
          err,
        );
      }
    }

    return NextResponse.json({
      success: true,
      candidates: candidates.length,
      queued,
      skipped,
      errors: errors.length ? errors : undefined,
    });
  } catch (error) {
    console.error("[CRON_ORDER_FEEDBACK]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Cron failed",
      },
      { status: 500 },
    );
  }
}
