import { prisma } from "@/server/lib/prisma";
import {
  buildTrialExperienceFollowupEmail,
  sendEmailMessage,
} from "@/server/lib/email";
import { randomId } from "@/server/lib/notifications";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Trial must have ended at least this many days ago. */
export const TRIAL_EXPERIENCE_MIN_DAYS_EXPIRED = 7;
/** Ignore very old trials so one cron run does not flood ancient accounts. */
export const TRIAL_EXPERIENCE_LOOKBACK_DAYS = 90;
const PAID_TIERS = ["basic", "standard", "premium", "enterprise"] as const;
/** Must stay ≤ 30 chars (NotificationEmailQueue.email_type). */
export const TRIAL_EXPERIENCE_EMAIL_TYPE = "trial_xp_followup";
export const TRIAL_EXPERIENCE_TEMPLATE = "trial-experience-followup";

export type TrialExperienceRunResult = {
  candidates: number;
  sent: number;
  skippedPaid: number;
  skippedDeduped: number;
  skippedNoEmail: number;
  errors: number;
  dryRun: boolean;
};

function getBaseUrl(): string {
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

async function userHasActivePaidBizcard(
  userId: bigint,
  now: Date,
): Promise<boolean> {
  const hit = await prisma.bizcard.findFirst({
    where: {
      user_id: userId,
      serial_id: { not: null },
      subscription_status: "active",
      subscription_expires_at: { gt: now },
      deactivated_flag: false,
      subscription_tier: { in: [...PAID_TIERS] },
    },
    select: { bizcard_id: true },
  });
  return Boolean(hit);
}

async function alreadySentFollowup(userId: bigint): Promise<boolean> {
  const hit = await prisma.notificationEmailQueue.findFirst({
    where: {
      user_id: userId,
      email_type: TRIAL_EXPERIENCE_EMAIL_TYPE,
      status: { in: ["queued", "sent", "sending"] },
    },
    select: { id: true },
  });
  return Boolean(hit);
}

/**
 * One-time follow-up for free-trial users whose trial expired more than 7 days ago.
 * Asks about their experience and encourages BizCards / marketplace products.
 */
export async function runTrialExperienceFollowup(
  now: Date = new Date(),
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<TrialExperienceRunResult> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 40));
  const dryRun = Boolean(options.dryRun);
  const expiredBefore = new Date(
    now.getTime() - TRIAL_EXPERIENCE_MIN_DAYS_EXPIRED * DAY_MS,
  );
  const lookbackStart = new Date(
    now.getTime() - TRIAL_EXPERIENCE_LOOKBACK_DAYS * DAY_MS,
  );

  const users = await prisma.user.findMany({
    where: {
      is_active: true,
      is_trial_used: true,
      trial_end: {
        not: null,
        lte: expiredBefore,
        gte: lookbackStart,
      },
      OR: [
        { notificationPreference: null },
        { notificationPreference: { unsubscribed_at: null } },
      ],
    },
    select: {
      user_id: true,
      email: true,
      first_name: true,
      trial_end: true,
    },
    orderBy: { trial_end: "asc" },
    take: limit * 4,
  });

  const result: TrialExperienceRunResult = {
    candidates: 0,
    sent: 0,
    skippedPaid: 0,
    skippedDeduped: 0,
    skippedNoEmail: 0,
    errors: 0,
    dryRun,
  };

  const shopUrl = `${getBaseUrl()}/user/emarket`;
  const feedbackUrl = `${getBaseUrl()}/user/inquiry`;

  for (const user of users) {
    if (result.sent + result.errors >= limit && !dryRun) break;
    if (result.candidates >= limit && dryRun) break;

    if (!user.email?.trim() || !user.trial_end) {
      result.skippedNoEmail += 1;
      continue;
    }
    if (await userHasActivePaidBizcard(user.user_id, now)) {
      result.skippedPaid += 1;
      continue;
    }
    if (await alreadySentFollowup(user.user_id)) {
      result.skippedDeduped += 1;
      continue;
    }

    result.candidates += 1;
    if (dryRun) continue;

    try {
      const daysExpired = Math.max(
        TRIAL_EXPERIENCE_MIN_DAYS_EXPIRED,
        Math.floor((now.getTime() - user.trial_end.getTime()) / DAY_MS),
      );
      const rendered = buildTrialExperienceFollowupEmail({
        firstName: user.first_name || "there",
        daysExpired,
        shopUrl,
        feedbackUrl,
      });

      await sendEmailMessage({
        to: user.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      await prisma.notificationEmailQueue.create({
        data: {
          id: randomId("email"),
          user_id: user.user_id,
          email_type: TRIAL_EXPERIENCE_EMAIL_TYPE,
          priority: 35,
          subject: rendered.subject,
          template_name: TRIAL_EXPERIENCE_TEMPLATE,
          template_data: JSON.stringify({
            days_expired: daysExpired,
            trial_end: user.trial_end.toISOString(),
            shop_url: shopUrl,
            feedback_url: feedbackUrl,
          }),
          recipient_email: user.email,
          recipient_name: user.first_name,
          status: "sent",
          sent_at: now,
          attempts: 1,
        },
      });

      result.sent += 1;
    } catch (error) {
      result.errors += 1;
      console.error(
        "[trial-experience-followup] send failed",
        user.user_id.toString(),
        error,
      );
    }
  }

  return result;
}
