import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getClientIp, getUserAgent, resolveRequestSession } from "@/server/lib/auth";

export const NOTIFICATION_EVENT_TYPES = [
  "profile_view",
  "contact_download",
  "friend_request_sent",
  "friend_request_accepted",
  "profile_shared",
  "inquiry_sent",
  "system_update",
  "subscription_expiring",
  "connection_added",
  "birthday",
  "achievement",
  "mention",
  "comment",
  "support_message_received",
  "support_escalated",
  "support_resolved",
  "direct_message_received",
  "client_order_placed",
  "client_assigned",
] as const;

export const NOTIFICATION_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const EMAIL_PRIORITIES = ["immediate", "batch", "digest"] as const;

type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];
type EmailPriority = (typeof EMAIL_PRIORITIES)[number];

const cache = new Map<string, { expiresAt: number; value: unknown }>();

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function serializeBigInts<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function isValidEventType(raw: string): raw is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(raw);
}

export function isValidPriority(raw: string): raw is NotificationPriority {
  return (NOTIFICATION_PRIORITIES as readonly string[]).includes(raw);
}

export async function requireNotificationSession(request: NextRequest) {
  const resolved = await resolveRequestSession(request);
  if (!resolved.session) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Authentication required.", requiresAuth: true }, { status: 401 }),
    };
    
  }

  return { ok: true as const, session: resolved.session, refreshed: resolved.refreshed };
}

export function isAdminRole(role: string): boolean {
  return role === "admin" || role === "company_admin";
}

export function getDefaultPreferences(): Record<string, { in_app: boolean; email: boolean; digest: boolean; priority: NotificationPriority }> {
  return {
    profile_view: { in_app: true, email: false, digest: true, priority: "medium" },
    contact_download: { in_app: true, email: true, digest: false, priority: "high" },
    friend_request_sent: { in_app: true, email: true, digest: false, priority: "critical" },
    friend_request_accepted: { in_app: true, email: false, digest: false, priority: "high" },
    profile_shared: { in_app: true, email: false, digest: true, priority: "medium" },
    inquiry_sent: { in_app: true, email: true, digest: false, priority: "high" },
    system_update: { in_app: true, email: true, digest: false, priority: "medium" },
    subscription_expiring: { in_app: true, email: true, digest: false, priority: "high" },
    connection_added: { in_app: true, email: true, digest: false, priority: "high" },
    birthday: { in_app: true, email: true, digest: false, priority: "low" },
    achievement: { in_app: true, email: false, digest: true, priority: "low" },
    mention: { in_app: true, email: true, digest: false, priority: "high" },
    comment: { in_app: true, email: true, digest: false, priority: "medium" },
    promotional: { in_app: false, email: false, digest: false, priority: "low" },
    support_message_received: { in_app: true, email: true, digest: false, priority: "high" },
    support_escalated: { in_app: true, email: true, digest: false, priority: "high" },
    support_resolved: { in_app: true, email: true, digest: false, priority: "medium" },
    direct_message_received: { in_app: true, email: false, digest: false, priority: "high" },
    client_order_placed: { in_app: true, email: true, digest: false, priority: "high" },
  };
}

export async function getOrCreateNotificationPreference(userId: bigint): Promise<{
  id: string;
  user_id: bigint;
  email_verified: boolean;
  digest_schedule: string;
  digest_time: string;
  timezone: string;
  quiet_hours: string | null;
  preferences: string;
  emails_sent_today: number;
  email_frequency_reset: Date | null;
  unsubscribed_at: Date | null;
}> {
  const existing = await prisma.notificationPreference.findUnique({
    where: { user_id: userId },
  });
  if (existing) return existing;

  return prisma.notificationPreference.create({
    data: {
      id: randomId("npref"),
      user_id: userId,
      preferences: JSON.stringify(getDefaultPreferences()),
      quiet_hours: JSON.stringify({
        enabled: false,
        start: "22:00",
        end: "08:00",
        timezone: "UTC",
      }),
      digest_schedule: "daily",
      digest_time: "08:00",
      timezone: "UTC",
      email_verified: false,
      emails_sent_today: 0,
      email_frequency_reset: new Date(),
    },
  });
}

