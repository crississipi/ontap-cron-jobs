/**
 * SuperadminNotificationsService
 *
 * Core helper used by multiple API routes and cron endpoints to:
 *  1. Find all active super_admin user IDs in the database.
 *  2. Read a specific superadmin's notification preferences (already stored in
 *     NotificationPreference.preferences -> superadmin_settings JSON blob).
 *  3. Create UserNotification records for the superadmin notification bell.
 *
 * Design principles:
 *  - No new DB tables. Uses the existing `UserNotification` and
 *    `NotificationPreference` models.
 *  - Uses the existing `randomId` utility from server/lib/notifications.
 *  - Never throws unhandled errors; always resolves (fire-and-forget safe).
 *  - Company-creation notifications carry a special `metadata.request_id` so
 *    the frontend can render inline Approve / Reject actions.
 */

import { prisma } from "@/server/lib/prisma";
import { randomId } from "@/server/lib/notifications";

// ── Shared event-type constants ────────────────────────────────────────────────
export const SA_EVENT_NEW_USER_REGISTRATION = "sa_new_user_registration";
export const SA_EVENT_USER_REPORT_SUMMARY = "sa_user_report_summary";
export const SA_EVENT_INACTIVE_USERS = "sa_inactive_users";
export const SA_EVENT_COMPANY_CREATION = "sa_company_creation_request";
export const SA_EVENT_COMPANY_APPROVED = "sa_company_request_approved";
export const SA_EVENT_COMPANY_REJECTED = "sa_company_request_rejected";

// ── Preference key names (must match SuperadminSettingsService blob keys) ──────
const PREF_KEY_NEW_REGISTRATION = "new_registration";
const PREF_KEY_USER_REPORT_FREQUENCY = "user_report_frequency";
const PREF_KEY_INACTIVE_USERS = "inactive_users";
const PREF_KEY_COMPANY_REQUESTS = "company_requests";

// ── Types ─────────────────────────────────────────────────────────────────────
interface CreateSuperadminNotificationParams {
  /** The superadmin user_id who should receive the notification */
  superadminUserId: bigint;
  /** One of the SA_EVENT_* constants above */
  eventType: string;
  /** Short title shown in the notification bell */
  title: string;
  /** Detailed message body */
  message: string;
  /** Frontend deep-link (if any) */
  actionUrl?: string;
  /** Label for the action button in the bell */
  actionText?: string;
  /** Arbitrary JSON payload (e.g. company_id for approve/reject actions) */
  metadata?: Record<string, unknown>;
  /** Notification priority – defaults to "medium" */
  priority?: "critical" | "high" | "medium" | "low";
}

