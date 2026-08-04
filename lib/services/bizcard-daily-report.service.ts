import { prisma } from "@/server/lib/prisma";
import { prismaAnalytics } from "@/server/lib/prisma-analytics";
import {
  buildBizcardDailyReportEmail,
  sendEmailMessage,
} from "@/server/lib/email";
import { randomId } from "@/server/lib/notifications";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Must stay ≤ 30 chars (NotificationEmailQueue.email_type). */
export const BIZCARD_DAILY_EMAIL_TYPE = "bizcard_daily_rpt";
export const BIZCARD_DAILY_TEMPLATE = "bizcard-daily-report";

export type BizcardDailyMetrics = {
  userId: bigint;
  profileViews: number;
  contactSaves: number;
  inquiries: number;
};

export type BizcardDailyRunResult = {
  reportDate: string;
  windowStart: string;
  windowEnd: string;
  candidates: number;
  sent: number;
  skippedDeduped: number;
  skippedNoEmail: number;
  skippedInactive: number;
  errors: number;
  dryRun: boolean;
};

function formatUtcDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

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

/** Previous complete UTC calendar day. */
export function getPreviousUtcDayWindow(now: Date = new Date()): {
  dayStart: Date;
  dayEnd: Date;
  reportDate: string;
} {
  const todayStart = startOfUtcDay(now);
  const dayStart = new Date(todayStart.getTime() - DAY_MS);
  return {
    dayStart,
    dayEnd: todayStart,
    reportDate: formatUtcDateKey(dayStart),
  };
}

async function alreadySentReport(
  userId: bigint,
  reportDate: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 4 * DAY_MS);
  const rows = await prisma.notificationEmailQueue.findMany({
    where: {
      user_id: userId,
      email_type: BIZCARD_DAILY_EMAIL_TYPE,
      status: { in: ["queued", "sent", "sending"] },
      created_at: { gte: since },
    },
    select: { template_data: true },
    take: 10,
  });

  for (const row of rows) {
    if (!row.template_data) continue;
    try {
      const parsed = JSON.parse(row.template_data) as { report_date?: string };
      if (parsed.report_date === reportDate) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Aggregate users who had at least one profile view, contact save, or inquiry
 * during the report window.
 */
export async function collectBizcardDailyActivity(
  dayStart: Date,
  dayEnd: Date,
): Promise<BizcardDailyMetrics[]> {
  const [viewGroups, saveGroups, inquiryGroups] = await Promise.all([
    prismaAnalytics.portfolioView.groupBy({
      by: ["portfolio_owner_id"],
      where: { created_at: { gte: dayStart, lt: dayEnd } },
      _count: { _all: true },
    }),
    prismaAnalytics.contactSave.groupBy({
      by: ["portfolio_owner_id"],
      where: { created_at: { gte: dayStart, lt: dayEnd } },
      _count: { _all: true },
    }),
    prisma.inquiry.groupBy({
      by: ["user_id"],
      where: { created_at: { gte: dayStart, lt: dayEnd } },
      _count: { _all: true },
    }),
  ]);

  const byUser = new Map<string, BizcardDailyMetrics>();

  const ensure = (userId: bigint): BizcardDailyMetrics => {
    const key = userId.toString();
    let row = byUser.get(key);
    if (!row) {
      row = {
        userId,
        profileViews: 0,
        contactSaves: 0,
        inquiries: 0,
      };
      byUser.set(key, row);
    }
    return row;
  };

  for (const row of viewGroups) {
    ensure(row.portfolio_owner_id).profileViews = row._count._all;
  }
  for (const row of saveGroups) {
    ensure(row.portfolio_owner_id).contactSaves = row._count._all;
  }
  for (const row of inquiryGroups) {
    ensure(row.user_id).inquiries = row._count._all;
  }

  return Array.from(byUser.values()).filter(
    (m) => m.profileViews > 0 || m.contactSaves > 0 || m.inquiries > 0,
  );
}

/**
 * Daily BizCard activity report — only emails users with new profile views,
 * contact saves, or inquiries in the previous UTC day.
 */
export async function runBizcardDailyReport(
  now: Date = new Date(),
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<BizcardDailyRunResult> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const dryRun = Boolean(options.dryRun);
  const { dayStart, dayEnd, reportDate } = getPreviousUtcDayWindow(now);

  const activity = await collectBizcardDailyActivity(dayStart, dayEnd);
  const result: BizcardDailyRunResult = {
    reportDate,
    windowStart: dayStart.toISOString(),
    windowEnd: dayEnd.toISOString(),
    candidates: activity.length,
    sent: 0,
    skippedDeduped: 0,
    skippedNoEmail: 0,
    skippedInactive: 0,
    errors: 0,
    dryRun,
  };

  if (activity.length === 0) return result;

  const analyticsUrl = `${getBaseUrl()}/user/analytics`;
  const inquiryUrl = `${getBaseUrl()}/user/inquiry`;
  const batch = activity.slice(0, limit);
  const userIds = batch.map((m) => m.userId);

  const users = await prisma.user.findMany({
    where: { user_id: { in: userIds } },
    select: {
      user_id: true,
      email: true,
      first_name: true,
      is_active: true,
      notificationPreference: {
        select: { unsubscribed_at: true },
      },
    },
  });
  const userMap = new Map(users.map((u) => [u.user_id.toString(), u]));

  for (const metrics of batch) {
    const user = userMap.get(metrics.userId.toString());
    if (!user || !user.is_active) {
      result.skippedInactive += 1;
      continue;
    }
    if (user.notificationPreference?.unsubscribed_at) {
      result.skippedInactive += 1;
      continue;
    }
    if (!user.email?.trim()) {
      result.skippedNoEmail += 1;
      continue;
    }
    if (await alreadySentReport(user.user_id, reportDate)) {
      result.skippedDeduped += 1;
      continue;
    }

    if (dryRun) {
      continue;
    }

    try {
      const rendered = buildBizcardDailyReportEmail({
        firstName: user.first_name || "there",
        reportDate,
        profileViews: metrics.profileViews,
        contactSaves: metrics.contactSaves,
        inquiries: metrics.inquiries,
        analyticsUrl,
        inquiryUrl,
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
          email_type: BIZCARD_DAILY_EMAIL_TYPE,
          priority: 30,
          subject: rendered.subject,
          template_name: BIZCARD_DAILY_TEMPLATE,
          template_data: JSON.stringify({
            report_date: reportDate,
            profile_views: metrics.profileViews,
            contact_saves: metrics.contactSaves,
            inquiries: metrics.inquiries,
            analytics_url: analyticsUrl,
            inquiry_url: inquiryUrl,
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
        "[bizcard-daily-report] send failed",
        user.user_id.toString(),
        error,
      );
    }
  }

  return result;
}