export function shouldSuppressForQuietHours(pref: unknown, now = new Date()): boolean {
  if (!pref) return false;
  const p =
    typeof pref === "string"
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(pref);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : null;
          } catch {
            return null;
          }
        })()
      : typeof pref === "object" && !Array.isArray(pref)
        ? (pref as Record<string, unknown>)
        : null;
  if (!p) return false;
  if (p.enabled !== true) return false;
  const start = typeof p.start === "string" ? p.start : "22:00";
  const end = typeof p.end === "string" ? p.end : "08:00";
  const timezone = typeof p.timezone === "string" ? p.timezone : "UTC";
  const [sh, sm] = start.split(":").map((v) => Number(v));
  const [eh, em] = end.split(":").map((v) => Number(v));
  if (!Number.isFinite(sh) || !Number.isFinite(sm) || !Number.isFinite(eh) || !Number.isFinite(em)) return false;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const currentHour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const currentMinute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const minutes = currentHour * 60 + currentMinute;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;

  if (startMin <= endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

export function setNotificationCache(key: string, value: unknown, ttlMs: number): void {
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
}

export function getNotificationCache<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

export function clearNotificationCachePrefix(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export async function getUnreadSummary(userId: bigint) {
  const [total, byPriority] = await Promise.all([
    prisma.userNotification.count({ where: { user_id: userId, is_read: false } }),
    prisma.userNotification.groupBy({
      by: ["priority"],
      where: { user_id: userId, is_read: false },
      _count: { _all: true },
    }),
  ]);

  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of byPriority) {
    if (row.priority in summary) {
      summary[row.priority as keyof typeof summary] = row._count._all;
    }
  }

  return { unread_count: total, by_priority: summary };
}

export async function recordDeliveryEvent(params: {
  notificationId: string;
  userId: bigint;
  eventType: string;
  channel: string;
  metadata?: Record<string, unknown>;
  request?: NextRequest;
}): Promise<void> {
  const ip = params.request ? getClientIp(params.request) : null;
  const ua = params.request ? getUserAgent(params.request) : null;
  await prisma.notificationEvent.create({
    data: {
      id: randomId("nevt"),
      notification_id: params.notificationId,
      user_id: params.userId,
      event_type: params.eventType,
      channel: params.channel,
      metadata: JSON.stringify(params.metadata ?? {}),
      ip_address: ip === "unknown" ? null : ip,
      user_agent: ua ?? null,
    },
  });
}

export function buildNotificationContent(eventType: string, metadata: Record<string, unknown>): {
  title: string;
  message: string;
  action_url: string;
  action_text: string;
} {
  switch (eventType) {
    case "profile_view": {
      const viewer = typeof metadata.viewer_name === "string" ? metadata.viewer_name : "Someone";
      const biz = typeof metadata.viewer_business === "string" ? metadata.viewer_business : "their business";
      return {
        title: "New profile view",
        message: `${viewer} from ${biz} viewed your profile`,
        action_url: "/insights/visitors",
        action_text: "View Insights",
      };
    }
    case "contact_download":
      return {
        title: "Contact downloaded",
        message: "Someone downloaded your contact information",
        action_url: "/insights/contacts",
        action_text: "View Contact Insights",
      };
    case "friend_request_sent":
      return {
        title: "New friend request",
        message: "You received a new friend request",
        action_url: "/user/associate",
        action_text: "Review Request",
      };
    case "friend_request_accepted":
      return {
        title: "Friend request accepted",
        message: "Your connection request was accepted",
        action_url: "/user/associate",
        action_text: "Open Connections",
      };
    case "inquiry_sent":
      return {
        title: "New inquiry",
        message: "You received a new message inquiry",
        action_url: "/dashboard/inquiries",
        action_text: "Open Inquiry",
      };
    case "connection_added":
      return {
        title: "New connection",
        message: "You have a new confirmed connection",
        action_url: "/user/associate",
        action_text: "View Connections",
      };
    case "system_update":
      return {
        title: "System update",
        message: "Platform update is available",
        action_url: "/updates",
        action_text: "Read Update",
      };
    case "subscription_expiring": {
      const kind = typeof metadata.kind === "string" ? metadata.kind : "";
      const customTitle = typeof metadata.title === "string" ? metadata.title.trim() : "";
      const customMessage = typeof metadata.message === "string" ? metadata.message.trim() : "";
      const title =
        customTitle ||
        (kind === "free_trial"
          ? "Free trial ending"
          : kind === "expired"
            ? "Subscription expired"
            : "Subscription expiring");
      return {
        title,
        message:
          customMessage ||
          "Your subscription is about to expire. Renew now to avoid interruption.",
        action_url: "/user/emarket?tab=subscription",
        action_text: "Renew Now",
      };
    }
    case "support_message_received":
      return {
        title: "New support message",
        message: "You received a new customer support message",
        action_url: "/user/dashboard",
        action_text: "Open Support",
      };
    case "support_escalated": {
      const target = metadata.target === "super_admin" ? "Super Admin" : "Development";
      return {
        title: "Support escalated",
        message: `A support conversation was escalated to ${target}`,
        action_url: "/superadmin/support-escalations",
        action_text: "View Escalation",
      };
    }
    case "support_resolved":
      return {
        title: "Support issue resolved",
        message: "Your escalated support issue has been marked as fixed",
        action_url: "/user/dashboard",
        action_text: "View Support",
      };
    case "direct_message_received":
      return {
        title: "New message",
        message: "You received a new message from a connection",
        action_url: "/user/associate",
        action_text: "Open Messages",
      };
    case "client_order_placed": {
      const orderNumber =
        typeof metadata.order_number === "string" ? metadata.order_number : "a new order";
      const clientName =
        typeof metadata.client_name === "string" ? metadata.client_name : "A client";
      return {
        title: "New client order",
        message: `${clientName} placed order ${orderNumber}`,
        action_url: "/staff/orders",
        action_text: "View Orders",
      };
    }
    case "client_assigned": {
      const assignedClientName =
        typeof metadata.client_name === "string" ? metadata.client_name : "A client";
      return {
        title: "New client assigned",
        message: `Super Admin assigned ${assignedClientName} to you.`,
        action_url: "/staff/clients",
        action_text: "View Clients",
      };
    }
    default:
      return {
        title: "New notification",
        message: "You have a new notification",
        action_url: "/notifications",
        action_text: "Open Notifications",
      };
  }
}

export async function isBlockedEitherDirection(a: bigint, b: bigint): Promise<boolean> {
  const hit = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        { user_id: a, blocked_user_id: b },
        { user_id: b, blocked_user_id: a },
      ],
    },
    select: { id: true },
  });
  return Boolean(hit);
}

