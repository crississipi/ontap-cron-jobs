import { randomUUID } from "node:crypto";
import { prisma } from "@/server/lib/prisma";
import { queueEmailForNotification } from "@/server/lib/notifications";

export const ORDER_FEEDBACK_EMAIL_TYPE = "order_feedback_request";
export const ORDER_FEEDBACK_TEMPLATE = "order-feedback-request";
export const ORDER_FEEDBACK_STATUSES = ["completed", "delivered"] as const;
export const ORDER_FEEDBACK_LINK_TTL_DAYS = 30;
/** Wait this long after completion before inviting feedback (avoids stacking on confirmation email). */
export const ORDER_FEEDBACK_DELAY_HOURS = 1;

function getAppBaseUrl(): string {
  const explicit =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.FRONTEND_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    return vercelUrl.startsWith("http")
      ? vercelUrl.replace(/\/$/, "")
      : `https://${vercelUrl}`;
  }
  return "http://localhost:3000";
}

export function buildOrderFeedbackUrl(uuid: string): string {
  return `${getAppBaseUrl()}/feedback/${encodeURIComponent(uuid)}`;
}

function clampRating(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

export function parseFeedbackRatings(body: Record<string, unknown>): {
  overall_rating: number;
  product_rating: number | null;
  delivery_rating: number | null;
  recommend: boolean | null;
  message: string | null;
} | { error: string } {
  const overall = clampRating(body.overall_rating ?? body.rating);
  if (overall == null) {
    return { error: "Overall rating must be an integer from 1 to 5." };
  }

  const product = body.product_rating == null || body.product_rating === ""
    ? null
    : clampRating(body.product_rating);
  if (body.product_rating != null && body.product_rating !== "" && product == null) {
    return { error: "Product rating must be an integer from 1 to 5." };
  }

  const delivery = body.delivery_rating == null || body.delivery_rating === ""
    ? null
    : clampRating(body.delivery_rating);
  if (body.delivery_rating != null && body.delivery_rating !== "" && delivery == null) {
    return { error: "Delivery rating must be an integer from 1 to 5." };
  }

  let recommend: boolean | null = null;
  if (typeof body.recommend === "boolean") {
    recommend = body.recommend;
  } else if (body.recommend === "true" || body.recommend === "yes") {
    recommend = true;
  } else if (body.recommend === "false" || body.recommend === "no") {
    recommend = false;
  }

  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  const message = rawMessage
    ? rawMessage.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, 2000)
    : null;

  return {
    overall_rating: overall,
    product_rating: product,
    delivery_rating: delivery,
    recommend,
    message,
  };
}

/**
 * Find completed/delivered orders that still need a one-time feedback email.
 * Includes orders with no feedback row, and rows where email was never marked sent.
 */
