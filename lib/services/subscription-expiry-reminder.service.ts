import { prisma } from "@/server/lib/prisma";
import { buildSubscriptionExpiryEmail, sendEmailMessage } from "@/server/lib/email";
import { createNotificationFromEvent } from "@/server/lib/notifications";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAID_REMINDER_DAYS = new Set([3, 1]);
const PAID_TIERS = ["basic", "standard", "premium", "enterprise"] as const;
const RENEW_PATH = "/user/emarket?tab=subscription";
const EVENT_TYPE = "subscription_expiring" as const;

export type ReminderKind = "free_trial" | "paid_subscription" | "expired";

export type ReminderCandidate = {
  userId: bigint;
  email: string;
  firstName: string;
  kind: ReminderKind;
  daysRemaining: number;
  expiresAt: Date;
  planLabel?: string;
  bizcardName?: string;
};

export type ReminderRunResult = {
  processed: number;
  notified: number;
  emailsSent: number;
  skippedDeduped: number;
  skippedNoEmail: number;
  errors: number;
};

function getBaseUrl(): string {
  const explicit = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.FRONTEND_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    return vercelUrl.startsWith("http") ? vercelUrl.replace(/\/$/, "") : `https://${vercelUrl}`;
  }

  return "http://localhost:3000";
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatUtcDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Ceiling days remaining until expiry (0 if already expired). */
export function computeDaysRemaining(expiresAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS));
}

export function buildReminderKey(params: {
  kind: ReminderKind;
  daysRemaining: number;
  date: Date;
}): string {
  const dayKey = formatUtcDateKey(params.date);
  if (params.kind === "expired") {
    return `expired:${dayKey}`;
  }
  if (params.kind === "free_trial") {
    return `trial:${params.daysRemaining}:${dayKey}`;
  }
  return `paid:${params.daysRemaining}:${dayKey}`;
}

export function buildReminderMessage(kind: ReminderKind, daysRemaining: number): string {
  if (kind === "free_trial") {
    return "Your free trial is about to expire. Subscribe now to continue using the service.";
  }
  if (kind === "expired") {
    return "Your subscription has expired. Please renew to continue using the service.";
  }
  if (daysRemaining === 1) {
    return "Your subscription will expire in 1 day. Renew now to avoid interruption.";
  }
  return `Your subscription will expire in ${daysRemaining} days. Renew now to avoid interruption.`;
}

export function buildReminderTitle(kind: ReminderKind): string {
  if (kind === "free_trial") return "Free trial ending";
  if (kind === "expired") return "Subscription expired";
  return "Subscription expiring";
}

export function shouldWarnForExpiry(params: {
  kind: ReminderKind | "free_trial" | "paid_subscription" | null;
  daysRemaining: number;
  expired: boolean;
}): boolean {
  if (params.expired || params.kind === "expired") return true;
  if (params.kind === "free_trial" && params.daysRemaining === 1) return true;
  if (params.kind === "paid_subscription" && PAID_REMINDER_DAYS.has(params.daysRemaining)) {
    return true;
  }
  return false;
}

function isSameUtcCalendarDay(a: Date, b: Date): boolean {
  return formatUtcDateKey(a) === formatUtcDateKey(b);
}

async function userHasActivePaidBizcard(userId: bigint, now: Date): Promise<boolean> {
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

async function alreadySentReminder(userId: bigint, reminderKey: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await prisma.userNotification.findMany({
    where: {
      user_id: userId,
      event_type: EVENT_TYPE,
      created_at: { gte: since },
    },
    select: { metadata: true },
    take: 50,
  });

  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const parsed = JSON.parse(row.metadata) as { reminder_key?: string };
      if (parsed.reminder_key === reminderKey) return true;
    } catch {
      // ignore malformed metadata
    }
  }
  return false;
}

async function collectFreeTrialCandidates(now: Date): Promise<ReminderCandidate[]> {
  const windowStart = new Date(now.getTime());
  const windowEnd = new Date(now.getTime() + 2 * DAY_MS);

  const users = await prisma.user.findMany({
    where: {
      is_active: true,
      is_trial_used: true,
      trial_end: {
        gt: windowStart,
        lte: windowEnd,
      },
    },
    select: {
      user_id: true,
      email: true,
      first_name: true,
      trial_end: true,
    },
  });

  const candidates: ReminderCandidate[] = [];
  for (const user of users) {
    if (!user.trial_end || !user.email) continue;
    const days = computeDaysRemaining(user.trial_end, now);
    if (days !== 1) continue;
    if (await userHasActivePaidBizcard(user.user_id, now)) continue;

    candidates.push({
      userId: user.user_id,
      email: user.email,
      firstName: user.first_name || "",
      kind: "free_trial",
      daysRemaining: 1,
      expiresAt: user.trial_end,
      planLabel: "Free Trial",
    });
  }
  return candidates;
}