export async function queueEmailForNotification(params: {
  userId: bigint;
  notificationId?: string | null;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  templateName: string;
  templateData: Record<string, unknown>;
  emailType: string;
  priority: number;
  /** When true, SMTP-send immediately after queueing (still tracked in the queue). */
  sendNow?: boolean;
}) {
  const row = await prisma.notificationEmailQueue.create({
    data: {
      id: randomId("eq"),
      user_id: params.userId,
      notification_id: params.notificationId ?? null,
      email_type: params.emailType,
      priority: params.priority,
      subject: params.subject,
      template_name: params.templateName,
      template_data: JSON.stringify(params.templateData),
      recipient_email: params.recipientEmail,
      recipient_name: params.recipientName,
      status: "queued",
      attempts: 0,
      max_attempts: 3,
      opens: 0,
      clicks: 0,
    },
  });

  if (params.sendNow) {
    await dispatchQueuedNotificationEmail(row.id);
  }

  return row;
}

function normalizeQueuedTemplateData(input: unknown): Record<string, unknown> {
  if (!input) return {};
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** Send one queued notification email now and update queue/delivery status. */
export async function dispatchQueuedNotificationEmail(queueId: string): Promise<void> {
  const { renderNotificationTemplate } = await import("@/server/lib/notification-templates");
  const { sendEmailMessage } = await import("@/server/lib/email");

  const email = await prisma.notificationEmailQueue.findUnique({ where: { id: queueId } });
  if (!email || email.status !== "queued") return;

  try {
    const rendered = renderNotificationTemplate(
      email.template_name ?? "default",
      normalizeQueuedTemplateData(email.template_data),
    );
    await sendEmailMessage({
      to: email.recipient_email,
      subject: email.subject || rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    await prisma.notificationEmailQueue.update({
      where: { id: email.id },
      data: {
        status: "sent",
        sent_at: new Date(),
        last_attempt: new Date(),
        attempts: { increment: 1 },
        error_message: null,
      },
    });

    if (email.notification_id) {
      await prisma.notificationDelivery.updateMany({
        where: { notification_id: email.notification_id, channel: "email" },
        data: {
          status: "delivered",
          delivered_at: new Date(),
          error_message: null,
        },
      });
      await recordDeliveryEvent({
        notificationId: email.notification_id,
        userId: email.user_id,
        eventType: "delivered",
        channel: "email",
      });
    }
  } catch (error) {
    await prisma.notificationEmailQueue.update({
      where: { id: email.id },
      data: {
        status: "failed",
        attempts: { increment: 1 },
        last_attempt: new Date(),
        error_message:
          error instanceof Error ? error.message.slice(0, 1000) : "Unknown email send failure.",
      },
    });
    throw error;
  }
}

function resolveTemplateName(eventType: NotificationEventType): string {
  switch (eventType) {
    case "friend_request_sent":
      return "friend-request";
    case "profile_view":
      return "profile-view";
    case "contact_download":
      return "contact-download";
    case "system_update":
      return "system-update";
    case "subscription_expiring":
      return "system-update";
    default:
      return "default";
  }
}

function resolvePriorityWeight(priority: NotificationPriority): number {
  switch (priority) {
    case "critical":
      return 100;
    case "high":
      return 75;
    case "medium":
      return 50;
    default:
      return 10;
  }
}

export async function createNotificationFromEvent(params: {
  targetUserId: bigint;
  triggerUserId?: bigint | null;
  eventType: NotificationEventType;
  priority?: NotificationPriority;
  metadata?: Record<string, unknown>;
  needsEmail?: boolean;
  emailPriority?: EmailPriority;
}, txClient?: Prisma.TransactionClient): Promise<{
  success: boolean;
  notificationId: string | null;
  queuedForEmail: boolean;
  unreadCount: number;
  userPreferencesRespected: {
    in_app: boolean;
    email: boolean;
    digest: boolean;
  };
  reason?: string;
}> {
  const triggerUserId = params.triggerUserId ?? null;

  if (triggerUserId && triggerUserId === params.targetUserId) {
    return {
      success: false,
      notificationId: null,
      queuedForEmail: false,
      unreadCount: 0,
      userPreferencesRespected: { in_app: false, email: false, digest: false },
      reason: "self_target_blocked",
    };
  }

  const [targetUser, triggerUser] = await Promise.all([
    prisma.user.findUnique({
      where: { user_id: params.targetUserId },
      select: { user_id: true, email: true, first_name: true, is_active: true },
    }),
    triggerUserId
      ? prisma.user.findUnique({
          where: { user_id: triggerUserId },
          select: { user_id: true, first_name: true, company: { select: { name: true } } },
        })
      : Promise.resolve(null),
  ]);

  if (!targetUser || !targetUser.is_active) {
    return {
      success: false,
      notificationId: null,
      queuedForEmail: false,
      unreadCount: 0,
      userPreferencesRespected: { in_app: false, email: false, digest: false },
      reason: "target_not_found",
    };
  }

  if (triggerUserId && (await isBlockedEitherDirection(triggerUserId, params.targetUserId))) {
    return {
      success: false,
      notificationId: null,
      queuedForEmail: false,
      unreadCount: 0,
      userPreferencesRespected: { in_app: false, email: false, digest: false },
      reason: "blocked",
    };
  }

  const pref = await getOrCreateNotificationPreference(params.targetUserId);
  const prefs = (() => {
    try {
      const parsed: unknown = JSON.parse(pref.preferences);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, { in_app?: boolean; email?: boolean; digest?: boolean; priority?: string }>;
      }
      return {};
    } catch {
      return {};
    }
  })();
  const perType = prefs?.[params.eventType] ?? getDefaultPreferences()[params.eventType];
  const resolvedPriority = params.priority ?? (isValidPriority(String(perType.priority)) ? (perType.priority as NotificationPriority) : "medium");
  const resolvedEmailPriority = params.emailPriority ?? (perType.digest ? "digest" : "batch");

  const shouldInApp = perType.in_app !== false;
  const emailRequested = params.needsEmail === true;
  const shouldEmail =
    emailRequested &&
    pref.unsubscribed_at === null &&
    pref.email_verified === true &&
    perType.email === true &&
    !shouldSuppressForQuietHours(pref.quiet_hours);

  if (!shouldInApp && !shouldEmail && perType.digest !== true) {
    const digestEnabled = Boolean(perType.digest);
    const unread = await getUnreadSummary(params.targetUserId);
    return {
      success: false,
      notificationId: null,
      queuedForEmail: false,
      unreadCount: unread.unread_count,
      userPreferencesRespected: {
        in_app: false,
        email: false,
        digest: digestEnabled,
      },
      reason: "suppressed_by_preferences",
    };
  }

  const content = buildNotificationContent(params.eventType, params.metadata ?? {});
  const notificationId = randomId("notif");

  // Use a single transaction to write notification and delivery records to avoid
  // long-lived interactive transactions and reduce chances of transaction ID errors.
  const ops = [];

  if (shouldInApp || shouldEmail || perType.digest === true) {
    ops.push(
      prisma.userNotification.create({
        data: {
          id: notificationId,
          user_id: params.targetUserId,
          trigger_user_id: triggerUserId,
          event_type: params.eventType,
          priority: resolvedPriority,
          title: content.title,
          message: content.message,
          metadata: JSON.stringify(params.metadata ?? {}),
          action_url: content.action_url,
          action_text: content.action_text,
        },
      })
    );

    ops.push(
      prisma.notificationDelivery.create({
        data: {
          id: randomId("ndel"),
          notification_id: notificationId,
          channel: "in_app",
          status: shouldInApp ? "delivered" : "pending",
          delivered_at: shouldInApp ? new Date() : null,
        },
      })
    );
  }

  if (shouldEmail) {
    // create email queue entry and delivery record in the same transaction
    ops.push(
      prisma.notificationEmailQueue.create({
        data: {
          id: randomId("eq"),
          user_id: params.targetUserId,
          notification_id: notificationId ?? null,
          email_type: resolvedEmailPriority,
          priority: resolvePriorityWeight(resolvedPriority),
          subject: content.title,
          template_name: resolveTemplateName(params.eventType),
          template_data: JSON.stringify({
            ...(params.metadata ?? {}),
            app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
            user_name: targetUser.first_name,
            sender_name: triggerUser?.first_name,
            sender_business: triggerUser?.company?.name ?? null,
            title: content.title,
            message: content.message,
            app_url: process.env.FRONTEND_URL ?? "",
          }),
          recipient_email: targetUser.email,
          recipient_name: targetUser.first_name,
          status: "queued",
          attempts: 0,
          max_attempts: 3,
          opens: 0,
          clicks: 0,
        },
      })
    );

    ops.push(
      prisma.notificationDelivery.create({
        data: {
          id: randomId("ndel"),
          notification_id: notificationId,
          channel: "email",
          status: "pending",
        },
      })
    );
  }

  if (ops.length > 0) {
    try {
      if (txClient) {
        // If caller gave us a transaction client, use it directly.
        // Write sequentially on the provided transaction client to keep ordering.
        await txClient.userNotification.create({
          data: {
            id: notificationId,
            user_id: params.targetUserId,
            trigger_user_id: triggerUserId,
            event_type: params.eventType,
            priority: resolvedPriority,
            title: content.title,
            message: content.message,
            metadata: JSON.stringify(params.metadata ?? {}),
            action_url: content.action_url,
            action_text: content.action_text,
          },
        });

        if (shouldInApp || shouldEmail || perType.digest === true) {
          await txClient.notificationDelivery.create({
            data: {
              id: randomId("ndel"),
              notification_id: notificationId,
              channel: "in_app",
              status: shouldInApp ? "delivered" : "pending",
              delivered_at: shouldInApp ? new Date() : null,
            },
          });
        }

        if (shouldEmail) {
          await txClient.notificationEmailQueue.create({
            data: {
              id: randomId("eq"),
              user_id: params.targetUserId,
              notification_id: notificationId ?? null,
              email_type: resolvedEmailPriority,
              priority: resolvePriorityWeight(resolvedPriority),
              subject: content.title,
              template_name: resolveTemplateName(params.eventType),
              template_data: JSON.stringify({
                ...(params.metadata ?? {}),
                app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
                user_name: targetUser.first_name,
                sender_name: triggerUser?.first_name,
                sender_business: triggerUser?.company?.name ?? null,
                title: content.title,
                message: content.message,
                app_url: process.env.FRONTEND_URL ?? "",
              }),
              recipient_email: targetUser.email,
              recipient_name: targetUser.first_name,
              status: "queued",
              attempts: 0,
              max_attempts: 3,
              opens: 0,
              clicks: 0,
            },
          });

          await txClient.notificationDelivery.create({
            data: {
              id: randomId("ndel"),
              notification_id: notificationId,
              channel: "email",
              status: "pending",
            },
          });
        }
      } else {
        // Prefer array-style transaction for speed; if it fails, we'll fallback
        // to a callback-style transaction which creates a fresh transaction client.
        try {
          await prisma.$transaction(ops);
        } catch (innerErr) {
          console.error('[Notifications] Transaction array failed, retrying with callback transaction:', innerErr);
          try {
            await prisma.$transaction(async (tx) => {
              // recreate writes sequentially inside a fresh transaction
              await tx.userNotification.create({
                data: {
                  id: notificationId,
                  user_id: params.targetUserId,
                  trigger_user_id: triggerUserId,
                  event_type: params.eventType,
                  priority: resolvedPriority,
                  title: content.title,
                  message: content.message,
                  metadata: JSON.stringify(params.metadata ?? {}),
                  action_url: content.action_url,
                  action_text: content.action_text,
                },
              });

              if (shouldInApp || shouldEmail || perType.digest === true) {
                await tx.notificationDelivery.create({
                  data: {
                    id: randomId("ndel"),
                    notification_id: notificationId,
                    channel: "in_app",
                    status: shouldInApp ? "delivered" : "pending",
                    delivered_at: shouldInApp ? new Date() : null,
                  },
                });
              }

              if (shouldEmail) {
                await tx.notificationEmailQueue.create({
                  data: {
                    id: randomId("eq"),
                    user_id: params.targetUserId,
                    notification_id: notificationId ?? null,
                    email_type: resolvedEmailPriority,
                    priority: resolvePriorityWeight(resolvedPriority),
                    subject: content.title,
                    template_name: resolveTemplateName(params.eventType),
                    template_data: JSON.stringify({
                      ...(params.metadata ?? {}),
                      app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
                      user_name: targetUser.first_name,
                      sender_name: triggerUser?.first_name,
                      sender_business: triggerUser?.company?.name ?? null,
                      title: content.title,
                      message: content.message,
                      app_url: process.env.FRONTEND_URL ?? "",
                    }),
                    recipient_email: targetUser.email,
                    recipient_name: targetUser.first_name,
                    status: "queued",
                    attempts: 0,
                    max_attempts: 3,
                    opens: 0,
                    clicks: 0,
                  },
                });

                await tx.notificationDelivery.create({
                  data: {
                    id: randomId("ndel"),
                    notification_id: notificationId,
                    channel: "email",
                    status: "pending",
                  },
                });
              }
            });
          } catch (finalErr) {
            console.error('[Notifications] Callback transaction retry failed:', finalErr);
            // Final fallback: attempt to reset the Prisma connection and perform
            // best-effort individual writes. This can clear stale transaction
            // state that sometimes causes "Transaction not found" errors.
            try {
              try {
                await prisma.$disconnect();
              } catch (_) {}
              await prisma.$connect();

              // Best-effort individual writes without a surrounding transaction
              await prisma.userNotification.create({
                data: {
                  id: notificationId,
                  user_id: params.targetUserId,
                  trigger_user_id: triggerUserId,
                  event_type: params.eventType,
                  priority: resolvedPriority,
                  title: content.title,
                  message: content.message,
                  metadata: JSON.stringify(params.metadata ?? {}),
                  action_url: content.action_url,
                  action_text: content.action_text,
                },
              });

              if (shouldInApp || shouldEmail || perType.digest === true) {
                await prisma.notificationDelivery.create({
                  data: {
                    id: randomId("ndel"),
                    notification_id: notificationId,
                    channel: "in_app",
                    status: shouldInApp ? "delivered" : "pending",
                    delivered_at: shouldInApp ? new Date() : null,
                  },
                });
              }

              if (shouldEmail) {
                await prisma.notificationEmailQueue.create({
                  data: {
                    id: randomId("eq"),
                    user_id: params.targetUserId,
                    notification_id: notificationId ?? null,
                    email_type: resolvedEmailPriority,
                    priority: resolvePriorityWeight(resolvedPriority),
                    subject: content.title,
                    template_name: resolveTemplateName(params.eventType),
                    template_data: JSON.stringify({
                      ...(params.metadata ?? {}),
                      app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
                      user_name: targetUser.first_name,
                      sender_name: triggerUser?.first_name,
                      sender_business: triggerUser?.company?.name ?? null,
                      title: content.title,
                      message: content.message,
                      app_url: process.env.FRONTEND_URL ?? "",
                    }),
                    recipient_email: targetUser.email,
                    recipient_name: targetUser.first_name,
                    status: "queued",
                    attempts: 0,
                    max_attempts: 3,
                    opens: 0,
                    clicks: 0,
                  },
                });

                await prisma.notificationDelivery.create({
                  data: {
                    id: randomId("ndel"),
                    notification_id: notificationId,
                    channel: "email",
                    status: "pending",
                  },
                });
              }
            } catch (finalFallbackErr) {
              console.error('[Notifications] Final fallback failed to write notification records:', finalFallbackErr);
            }
          }
        }
      }
    } catch (err) {
      console.error('[Notifications] Error writing notification records in transaction or fallback:', err);
    }
  }

  clearNotificationCachePrefix(`notifications:${params.targetUserId.toString()}:`);
  const unread = await getUnreadSummary(params.targetUserId);

  return {
    success: true,
    notificationId,
    queuedForEmail: shouldEmail,
    unreadCount: unread.unread_count,
    userPreferencesRespected: {
      in_app: shouldInApp,
      email: shouldEmail,
      digest: perType.digest === true,
    },
  };
}

export function buildDigestItems(notifications: Array<{
  title: string | null;
  message: string | null;
  event_type: string;
}>): Array<{ title: string; message: string; count: number }> {
  const grouped = new Map<string, { title: string; message: string; count: number }>();

  for (const notification of notifications) {
    const key = `${notification.event_type}:${notification.title ?? ""}:${notification.message ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    grouped.set(key, {
      title: notification.title ?? "Update",
      message: notification.message ?? "You have a new notification.",
      count: 1,
    });
  }

  return Array.from(grouped.values());
}

export async function notifyAssignedStaffForOrder(
  clientUserId: bigint,
  orderId: bigint,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const assignments = await prisma.staffClientAssignment.findMany({
    where: { client_user_id: clientUserId, is_active: true },
    select: {
      staff_id: true,
      client: {
        select: { first_name: true, last_name: true, email: true },
      },
    },
  });

  if (assignments.length === 0) return;

  const client = assignments[0]?.client;
  const clientName =
    [client?.first_name, client?.last_name].filter(Boolean).join(" ").trim() ||
    client?.email ||
    "Client";

  await Promise.allSettled(
    assignments.map((assignment) =>
      createNotificationFromEvent({
        targetUserId: assignment.staff_id,
        triggerUserId: clientUserId,
        eventType: "client_order_placed",
        priority: "high",
        metadata: {
          ...metadata,
          order_id: orderId.toString(),
          client_name: clientName,
        },
        needsEmail: true,
        emailPriority: "immediate",
      }),
    ),
  );
}