export async function listOrdersNeedingFeedbackInvite(limit = 40) {
  const delayCutoff = new Date(
    Date.now() - ORDER_FEEDBACK_DELAY_HOURS * 60 * 60 * 1000,
  );
  const lookback = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const completionFilter = {
    OR: [
      { completed_at: { lte: delayCutoff, gte: lookback } },
      {
        completed_at: null,
        status_changed_at: { lte: delayCutoff, gte: lookback },
      },
      {
        completed_at: null,
        status_changed_at: null,
        placed_at: { lte: delayCutoff, gte: lookback },
      },
    ],
  };

  return prisma.shopOrder.findMany({
    where: {
      status: { in: [...ORDER_FEEDBACK_STATUSES] },
      AND: [
        completionFilter,
        {
          OR: [
            { feedback: null },
            {
              feedback: {
                email_sent_at: null,
                status: { in: ["pending", "emailed"] },
                submitted_at: null,
              },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      order_number: true,
      user_id: true,
      total_amount: true,
      currency: true,
      completed_at: true,
      user: {
        select: {
          user_id: true,
          email: true,
          first_name: true,
          last_name: true,
        },
      },
      items: {
        select: { item_name: true, quantity: true },
        take: 5,
      },
    },
    orderBy: [{ completed_at: "asc" }, { placed_at: "asc" }],
    take: Math.min(Math.max(limit, 1), 100),
  }).then((rows) =>
    rows.filter((row) => Boolean((row.user.email ?? "").trim())),
  );
}

/**
 * Create feedback invitation + queue appreciation email (once per order).
 */
export async function createAndSendOrderFeedbackInvite(order: {
  id: bigint;
  order_number: string;
  user_id: bigint;
  currency: string;
  total_amount: unknown;
  user: {
    email: string;
    first_name: string | null;
    last_name: string | null;
  };
  items: Array<{ item_name: string; quantity: number }>;
}): Promise<{ uuid: string; queued: boolean; skipped?: string }> {
  const existing = await prisma.orderFeedback.findUnique({
    where: { order_id: order.id },
    select: { uuid: true, email_sent_at: true, status: true },
  });

  if (existing?.email_sent_at) {
    return { uuid: existing.uuid, queued: false, skipped: "already_sent" };
  }

  const recipientEmail = (order.user.email ?? "").trim();
  if (!recipientEmail) {
    return {
      uuid: existing?.uuid ?? "",
      queued: false,
      skipped: "missing_email",
    };
  }

  const uuid = existing?.uuid ?? randomUUID();
  const expiresAt = new Date(
    Date.now() + ORDER_FEEDBACK_LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const feedback = existing
    ? await prisma.orderFeedback.update({
        where: { order_id: order.id },
        data: { expires_at: expiresAt, updated_at: new Date() },
      })
    : await prisma.orderFeedback.create({
        data: {
          uuid,
          order_id: order.id,
          user_id: order.user_id,
          status: "pending",
          expires_at: expiresAt,
        },
      });

  const firstName =
    (order.user.first_name ?? "").trim() ||
    (order.user.last_name ?? "").trim() ||
    "there";
  const feedbackUrl = buildOrderFeedbackUrl(feedback.uuid);
  const itemSummary = order.items
    .map((item) => `${item.item_name} × ${item.quantity}`)
    .join(", ");

  await queueEmailForNotification({
    userId: order.user_id,
    notificationId: null,
    recipientEmail,
    recipientName: firstName,
    subject: "Thank you for your OnTap purchase — we'd love your feedback",
    templateName: ORDER_FEEDBACK_TEMPLATE,
    templateData: {
      app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
      app_url: getAppBaseUrl(),
      user_name: firstName,
      order_number: order.order_number,
      item_summary: itemSummary || "your recent purchase",
      feedback_url: feedbackUrl,
    },
    emailType: ORDER_FEEDBACK_EMAIL_TYPE,
    priority: 40,
  });

  await prisma.orderFeedback.update({
    where: { id: feedback.id },
    data: {
      status: "emailed",
      email_sent_at: new Date(),
      updated_at: new Date(),
    },
  });

  return { uuid: feedback.uuid, queued: true };
}

export async function getFeedbackByUuid(uuid: string) {
  const trimmed = uuid.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
    return null;
  }

  return prisma.orderFeedback.findUnique({
    where: { uuid: trimmed },
    include: {
      order: {
        select: {
          order_number: true,
          status: true,
          total_amount: true,
          currency: true,
          completed_at: true,
          placed_at: true,
          items: {
            select: {
              item_name: true,
              quantity: true,
              unit_price: true,
            },
          },
        },
      },
      user: {
        select: {
          first_name: true,
          last_name: true,
          email: true,
        },
      },
    },
  });
}

export async function submitOrderFeedback(
  uuid: string,
  payload: {
    overall_rating: number;
    product_rating: number | null;
    delivery_rating: number | null;
    recommend: boolean | null;
    message: string | null;
  },
) {
  const feedback = await getFeedbackByUuid(uuid);
  if (!feedback) {
    return { ok: false as const, code: "NOT_FOUND", message: "Feedback link is invalid." };
  }

  if (feedback.status === "submitted" || feedback.submitted_at) {
    return {
      ok: false as const,
      code: "ALREADY_SUBMITTED",
      message: "You already submitted feedback for this order. Thank you!",
    };
  }

  if (feedback.expires_at.getTime() < Date.now()) {
    if (feedback.status !== "expired") {
      await prisma.orderFeedback.update({
        where: { id: feedback.id },
        data: { status: "expired", updated_at: new Date() },
      });
    }
    return {
      ok: false as const,
      code: "EXPIRED",
      message: "This feedback link has expired.",
    };
  }

  const updated = await prisma.orderFeedback.update({
    where: { id: feedback.id },
    data: {
      overall_rating: payload.overall_rating,
      product_rating: payload.product_rating,
      delivery_rating: payload.delivery_rating,
      recommend: payload.recommend,
      message: payload.message,
      status: "submitted",
      submitted_at: new Date(),
      updated_at: new Date(),
    },
  });

  return { ok: true as const, feedback: updated };
}
