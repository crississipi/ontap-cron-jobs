import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { getRequestId } from "@/lib/errors/http";
import { requireCronAuth } from "@/server/lib/notification-cron";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const unauthorized = requireCronAuth(req);
  if (unauthorized) {
    return unauthorized;
  }

  const startedAt = Date.now();

  try {
    const now = new Date();

    const [expiredPromos, activatedPromos] = await Promise.all([
      prisma.promotion.updateMany({
        where: {
          expires_at: { lt: now },
          is_active: true,
        },
        data: {
          is_active: false,
          updated_at: now,
        },
      }),
      prisma.promotion.updateMany({
        where: {
          starts_at: { lte: now },
          expires_at: { gt: now },
          is_active: false,
        },
        data: {
          is_active: true,
          updated_at: now,
        },
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        expired_promos: expiredPromos.count,
        activated_promos: activatedPromos.count,
      },
      meta: {
        requestId,
        responseTime: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[cron/promos/update-status]", { requestId, error });
    return NextResponse.json(
      {
        success: false,
        error: {
          message: "Promo status update failed",
          requestId,
        },
      },
      { status: 500 }
    );
  }
}