async function collectPaidCandidates(now: Date): Promise<ReminderCandidate[]> {
  const windowEnd = new Date(now.getTime() + 4 * DAY_MS);

  const bizcards = await prisma.bizcard.findMany({
    where: {
      serial_id: { not: null },
      subscription_status: "active",
      deactivated_flag: false,
      subscription_expires_at: {
        gt: now,
        lte: windowEnd,
      },
      subscription_tier: { in: [...PAID_TIERS] },
      user: { is_active: true },
    },
    select: {
      user_id: true,
      bizcard_name: true,
      subscription_tier: true,
      subscription_expires_at: true,
      user: {
        select: {
          email: true,
          first_name: true,
        },
      },
    },
  });

  const byUser = new Map<bigint, ReminderCandidate>();

  for (const card of bizcards) {
    if (!card.user_id || !card.subscription_expires_at || !card.user?.email) continue;
    const days = computeDaysRemaining(card.subscription_expires_at, now);
    if (!PAID_REMINDER_DAYS.has(days)) continue;

    const existing = byUser.get(card.user_id);
    if (existing && existing.expiresAt <= card.subscription_expires_at) continue;

    byUser.set(card.user_id, {
      userId: card.user_id,
      email: card.user.email,
      firstName: card.user.first_name || "",
      kind: "paid_subscription",
      daysRemaining: days,
      expiresAt: card.subscription_expires_at,
      planLabel: card.subscription_tier || "Subscription",
      bizcardName: card.bizcard_name || "BizCard",
    });
  }

  return Array.from(byUser.values());
}

async function collectExpiredTodayCandidates(now: Date): Promise<ReminderCandidate[]> {
  const dayStart = startOfUtcDay(now);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const candidates: ReminderCandidate[] = [];
  const seen = new Set<string>();

  const trialUsers = await prisma.user.findMany({
    where: {
      is_active: true,
      is_trial_used: true,
      trial_end: {
        gte: dayStart,
        lt: dayEnd,
      },
    },
    select: {
      user_id: true,
      email: true,
      first_name: true,
      trial_end: true,
    },
  });

  for (const user of trialUsers) {
    if (!user.trial_end || !user.email) continue;
    if (user.trial_end > now) continue;
    if (!isSameUtcCalendarDay(user.trial_end, now)) continue;
    if (await userHasActivePaidBizcard(user.user_id, now)) continue;

    const key = `trial:${user.user_id.toString()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      userId: user.user_id,
      email: user.email,
      firstName: user.first_name || "",
      kind: "expired",
      daysRemaining: 0,
      expiresAt: user.trial_end,
      planLabel: "Free Trial",
    });
  }

  const expiredCards = await prisma.bizcard.findMany({
    where: {
      serial_id: { not: null },
      deactivated_flag: false,
      subscription_expires_at: {
        gte: dayStart,
        lt: dayEnd,
      },
      subscription_tier: { in: [...PAID_TIERS] },
      user: { is_active: true },
    },
    select: {
      user_id: true,
      bizcard_name: true,
      subscription_tier: true,
      subscription_expires_at: true,
      user: {
        select: {
          email: true,
          first_name: true,
        },
      },
    },
  });

  for (const card of expiredCards) {
    if (!card.user_id || !card.subscription_expires_at || !card.user?.email) continue;
    if (card.subscription_expires_at > now) continue;
    if (!isSameUtcCalendarDay(card.subscription_expires_at, now)) continue;
    if (await userHasActivePaidBizcard(card.user_id, now)) continue;

    const key = `paid:${card.user_id.toString()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      userId: card.user_id,
      email: card.user.email,
      firstName: card.user.first_name || "",
      kind: "expired",
      daysRemaining: 0,
      expiresAt: card.subscription_expires_at,
      planLabel: card.subscription_tier || "Subscription",
      bizcardName: card.bizcard_name || "BizCard",
    });
  }

  return candidates;
}

