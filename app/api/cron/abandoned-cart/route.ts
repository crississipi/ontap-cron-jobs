import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { requireCronAuth } from "@/server/lib/notification-cron";
import { buildAbandonedCartEmail, sendEmailMessage } from "@/server/lib/email";
import { randomId } from "@/server/lib/notifications";
import { listAbandonedCartCandidates } from "@/lib/services/cart.service";

const DEDUP_DAYS = 7;

function getBaseUrl() {
  const explicit = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.FRONTEND_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    return vercelUrl.startsWith("http") ? vercelUrl.replace(/\/$/, "") : `https://${vercelUrl}`;
  }

  return "http://localhost:3000";
}

async function wasRecentlyReminded(userId: bigint): Promise<boolean> {
  const since = new Date(Date.now() - DEDUP_DAYS * 24 * 60 * 60 * 1000);
  const recent = await prisma.notificationEmailQueue.findFirst({
    where: {
      user_id: userId,
      email_type: "abandoned_cart",
      status: "sent",
      sent_at: { gte: since },
    },
    select: { id: true },
  });
  return Boolean(recent);
}

export async function POST(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const dryRun = request.nextUrl.searchParams.get("dryRun") === "true" || process.env.CART_CRON_DRY_RUN === "true";
    const baseUrl = getBaseUrl().replace(/\/$/, "");
    const candidates = await listAbandonedCartCandidates();

    const results: Array<{ userId: string; email: string; sent: boolean; skipped?: boolean; error?: string }> = [];

    for (const candidate of candidates) {
      const cart = await prisma.cart.findUnique({
        where: { user_id: candidate.user_id },
        include: {
          items: {
            where: { item_type: "merchandise" },
            select: { quantity: true, variant: true, item_id: true },
          },
        },
      });

      if (!cart || cart.items.length === 0) {
        continue;
      }

      if (!dryRun && (await wasRecentlyReminded(candidate.user_id))) {
        results.push({
          userId: candidate.user_id.toString(),
          email: candidate.user.email,
          sent: false,
          skipped: true,
        });
        continue;
      }

      const productIds = cart.items.map((item) => item.item_id);
      const products = await prisma.merchandise.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, price: true },
      });

      const productMap = new Map(products.map((product) => [product.id.toString(), product]));
      const items = cart.items.map((item) => {
        const product = productMap.get(item.item_id.toString());
        return {
          name: product?.name ?? "Unknown item",
          quantity: item.quantity,
          price: product ? Number(product.price) : 0,
          variant: item.variant ?? null,
        };
      });

      const cartUrl = `${baseUrl.replace(/\/$/, "")}/user/emarket?tab=cart`;
      if (dryRun) {
        results.push({ userId: candidate.user_id.toString(), email: candidate.user.email, sent: false });
        continue;
      }

      try {
        const rendered = buildAbandonedCartEmail({
          firstName: candidate.user.first_name || "there",
          items,
          cartUrl,
        });
        await sendEmailMessage({
          to: candidate.user.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });

        await prisma.notificationEmailQueue.create({
          data: {
            id: randomId("email"),
            user_id: candidate.user_id,
            email_type: "abandoned_cart",
            priority: 10,
            subject: rendered.subject,
            template_name: "abandoned_cart",
            template_data: JSON.stringify({ cartUrl }),
            recipient_email: candidate.user.email,
            recipient_name: `${candidate.user.first_name ?? ""} ${candidate.user.last_name ?? ""}`.trim(),
            status: "sent",
            sent_at: new Date(),
            attempts: 1,
          },
        });

        results.push({ userId: candidate.user_id.toString(), email: candidate.user.email, sent: true });
      } catch (error) {
        results.push({
          userId: candidate.user_id.toString(),
          email: candidate.user.email,
          sent: false,
          error: error instanceof Error ? error.message : "Unknown email error",
        });
      }
    }

    return NextResponse.json({
      success: true,
      dryRun,
      processed: candidates.length,
      results,
    });
  } catch (error) {
    console.error("[abandoned-cart]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Abandoned cart cron failed",
        tag: "[CRON_ABANDONED_CART]",
      },
      { status: 500 }
    );
  }
}