export interface SuperadminUserActivityPrefs {
  new_registration: boolean;
  user_report_frequency: string | null;
  inactive_users: boolean;
  company_requests: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: parse the superadmin_settings blob from NotificationPreference
// ─────────────────────────────────────────────────────────────────────────────
function parsePreferenceBlob(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns user_id values for every active super_admin in the system.
 * Most installations have exactly one, but the function handles multiples.
 */
export async function getSuperadminUserIds(): Promise<bigint[]> {
  const superadmins = await prisma.user.findMany({
    where: { role: "super_admin", is_active: true },
    select: { user_id: true },
  });
  return superadmins.map((sa) => sa.user_id);
}

/**
 * Reads the user_activity section of the superadmin's notification preferences.
 *
 * Fallback policy (when no preference row exists or the key is absent):
 *   - new_registration  → true   (every superadmin gets new-user alerts by default)
 *   - company_requests  → true   (every superadmin gets company-request alerts by default)
 *   - inactive_users    → false  (opt-in, digest-style feature)
 *   - user_report_frequency → null
 *
 * This ensures that ALL superadmin accounts receive notifications even if they
 * have never explicitly saved their notification preferences, fixing the issue
 * where only the first superadmin (who saved preferences) received notifications.
 */
export async function getSuperadminUserActivityPrefs(
  superadminUserId: bigint,
): Promise<SuperadminUserActivityPrefs> {
  const defaults: SuperadminUserActivityPrefs = {
    new_registration: true,   // default ON — all superadmins see new registrations
    user_report_frequency: null,
    inactive_users: false,
    company_requests: true,   // default ON — all superadmins see company requests
  };

  try {
    const pref = await prisma.notificationPreference.findUnique({
      where: { user_id: superadminUserId },
      select: { preferences: true },
    });

    if (!pref) return defaults;

    const blob = parsePreferenceBlob(pref.preferences);
    const saSettings = isObjectRecord(blob.superadmin_settings) ? blob.superadmin_settings : {};
    const userActivity = isObjectRecord(saSettings.user_activity) ? saSettings.user_activity : {};

    return {
      new_registration:
        typeof userActivity[PREF_KEY_NEW_REGISTRATION] === "boolean"
          ? userActivity[PREF_KEY_NEW_REGISTRATION]
          : defaults.new_registration,
      user_report_frequency:
        typeof userActivity[PREF_KEY_USER_REPORT_FREQUENCY] === "string"
          ? (userActivity[PREF_KEY_USER_REPORT_FREQUENCY] as string)
          : defaults.user_report_frequency,
      inactive_users:
        typeof userActivity[PREF_KEY_INACTIVE_USERS] === "boolean"
          ? userActivity[PREF_KEY_INACTIVE_USERS]
          : defaults.inactive_users,
      company_requests:
        typeof userActivity[PREF_KEY_COMPANY_REQUESTS] === "boolean"
          ? userActivity[PREF_KEY_COMPANY_REQUESTS]
          : defaults.company_requests,
    };
  } catch (error) {
    console.error("[SuperadminNotifications] Failed to read prefs for", superadminUserId.toString(), error);
    return defaults;
  }
}

/**
 * Creates a single UserNotification record for a superadmin.
 * Non-throwing — logs errors and returns null on failure.
 */
export async function createSuperadminNotification(
  params: CreateSuperadminNotificationParams,
): Promise<string | null> {
  try {
    const notifId = randomId("sanotif");
    await prisma.userNotification.create({
      data: {
        id: notifId,
        user_id: params.superadminUserId,
        trigger_user_id: null,
        event_type: params.eventType,
        priority: params.priority ?? "medium",
        title: params.title,
        message: params.message,
        metadata: JSON.stringify(params.metadata ?? {}),
        action_url: params.actionUrl ?? null,
        action_text: params.actionText ?? null,
        is_read: false,
        is_archived: false,
      },
    });
    return notifId;
  } catch (error) {
    console.error(
      `[SuperadminNotifications] Failed to create notification (event=${params.eventType}) for SA ${params.superadminUserId.toString()}:`,
      error,
    );
    return null;
  }
}

/**
 * Formats a registration account/subscription mode for notification display.
 * Accepts either display labels ("Free Trial") or tier codes ("free_trial").
 */
function formatRegistrationAccountMode(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "Basic";
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  const labels: Record<string, string> = {
    free_trial: "Free Trial",
    free: "Basic",
    basic: "Basic",
    standard: "Standard",
    premium: "Premium",
    enterprise: "Enterprise",
  };
  if (labels[normalized]) return labels[normalized];
  // Preserve already-friendly labels such as "Free Trial"
  if (/^[A-Z]/.test(value) || value.includes(" ")) return value;
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

type PaidTierCode = "basic" | "standard" | "premium";

const PAID_TIER_RANK: Record<PaidTierCode, number> = {
  basic: 1,
  standard: 2,
  premium: 3,
};

function normalizePaidTierCode(raw: string | null | undefined): PaidTierCode | null {
  if (!raw) return null;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "basic" || lowered === "standard" || lowered === "premium") {
    return lowered;
  }
  return null;
}

function toUserBigInt(userId: string | number | bigint): bigint | null {
  try {
    if (typeof userId === "bigint") return userId;
    if (typeof userId === "number") {
      if (!Number.isFinite(userId) || !Number.isInteger(userId)) return null;
      return BigInt(userId);
    }
    const trimmed = userId.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Resolves the display subscription tier for Super Admin registration notifications.
 *
 * Priority (paid tier wins over an overlapping free trial — important for Premium QR merges):
 *   1. Highest active paid Bizcard tier (serial present, status active, unexpired)
 *   2. Active User free trial → "Free Trial"
 *   3. Otherwise → "Basic"
 */
export async function resolveUserAccountModeForNotification(
  userId: string | number | bigint,
): Promise<string> {
  const modes = await resolveAccountModesForUserIds([String(userId)]);
  return modes.get(String(userId)) ?? "Basic";
}

/**
 * Batch-resolves account modes for many user IDs (one bizcard query + one user query).
 * Returns a map keyed by the original string user id.
 */
export async function resolveAccountModesForUserIds(
  userIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniqueIds = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return result;

  const idPairs: Array<{ key: string; big: bigint }> = [];
  for (const key of uniqueIds) {
    const big = toUserBigInt(key);
    if (big !== null) idPairs.push({ key, big });
    else result.set(key, "Basic");
  }
  if (idPairs.length === 0) return result;

  const bigIds = idPairs.map((p) => p.big);
  const now = new Date();

  try {
    const [activeBizcards, users] = await Promise.all([
      prisma.bizcard.findMany({
        where: {
          user_id: { in: bigIds },
          serial_id: { not: null },
          subscription_status: "active",
          subscription_expires_at: { gt: now },
          deactivated_flag: false,
        },
        select: {
          user_id: true,
          subscription_tier: true,
          subscription_expires_at: true,
          bizcard_id: true,
        },
      }),
      prisma.user.findMany({
        where: { user_id: { in: bigIds } },
        select: {
          user_id: true,
          is_trial_used: true,
          trial_end: true,
        },
      }),
    ]);

    const highestPaidByUser = new Map<string, PaidTierCode>();
    for (const card of activeBizcards) {
      if (card.user_id == null) continue;
      const tier = normalizePaidTierCode(card.subscription_tier);
      if (!tier) continue;
      const uid = card.user_id.toString();
      const existing = highestPaidByUser.get(uid);
      if (!existing || PAID_TIER_RANK[tier] > PAID_TIER_RANK[existing]) {
        highestPaidByUser.set(uid, tier);
      }
    }

    const trialActiveByUser = new Map<string, boolean>();
    for (const user of users) {
      const uid = user.user_id.toString();
      const trialActive =
        Boolean(user.is_trial_used) &&
        user.trial_end != null &&
        user.trial_end > now;
      trialActiveByUser.set(uid, trialActive);
    }

    for (const { key, big } of idPairs) {
      const uid = big.toString();
      const paid = highestPaidByUser.get(uid);
      if (paid) {
        result.set(key, formatRegistrationAccountMode(paid));
        continue;
      }
      if (trialActiveByUser.get(uid)) {
        result.set(key, "Free Trial");
        continue;
      }
      result.set(key, "Basic");
    }
  } catch (error) {
    console.error("[SuperadminNotifications] resolveAccountModesForUserIds failed:", error);
    for (const { key } of idPairs) {
      if (!result.has(key)) result.set(key, "Basic");
    }
  }

  return result;
}

/**
 * Notifies ALL active superadmins whose `new_registration` preference is enabled.
 * Called from POST /api/auth/verify-email after a real User row is created.
 *
 * Account mode is always resolved from the user's live subscription / trial data
 * (caller-supplied accountMode is ignored for accuracy).
 */
export async function notifySuperadminsNewUserRegistration(params: {
  newUserId: number;
  firstName: string;
  lastName: string;
  email: string;
  registrationType: string;
  /** @deprecated Ignored — mode is resolved from DB. Kept for call-site compatibility. */
  accountMode?: string;
}): Promise<void> {
  try {
    const superadminIds = await getSuperadminUserIds();
    if (superadminIds.length === 0) return;

    const fullName = [params.firstName, params.lastName].filter(Boolean).join(" ").trim() || params.email;
    const userId = params.newUserId.toString();
    const accountMode = await resolveUserAccountModeForNotification(params.newUserId);

    await Promise.allSettled(
      superadminIds.map(async (saId) => {
        const prefs = await getSuperadminUserActivityPrefs(saId);
        if (!prefs.new_registration) return;

        await createSuperadminNotification({
          superadminUserId: saId,
          eventType: SA_EVENT_NEW_USER_REGISTRATION,
          priority: "medium",
          title: "New User Registered",
          message: `${fullName} (${accountMode}) just created an account.`,
          actionUrl: `/superadmin/client-list?viewUserId=${encodeURIComponent(userId)}`,
          actionText: "View Profile",
          metadata: {
            new_user_id: userId,
            full_name: fullName,
            email: params.email,
            registration_type: params.registrationType,
            account_mode: accountMode,
          },
        });
      }),
    );
  } catch (error) {
    // Non-fatal — registration must not fail if notifications fail
    console.error("[SuperadminNotifications] notifySuperadminsNewUserRegistration failed:", error);
  }
}

/**
 * Notifies ALL active superadmins whose `company_requests` preference is enabled.
 * Called from POST /api/company/create after the company is created with status=pending.
 */
export async function notifySuperadminsCompanyCreation(params: {
  companyId: string;
  companyName: string;
  requestingUserId: number;
  requestingUserName: string;
}): Promise<void> {
  try {
    const superadminIds = await getSuperadminUserIds();
    if (superadminIds.length === 0) return;

    await Promise.allSettled(
      superadminIds.map(async (saId) => {
        const prefs = await getSuperadminUserActivityPrefs(saId);
        if (!prefs.company_requests) return;

        await createSuperadminNotification({
          superadminUserId: saId,
          eventType: SA_EVENT_COMPANY_CREATION,
          priority: "high",
          title: "Company Creation Request",
          message: `${params.requestingUserName} requested to create "${params.companyName}". Review and approve or reject.`,
          actionUrl: `/superadmin/company-creation-requests`,
          actionText: "Review Request",
          metadata: {
            company_id: params.companyId,
            company_name: params.companyName,
            requesting_user_id: params.requestingUserId.toString(),
            requesting_user_name: params.requestingUserName,
            // request_id is the same as company_id for the approve endpoint
            request_id: params.companyId,
            requires_action: true,
          },
        });
      }),
    );
  } catch (error) {
    // Non-fatal
    console.error("[SuperadminNotifications] notifySuperadminsCompanyCreation failed:", error);
  }
}

/**
 * Creates a follow-up notification for all superadmins after a company
 * request is approved or rejected.
 */
export async function notifySuperadminsCompanyDecision(params: {
  companyId: string;
  companyName: string;
  action: "approve" | "reject";
  superadminId: number;
}): Promise<void> {
  try {
    const superadminIds = await getSuperadminUserIds();
    if (superadminIds.length === 0) return;

    const eventType =
      params.action === "approve" ? SA_EVENT_COMPANY_APPROVED : SA_EVENT_COMPANY_REJECTED;
    const title =
      params.action === "approve" ? "Company Request Approved" : "Company Request Rejected";
    const message =
      params.action === "approve"
        ? `Company "${params.companyName}" has been approved and is now active.`
        : `Company "${params.companyName}" request has been rejected.`;

    await Promise.allSettled(
      superadminIds.map((saId) =>
        createSuperadminNotification({
          superadminUserId: saId,
          eventType,
          priority: "medium",
          title,
          message,
          actionUrl: `/superadmin/company-creation-requests`,
          actionText: "View Requests",
          metadata: {
            company_id: params.companyId,
            company_name: params.companyName,
            action: params.action,
            decided_by: params.superadminId.toString(),
          },
        }),
      ),
    );
  } catch (error) {
    console.error("[SuperadminNotifications] notifySuperadminsCompanyDecision failed:", error);
  }
}