async function sendReminderEmail(candidate: ReminderCandidate, message: string): Promise<boolean> {
  const renewUrl = `${getBaseUrl()}${RENEW_PATH}`;
  const title = buildReminderTitle(candidate.kind);
  const rendered = buildSubscriptionExpiryEmail({
    firstName: candidate.firstName || "there",
    title,
    message,
    renewUrl,
    expiresAt: candidate.expiresAt,
    planLabel: candidate.planLabel,
    bizcardName: candidate.bizcardName,
    kind: candidate.kind,
  });

  try {
    await sendEmailMessage({
      to: candidate.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    return true;
  } catch (error) {
    console.error(
      `[CRON_SUBSCRIPTION_EXPIRY] Failed to send reminder email to ${candidate.email}:`,
      error,
    );
    return false;
  }
}

async function notifyCandidate(
  candidate: ReminderCandidate,
  now: Date,
): Promise<"deduped" | "error" | { status: "notified"; emailed: boolean }> {
  const reminderKey = buildReminderKey({
    kind: candidate.kind,
    daysRemaining: candidate.daysRemaining,
    date: now,
  });

  if (await alreadySentReminder(candidate.userId, reminderKey, now)) {
    return "deduped";
  }

  const message = buildReminderMessage(candidate.kind, candidate.daysRemaining);
  const title = buildReminderTitle(candidate.kind);

  try {
    await createNotificationFromEvent({
      targetUserId: candidate.userId,
      eventType: EVENT_TYPE,
      priority: "high",
      needsEmail: false,
      metadata: {
        reminder_key: reminderKey,
        kind: candidate.kind,
        days_remaining: candidate.daysRemaining,
        message,
        title,
        expires_at: candidate.expiresAt.toISOString(),
        plan_label: candidate.planLabel ?? null,
        bizcard_name: candidate.bizcardName ?? null,
      },
    });

    const emailed = await sendReminderEmail(candidate, message);
    return { status: "notified", emailed };
  } catch (error) {
    console.error(
      `[CRON_SUBSCRIPTION_EXPIRY] Failed to notify user ${candidate.userId.toString()}:`,
      error,
    );
    return "error";
  }
}

/**
 * Archive pending subscription expiry warnings after renewal/upgrade.
 */
export async function archiveSubscriptionExpiryWarnings(userId: bigint): Promise<number> {
  const result = await prisma.userNotification.updateMany({
    where: {
      user_id: userId,
      event_type: EVENT_TYPE,
      is_archived: false,
    },
    data: {
      is_archived: true,
      is_read: true,
      read_at: new Date(),
      updated_at: new Date(),
    },
  });
  return result.count;
}

/**
 * Daily subscription expiry reminder runner (invoked by HTTP cron).
 */
export async function runSubscriptionExpiryReminders(now: Date = new Date()): Promise<ReminderRunResult> {
  const [trial, paid, expired] = await Promise.all([
    collectFreeTrialCandidates(now),
    collectPaidCandidates(now),
    collectExpiredTodayCandidates(now),
  ]);

  // Prefer a single reminder per user: paid > trial > expired for overlapping sets.
  const byUser = new Map<bigint, ReminderCandidate>();
  const priority: Record<ReminderKind, number> = {
    paid_subscription: 3,
    free_trial: 2,
    expired: 1,
  };

  for (const candidate of [...paid, ...trial, ...expired]) {
    const existing = byUser.get(candidate.userId);
    if (!existing || priority[candidate.kind] > priority[existing.kind]) {
      byUser.set(candidate.userId, candidate);
    }
  }

  const candidates = Array.from(byUser.values());
  let notified = 0;
  let emailsSent = 0;
  let skippedDeduped = 0;
  let skippedNoEmail = 0;
  let errors = 0;

  for (const candidate of candidates) {
    if (!candidate.email.trim()) {
      skippedNoEmail += 1;
      continue;
    }

    const result = await notifyCandidate(candidate, now);
    if (result === "deduped") {
      skippedDeduped += 1;
      continue;
    }
    if (result === "error") {
      errors += 1;
      continue;
    }

    notified += 1;
    if (typeof result === "object" && result.emailed) {
      emailsSent += 1;
    }
  }

  return {
    processed: candidates.length,
    notified,
    emailsSent,
    skippedDeduped,
    skippedNoEmail,
    errors,
  };
}
