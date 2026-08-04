import { prisma } from "@/server/lib/prisma";
import {
  clearNotificationCachePrefix,
  getDefaultPreferences,
  getOrCreateNotificationPreference,
  queueEmailForNotification,
  randomId,
  shouldSuppressForQuietHours,
} from "@/server/lib/notifications";
import { getLocalParts, isDigestDue } from "@/server/lib/notification-cron";
import { CompanyDashboardService } from "@/lib/services/company-dashboard.service";
import {
  CompanyNotificationErrorCode,
  createCompanyNotificationError,
} from "@/lib/errors/company-notification-errors";

const DIGEST_SCHEDULES = ["daily", "weekly", "never"] as const;
const PRIORITIES = ["critical", "high", "medium", "low"] as const;

type NotificationPriority = (typeof PRIORITIES)[number];
export type DigestSchedule = (typeof DIGEST_SCHEDULES)[number];

export interface EventPreference {
  in_app: boolean;
  email: boolean;
  digest: boolean;
  push?: boolean;
  priority: NotificationPriority;
}

export type EventPreferenceMap = Record<string, EventPreference>;

export interface QuietHoursSettings {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
}

export interface CompanyNotificationPolicy {
  join_request_enabled: boolean;
  company_details_changed_enabled: boolean;
  co_admin_changes_enabled: boolean;
  employee_management_enabled: boolean;
  daily_summary_enabled: boolean;
  weekly_summary_enabled: boolean;
  top_performer_alert_enabled: boolean;
  top_performer_alert_time: string;
  employee_daily_statistics_enabled: boolean;
  employee_weekly_statistics_enabled: boolean;
  employee_top_performer_enabled: boolean;
  timezone: string;
}

export interface CompanyNotificationPolicyPatch {
  join_request_enabled?: boolean;
  company_details_changed_enabled?: boolean;
  co_admin_changes_enabled?: boolean;
  employee_management_enabled?: boolean;
  daily_summary_enabled?: boolean;
  weekly_summary_enabled?: boolean;
  top_performer_alert_enabled?: boolean;
  top_performer_alert_time?: string;
  employee_daily_statistics_enabled?: boolean;
  employee_weekly_statistics_enabled?: boolean;
  employee_top_performer_enabled?: boolean;
  timezone?: string;
}

export interface EmployeeNotificationPreferencePatch {
  digest_schedule?: DigestSchedule;
  digest_time?: string;
  timezone?: string;
  quiet_hours?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
}

export interface CompanyNotificationQueueResult {
  companies_scanned: number;
  recipients_scanned: number;
  queued: number;
  skipped: number;
  failed: number;
}

interface NotificationPreferenceSnapshot {
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
  last_digest_sent: Date | null;
  unsubscribed_at: Date | null;
}

interface CompanyNotificationRecipient {
  userId: bigint;
  email: string;
  firstName: string;
  preference: NotificationPreferenceSnapshot;
}

const DEFAULT_EVENT_PREFERENCE: EventPreference = {
  in_app: true,
  email: false,
  digest: false,
  push: false,
  priority: "medium",
};

const DEFAULT_QUIET_HOURS: QuietHoursSettings = {
  enabled: false,
  start: "22:00",
  end: "08:00",
  timezone: "UTC",
};

export const DEFAULT_COMPANY_NOTIFICATION_POLICY: CompanyNotificationPolicy = {
  join_request_enabled: true,
  company_details_changed_enabled: true,
  co_admin_changes_enabled: true,
  employee_management_enabled: true,
  daily_summary_enabled: true,
  weekly_summary_enabled: true,
  top_performer_alert_enabled: true,
  top_performer_alert_time: "17:00",
  employee_daily_statistics_enabled: true,
  employee_weekly_statistics_enabled: true,
  employee_top_performer_enabled: true,
  timezone: "UTC",
};

const NOTIFICATION_PREF_SELECT = {
  id: true,
  user_id: true,
  email_verified: true,
  digest_schedule: true,
  digest_time: true,
  timezone: true,
  quiet_hours: true,
  preferences: true,
  emails_sent_today: true,
  email_frequency_reset: true,
  last_digest_sent: true,
  unsubscribed_at: true,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function isValidTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function coerceDigestSchedule(value: string): DigestSchedule {
  return DIGEST_SCHEDULES.includes(value as DigestSchedule) ? (value as DigestSchedule) : "daily";
}

function assertDigestSchedule(value: string, requestId: string): DigestSchedule {
  if (DIGEST_SCHEDULES.includes(value as DigestSchedule)) {
    return value as DigestSchedule;
  }

  throw createCompanyNotificationError(
    CompanyNotificationErrorCode.INVALID_DIGEST_SCHEDULE,
    "Invalid digest_schedule. Allowed values: daily, weekly, never.",
    422,
    requestId,
    { value }
  );
}

function normalizePriority(value: string): NotificationPriority {
  if (PRIORITIES.includes(value as NotificationPriority)) {
    return value as NotificationPriority;
  }
  return "medium";
}

function buildDefaultEventPreferenceMap(): EventPreferenceMap {
  const defaults = getDefaultPreferences();
  const out: EventPreferenceMap = {};

  for (const [eventType, pref] of Object.entries(defaults)) {
    out[eventType] = {
      in_app: pref.in_app === true,
      email: pref.email === true,
      digest: pref.digest === true,
      priority: normalizePriority(String(pref.priority ?? "medium")),
    };
  }

  return out;
}

function parseEventPreferenceMap(raw: string | null | undefined): EventPreferenceMap {
  const base = buildDefaultEventPreferenceMap();
  const parsed = parseJsonObject(raw);
  if (!parsed) return base;

  const merged: EventPreferenceMap = { ...base };

  for (const [eventType, inputValue] of Object.entries(parsed)) {
    if (!isRecord(inputValue)) continue;

    const current = merged[eventType] ?? { ...DEFAULT_EVENT_PREFERENCE };
    merged[eventType] = {
      in_app: inputValue.in_app === undefined ? current.in_app : inputValue.in_app === true,
      email: inputValue.email === undefined ? current.email : inputValue.email === true,
      digest: inputValue.digest === undefined ? current.digest : inputValue.digest === true,
      push: inputValue.push === undefined ? current.push : inputValue.push === true,
      priority:
        typeof inputValue.priority === "string"
          ? normalizePriority(inputValue.priority)
          : normalizePriority(current.priority),
    };
  }

  return merged;
}

function mergeEventPreferencePatch(
  current: EventPreferenceMap,
  patch: Record<string, unknown>,
  requestId: string
): { merged: EventPreferenceMap; updatedFields: string[] } {
  const merged: EventPreferenceMap = { ...current };
  const updatedFields: string[] = [];

  for (const [eventType, patchValue] of Object.entries(patch)) {
    if (!isRecord(patchValue)) continue;

    const currentEvent = merged[eventType] ?? { ...DEFAULT_EVENT_PREFERENCE };
    const next: EventPreference = {
      in_app: patchValue.in_app === undefined ? currentEvent.in_app : patchValue.in_app === true,
      email: patchValue.email === undefined ? currentEvent.email : patchValue.email === true,
      digest: patchValue.digest === undefined ? currentEvent.digest : patchValue.digest === true,
      push: patchValue.push === undefined ? currentEvent.push : patchValue.push === true,
      priority:
        typeof patchValue.priority === "string"
          ? normalizePriority(patchValue.priority)
          : normalizePriority(currentEvent.priority),
    };

    const enabledChannels =
      Number(next.in_app) + Number(next.email) + Number(next.digest) + Number(next.push === true);

    if (enabledChannels === 0) {
      throw createCompanyNotificationError(
        CompanyNotificationErrorCode.INVALID_PAYLOAD,
        `At least one notification channel must stay enabled for ${eventType}.`,
        422,
        requestId,
        { eventType }
      );
    }

    merged[eventType] = next;
    updatedFields.push(`preferences.${eventType}`);
  }

  return { merged, updatedFields };
}

function parseQuietHours(raw: string | null | undefined): QuietHoursSettings {
  const parsed = parseJsonObject(raw);
  if (!parsed) return { ...DEFAULT_QUIET_HOURS };

  const start = typeof parsed.start === "string" && isValidTime(parsed.start)
    ? parsed.start
    : DEFAULT_QUIET_HOURS.start;
  const end = typeof parsed.end === "string" && isValidTime(parsed.end)
    ? parsed.end
    : DEFAULT_QUIET_HOURS.end;
  const timezone = typeof parsed.timezone === "string" && isValidTimezone(parsed.timezone)
    ? parsed.timezone
    : DEFAULT_QUIET_HOURS.timezone;

  return {
    enabled: parsed.enabled === true,
    start,
    end,
    timezone,
  };
}

function normalizeQuietHoursPatch(
  current: QuietHoursSettings,
  patch: Record<string, unknown>,
  requestId: string
): QuietHoursSettings {
  const next: QuietHoursSettings = { ...current };

  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled === true;
  }

  if (patch.start !== undefined) {
    if (typeof patch.start !== "string" || !isValidTime(patch.start)) {
      throw createCompanyNotificationError(
        CompanyNotificationErrorCode.INVALID_QUIET_HOURS,
        "quiet_hours.start must be HH:MM.",
        422,
        requestId,
        { value: patch.start }
      );
    }
    next.start = patch.start;
  }

  if (patch.end !== undefined) {
    if (typeof patch.end !== "string" || !isValidTime(patch.end)) {
      throw createCompanyNotificationError(
        CompanyNotificationErrorCode.INVALID_QUIET_HOURS,
        "quiet_hours.end must be HH:MM.",
        422,
        requestId,
        { value: patch.end }
      );
    }
    next.end = patch.end;
  }

  if (patch.timezone !== undefined) {
    if (typeof patch.timezone !== "string" || !isValidTimezone(patch.timezone)) {
      throw createCompanyNotificationError(
        CompanyNotificationErrorCode.INVALID_QUIET_HOURS,
        "quiet_hours.timezone must be a valid IANA timezone.",
        422,
        requestId,
        { value: patch.timezone }
      );
    }
    next.timezone = patch.timezone;
  }

  return next;
}

function parseCompanySettings(settingsRaw: string | null): Record<string, unknown> {
  const parsed = parseJsonObject(settingsRaw);
  return parsed ?? {};
}

function readCompanyNotificationPolicy(settings: Record<string, unknown>): CompanyNotificationPolicy {
  const raw = isRecord(settings.notification_policy)
    ? settings.notification_policy
    : {};

  const time =
    typeof raw.top_performer_alert_time === "string" && isValidTime(raw.top_performer_alert_time)
      ? raw.top_performer_alert_time
      : DEFAULT_COMPANY_NOTIFICATION_POLICY.top_performer_alert_time;

  const timezone =
    typeof raw.timezone === "string" && isValidTimezone(raw.timezone)
      ? raw.timezone
      : DEFAULT_COMPANY_NOTIFICATION_POLICY.timezone;

  return {
    join_request_enabled:
      raw.join_request_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.join_request_enabled
        : raw.join_request_enabled === true,
    company_details_changed_enabled:
      raw.company_details_changed_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.company_details_changed_enabled
        : raw.company_details_changed_enabled === true,
    co_admin_changes_enabled:
      raw.co_admin_changes_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.co_admin_changes_enabled
        : raw.co_admin_changes_enabled === true,
    employee_management_enabled:
      raw.employee_management_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.employee_management_enabled
        : raw.employee_management_enabled === true,
    daily_summary_enabled:
      raw.daily_summary_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.daily_summary_enabled
        : raw.daily_summary_enabled === true,
    weekly_summary_enabled:
      raw.weekly_summary_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.weekly_summary_enabled
        : raw.weekly_summary_enabled === true,
    top_performer_alert_enabled:
      raw.top_performer_alert_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.top_performer_alert_enabled
        : raw.top_performer_alert_enabled === true,
    top_performer_alert_time: time,
    employee_daily_statistics_enabled:
      raw.employee_daily_statistics_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.employee_daily_statistics_enabled
        : raw.employee_daily_statistics_enabled === true,
    employee_weekly_statistics_enabled:
      raw.employee_weekly_statistics_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.employee_weekly_statistics_enabled
        : raw.employee_weekly_statistics_enabled === true,
    employee_top_performer_enabled:
      raw.employee_top_performer_enabled === undefined
        ? DEFAULT_COMPANY_NOTIFICATION_POLICY.employee_top_performer_enabled
        : raw.employee_top_performer_enabled === true,
    timezone,
  };
}

function applyPolicyPatch(
  current: CompanyNotificationPolicy,
  patch: Record<string, unknown>,
  requestId: string
): CompanyNotificationPolicy {
  const next: CompanyNotificationPolicy = { ...current };

  if (patch.join_request_enabled !== undefined) {
    next.join_request_enabled = patch.join_request_enabled === true;
  }

  if (patch.company_details_changed_enabled !== undefined) {
    next.company_details_changed_enabled = patch.company_details_changed_enabled === true;
  }

  if (patch.co_admin_changes_enabled !== undefined) {
    next.co_admin_changes_enabled = patch.co_admin_changes_enabled === true;
  }

  if (patch.employee_management_enabled !== undefined) {
    next.employee_management_enabled = patch.employee_management_enabled === true;
  }

  if (patch.daily_summary_enabled !== undefined) {
    next.daily_summary_enabled = patch.daily_summary_enabled === true;
  }

  if (patch.weekly_summary_enabled !== undefined) {
    next.weekly_summary_enabled = patch.weekly_summary_enabled === true;
  }

  if (patch.top_performer_alert_enabled !== undefined) {
    next.top_performer_alert_enabled = patch.top_performer_alert_enabled === true;
  }

  if (patch.employee_daily_statistics_enabled !== undefined) {
    next.employee_daily_statistics_enabled = patch.employee_daily_statistics_enabled === true;
  }

  if (patch.employee_weekly_statistics_enabled !== undefined) {
    next.employee_weekly_statistics_enabled = patch.employee_weekly_statistics_enabled === true;
  }

  if (patch.employee_top_performer_enabled !== undefined) {
    next.employee_top_performer_enabled = patch.employee_top_performer_enabled === true;
  }

  if (patch.top_performer_alert_time !== undefined) {
    if (typeof patch.top_performer_alert_time !== "string" || !isValidTime(patch.top_performer_alert_time)) {
      throw createCompanyNotificationError(
        CompanyNotificationErrorCode.INVALID_DIGEST_TIME,
        "top_performer_alert_time must be HH:MM.",
        422,
        requestId,
        { value: patch.top_performer_alert_time }
      );
    }
    next.top_performer_alert_time = patch.top_performer_alert_time;
  }

  if (patch.timezone !== undefined) {
    if (typeof patch.timezone !== "string" || !isValidTimezone(patch.timezone)) {
      throw createCompanyNotificationError(
        CompanyNotificationErrorCode.INVALID_TIMEZONE,
        "timezone must be a valid IANA timezone.",
        422,
        requestId,
        { value: patch.timezone }
      );
    }
    next.timezone = patch.timezone;
  }

  return next;
}

export class CompanyNotificationService {
  private readonly requestId: string;

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  async getCompanyNotificationPolicy(companyId: bigint): Promise<{
    company_id: string;
    company_name: string;
    policy: CompanyNotificationPolicy;
    recipient_stats: {
      total_admin_recipients: number;
      verified_email_recipients: number;
      unsubscribed_recipients: number;
    };
  }> {
    const company = await this.getCompany(companyId);
    const settings = parseCompanySettings(company.settings);
    const policy = readCompanyNotificationPolicy(settings);

    const members = await prisma.companyEmployee.findMany({
      where: {
        company_id: companyId,
        is_active: true,
        role: { in: ["admin", "manager"] },
      },
      select: {
        user: {
          select: {
            user_id: true,
            is_active: true,
            email: true,
            notificationPreference: {
              select: {
                email_verified: true,
                unsubscribed_at: true,
              },
            },
          },
        },
      },
    });

    let total = 0;
    let verified = 0;
    let unsubscribed = 0;

    for (const member of members) {
      if (!member.user.is_active || !member.user.email) continue;
      total += 1;

      if (member.user.notificationPreference?.email_verified) {
        verified += 1;
      }

      if (member.user.notificationPreference?.unsubscribed_at) {
        unsubscribed += 1;
      }
    }

    return {
      company_id: company.company_id.toString(),
      company_name: company.name,
      policy,
      recipient_stats: {
        total_admin_recipients: total,
        verified_email_recipients: verified,
        unsubscribed_recipients: unsubscribed,
      },
    };
  }

  async updateCompanyNotificationPolicy(
    companyId: bigint,
    patchInput: Record<string, unknown>
  ): Promise<CompanyNotificationPolicy> {
    const company = await this.getCompany(companyId);
    const settings = parseCompanySettings(company.settings);
    const currentPolicy = readCompanyNotificationPolicy(settings);
    const nextPolicy = applyPolicyPatch(currentPolicy, patchInput, this.requestId);

    const nextSettings: Record<string, unknown> = {
      ...settings,
      notification_policy: nextPolicy,
    };

    await prisma.company.update({
      where: { company_id: companyId },
      data: {
        settings: JSON.stringify(nextSettings),
      },
    });

    return nextPolicy;
  }

  async getEmployeeNotificationPreferences(userId: bigint): Promise<{
    user_id: string;
    email_verified: boolean;
    digest_schedule: DigestSchedule;
    digest_time: string;
    timezone: string;
    quiet_hours: QuietHoursSettings;
    preferences: EventPreferenceMap;
    email_frequency: {
      max_per_day: number;
      remaining_today: number;
      reset_time: Date | null;
    };
  }> {
    const pref = await this.loadNotificationPreference(userId);
    const maxPerDay = Math.max(1, Number(process.env.EMAIL_DAILY_LIMIT_PER_USER ?? "10"));

    return {
      user_id: userId.toString(),
      email_verified: pref.email_verified,
      digest_schedule: coerceDigestSchedule(pref.digest_schedule),
      digest_time: isValidTime(pref.digest_time) ? pref.digest_time : "08:00",
      timezone: isValidTimezone(pref.timezone) ? pref.timezone : "UTC",
      quiet_hours: parseQuietHours(pref.quiet_hours),
      preferences: parseEventPreferenceMap(pref.preferences),
      email_frequency: {
        max_per_day: maxPerDay,
        remaining_today: Math.max(0, maxPerDay - pref.emails_sent_today),
        reset_time: pref.email_frequency_reset,
      },
    };
  }

  async updateEmployeeNotificationPreferences(
    userId: bigint,
    patchInput: Record<string, unknown>
  ): Promise<{ updated_fields: string[] }> {
    const pref = await this.loadNotificationPreference(userId);
    const updatedFields: string[] = [];

    const digestScheduleRaw = patchInput.digest_schedule;
    const digestTimeRaw = patchInput.digest_time;
    const timezoneRaw = patchInput.timezone;
    const quietHoursRaw = patchInput.quiet_hours;
    const preferencePatchRaw = patchInput.preferences;

    let nextDigestSchedule = coerceDigestSchedule(pref.digest_schedule);
    if (digestScheduleRaw !== undefined) {
      if (typeof digestScheduleRaw !== "string") {
        throw createCompanyNotificationError(
          CompanyNotificationErrorCode.INVALID_DIGEST_SCHEDULE,
          "digest_schedule must be a string.",
          422,
          this.requestId,
          { value: digestScheduleRaw }
        );
      }
      nextDigestSchedule = assertDigestSchedule(digestScheduleRaw, this.requestId);
      updatedFields.push("digest_schedule");
    }

    let nextDigestTime = pref.digest_time;
    if (digestTimeRaw !== undefined) {
      if (typeof digestTimeRaw !== "string" || !isValidTime(digestTimeRaw)) {
        throw createCompanyNotificationError(
          CompanyNotificationErrorCode.INVALID_DIGEST_TIME,
          "digest_time must be HH:MM.",
          422,
          this.requestId,
          { value: digestTimeRaw }
        );
      }
      nextDigestTime = digestTimeRaw;
      updatedFields.push("digest_time");
    } else if (!isValidTime(nextDigestTime)) {
      nextDigestTime = "08:00";
    }

    let nextTimezone = pref.timezone;
    if (timezoneRaw !== undefined) {
      if (typeof timezoneRaw !== "string" || !isValidTimezone(timezoneRaw)) {
        throw createCompanyNotificationError(
          CompanyNotificationErrorCode.INVALID_TIMEZONE,
          "timezone must be a valid IANA timezone.",
          422,
          this.requestId,
          { value: timezoneRaw }
        );
      }
      nextTimezone = timezoneRaw;
      updatedFields.push("timezone");
    } else if (!isValidTimezone(nextTimezone)) {
      nextTimezone = "UTC";
    }

    const currentQuietHours = parseQuietHours(pref.quiet_hours);
    let nextQuietHours = currentQuietHours;

    if (quietHoursRaw !== undefined) {
      if (!isRecord(quietHoursRaw)) {
        throw createCompanyNotificationError(
          CompanyNotificationErrorCode.INVALID_QUIET_HOURS,
          "quiet_hours must be an object.",
          422,
          this.requestId
        );
      }
      nextQuietHours = normalizeQuietHoursPatch(currentQuietHours, quietHoursRaw, this.requestId);
      updatedFields.push("quiet_hours");
    }

    const currentPreferences = parseEventPreferenceMap(pref.preferences);
    let nextPreferences = currentPreferences;

    if (preferencePatchRaw !== undefined) {
      if (!isRecord(preferencePatchRaw)) {
        throw createCompanyNotificationError(
          CompanyNotificationErrorCode.INVALID_PAYLOAD,
          "preferences must be an object.",
          422,
          this.requestId
        );
      }

      const mergeResult = mergeEventPreferencePatch(
        currentPreferences,
        preferencePatchRaw,
        this.requestId
      );
      nextPreferences = mergeResult.merged;
      updatedFields.push(...mergeResult.updatedFields);
    }

    await prisma.notificationPreference.upsert({
      where: { user_id: userId },
      create: {
        id: randomId("npref"),
        user_id: userId,
        email_verified: pref.email_verified,
        digest_schedule: nextDigestSchedule,
        digest_time: nextDigestTime,
        timezone: nextTimezone,
        quiet_hours: JSON.stringify(nextQuietHours),
        preferences: JSON.stringify(nextPreferences),
        emails_sent_today: pref.emails_sent_today,
        email_frequency_reset: pref.email_frequency_reset,
        last_digest_sent: pref.last_digest_sent,
        unsubscribed_at: pref.unsubscribed_at,
      },
      update: {
        digest_schedule: nextDigestSchedule,
        digest_time: nextDigestTime,
        timezone: nextTimezone,
        quiet_hours: JSON.stringify(nextQuietHours),
        preferences: JSON.stringify(nextPreferences),
        updated_at: new Date(),
      },
    });

    clearNotificationCachePrefix(`notifications:${userId.toString()}:`);

    return {
      updated_fields: Array.from(new Set(updatedFields)),
    };
  }

  async queueDailySummaryEmails(now: Date = new Date()): Promise<CompanyNotificationQueueResult> {
    const result: CompanyNotificationQueueResult = {
      companies_scanned: 0,
      recipients_scanned: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
    };

    const companies = await prisma.company.findMany({
      where: { status: "active" },
      select: {
        company_id: true,
        name: true,
        settings: true,
      },
    });

    for (const company of companies) {
      result.companies_scanned += 1;

      const policy = readCompanyNotificationPolicy(parseCompanySettings(company.settings));
      if (!policy.daily_summary_enabled) {
        continue;
      }

      try {
        const dashboard = new CompanyDashboardService(company.company_id, this.requestId, "UTC");
        const [summary, topEmployee] = await Promise.all([
          dashboard.getDashboardSummary("today"),
          dashboard.getTopEmployeeForToday(),
        ]);

        const recipients = await this.listCompanyRecipients(company.company_id, policy);

        for (const recipient of recipients) {
          result.recipients_scanned += 1;

          if (!this.shouldSendDigest(recipient.preference, "system_update", "daily", now)) {
            result.skipped += 1;
            continue;
          }

          try {
            await this.queueCompanyEmailNotification({
              userId: recipient.userId,
              recipientEmail: recipient.email,
              recipientName: recipient.firstName,
              eventType: "system_update",
              priority: "medium",
              title: `${company.name} daily summary`,
              message: "Your daily company activity summary is ready.",
              actionUrl: "/admin/dashboard",
              actionText: "Open dashboard",
              templateName: "company-daily-summary",
              templateData: {
                app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
                app_url: process.env.FRONTEND_URL ?? "",
                user_name: recipient.firstName,
                company_name: company.name,
                period_label: "Today",
                metrics: {
                  profile_views: summary.total_profile_views,
                  leads_generated: summary.leads_generated,
                  inquiries: summary.total_inquiries,
                  total_employees: summary.total_employees,
                },
                top_employee: topEmployee,
              },
              emailType: "company_daily_summary",
              priorityWeight: 65,
              metadata: {
                company_id: company.company_id.toString(),
                type: "company_daily_summary",
                generated_at: now.toISOString(),
              },
            });

            await prisma.notificationPreference.update({
              where: { user_id: recipient.userId },
              data: {
                last_digest_sent: now,
                updated_at: new Date(),
              },
            });

            result.queued += 1;
          } catch {
            result.failed += 1;
          }
        }

        if (policy.employee_daily_statistics_enabled) {
          const employeeRecipients = await this.listCompanyEmployeeRecipients(company.company_id);
          for (const recipient of employeeRecipients) {
            try {
              await prisma.userNotification.create({
                data: {
                  id: randomId("notif"),
                  user_id: recipient.userId,
                  event_type: "system_update",
                  priority: "medium",
                  title: `${company.name} daily statistics`,
                  message: "Your daily company performance statistics are available.",
                  metadata: JSON.stringify({
                    company_id: company.company_id.toString(),
                    type: "employee_daily_statistics",
                    generated_at: now.toISOString(),
                  }),
                  action_url: "/user/dashboard",
                  action_text: "View stats",
                },
              });
              result.queued += 1;
            } catch {
              result.failed += 1;
            }
          }
        }
      } catch {
        result.failed += 1;
      }
    }

    return result;
  }

  async queueWeeklySummaryEmails(now: Date = new Date()): Promise<CompanyNotificationQueueResult> {
    const result: CompanyNotificationQueueResult = {
      companies_scanned: 0,
      recipients_scanned: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
    };

    const companies = await prisma.company.findMany({
      where: { status: "active" },
      select: {
        company_id: true,
        name: true,
        settings: true,
      },
    });

    for (const company of companies) {
      result.companies_scanned += 1;

      const policy = readCompanyNotificationPolicy(parseCompanySettings(company.settings));
      if (!policy.weekly_summary_enabled) {
        continue;
      }

      try {
        const dashboard = new CompanyDashboardService(company.company_id, this.requestId, "UTC");
        const [summary, rankings] = await Promise.all([
          dashboard.getDashboardSummary("last_7_days"),
          dashboard.getEmployeeRankings("last_7_days", "profile_views", 5),
        ]);

        const recipients = await this.listCompanyRecipients(company.company_id, policy);

        for (const recipient of recipients) {
          result.recipients_scanned += 1;

          if (!this.shouldSendDigest(recipient.preference, "system_update", "weekly", now)) {
            result.skipped += 1;
            continue;
          }

          try {
            await this.queueCompanyEmailNotification({
              userId: recipient.userId,
              recipientEmail: recipient.email,
              recipientName: recipient.firstName,
              eventType: "system_update",
              priority: "medium",
              title: `${company.name} weekly summary`,
              message: "Your weekly company activity summary is ready.",
              actionUrl: "/admin/dashboard",
              actionText: "Open dashboard",
              templateName: "company-weekly-summary",
              templateData: {
                app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
                app_url: process.env.FRONTEND_URL ?? "",
                user_name: recipient.firstName,
                company_name: company.name,
                period_label: "Last 7 days",
                metrics: {
                  profile_views: summary.total_profile_views,
                  leads_generated: summary.leads_generated,
                  inquiries: summary.total_inquiries,
                  total_employees: summary.total_employees,
                },
                top_rankings: rankings.rankings.map((entry) => ({
                  name: entry.name,
                  metric_value: entry.metric_value,
                  trend: entry.trend,
                })),
              },
              emailType: "company_weekly_summary",
              priorityWeight: 60,
              metadata: {
                company_id: company.company_id.toString(),
                type: "company_weekly_summary",
                generated_at: now.toISOString(),
              },
            });

            await prisma.notificationPreference.update({
              where: { user_id: recipient.userId },
              data: {
                last_digest_sent: now,
                updated_at: new Date(),
              },
            });

            result.queued += 1;
          } catch {
            result.failed += 1;
          }
        }

        if (policy.employee_weekly_statistics_enabled) {
          const employeeRecipients = await this.listCompanyEmployeeRecipients(company.company_id);
          for (const recipient of employeeRecipients) {
            try {
              await prisma.userNotification.create({
                data: {
                  id: randomId("notif"),
                  user_id: recipient.userId,
                  event_type: "system_update",
                  priority: "medium",
                  title: `${company.name} weekly statistics`,
                  message: "Your weekly company performance statistics are available.",
                  metadata: JSON.stringify({
                    company_id: company.company_id.toString(),
                    type: "employee_weekly_statistics",
                    generated_at: now.toISOString(),
                  }),
                  action_url: "/user/dashboard",
                  action_text: "View stats",
                },
              });
              result.queued += 1;
            } catch {
              result.failed += 1;
            }
          }
        }
      } catch {
        result.failed += 1;
      }
    }

    return result;
  }

  async queueTopPerformerAlerts(now: Date = new Date()): Promise<CompanyNotificationQueueResult> {
    const result: CompanyNotificationQueueResult = {
      companies_scanned: 0,
      recipients_scanned: 0,
      queued: 0,
      skipped: 0,
      failed: 0,
    };

    const companies = await prisma.company.findMany({
      where: { status: "active" },
      select: {
        company_id: true,
        name: true,
        settings: true,
      },
    });

    for (const company of companies) {
      result.companies_scanned += 1;

      const policy = readCompanyNotificationPolicy(parseCompanySettings(company.settings));
      if (!policy.top_performer_alert_enabled && !policy.employee_top_performer_enabled) {
        continue;
      }

      if (!this.isPolicyTimeDue(now, policy.top_performer_alert_time, policy.timezone)) {
        continue;
      }

      try {
        const dashboard = new CompanyDashboardService(company.company_id, this.requestId, "UTC");
        const topEmployee = await dashboard.getTopEmployeeForToday();
        if (!topEmployee) {
          continue;
        }

        if (policy.top_performer_alert_enabled) {
        const recipients = await this.listCompanyRecipients(company.company_id, policy);

        for (const recipient of recipients) {
          result.recipients_scanned += 1;

          if (!this.canSendEventEmail(recipient.preference, "achievement", now)) {
            result.skipped += 1;
            continue;
          }

          const alreadyQueued = await prisma.notificationEmailQueue.findFirst({
            where: {
              user_id: recipient.userId,
              email_type: "company_top_performer",
              created_at: { gte: this.startOfUtcDay(now) },
            },
            select: { id: true },
          });

          if (alreadyQueued) {
            result.skipped += 1;
            continue;
          }

          try {
            await this.queueCompanyEmailNotification({
              userId: recipient.userId,
              recipientEmail: recipient.email,
              recipientName: recipient.firstName,
              eventType: "achievement",
              priority: "high",
              title: `${company.name} top performer update`,
              message: `${topEmployee.name} is leading company profile views today.`,
              actionUrl: "/admin/dashboard",
              actionText: "View leaderboard",
              templateName: "company-top-performer",
              templateData: {
                app_name: process.env.EMAIL_FROM_NAME ?? "OnTap",
                app_url: process.env.FRONTEND_URL ?? "",
                user_name: recipient.firstName,
                company_name: company.name,
                performer_name: topEmployee.name,
                performer_role: topEmployee.role,
                profile_views: topEmployee.profile_views,
              },
              emailType: "company_top_performer",
              priorityWeight: 80,
              metadata: {
                company_id: company.company_id.toString(),
                type: "company_top_performer",
                generated_at: now.toISOString(),
              },
            });

            result.queued += 1;
          } catch {
            result.failed += 1;
          }
        }
        }

        if (policy.employee_top_performer_enabled && topEmployee.user_id) {
          try {
            await prisma.userNotification.create({
              data: {
                id: randomId("notif"),
                user_id: BigInt(topEmployee.user_id),
                event_type: "achievement",
                priority: "high",
                title: "You are today's top performer",
                message: `Congratulations! You are leading ${company.name} in profile views today.`,
                metadata: JSON.stringify({
                  company_id: company.company_id.toString(),
                  type: "employee_top_performer",
                  profile_views: topEmployee.profile_views,
                  generated_at: now.toISOString(),
                }),
                action_url: "/user/dashboard",
                action_text: "View dashboard",
              },
            });
            result.queued += 1;
          } catch {
            result.failed += 1;
          }
        }
      } catch {
        result.failed += 1;
      }
    }

    return result;
  }

  private async getCompany(companyId: bigint): Promise<{ company_id: bigint; name: string; settings: string | null }> {
    const company = await prisma.company.findUnique({
      where: { company_id: companyId },
      select: {
        company_id: true,
        name: true,
        settings: true,
      },
    });

    if (!company) {
      throw createCompanyNotificationError(
        CompanyNotificationErrorCode.COMPANY_NOT_FOUND,
        "Company not found.",
        404,
        this.requestId,
        { companyId: companyId.toString() }
      );
    }

    return company;
  }

  private async loadNotificationPreference(userId: bigint): Promise<NotificationPreferenceSnapshot> {
    const existing = await prisma.notificationPreference.findUnique({
      where: { user_id: userId },
      select: NOTIFICATION_PREF_SELECT,
    });

    if (existing) {
      return existing;
    }

    await getOrCreateNotificationPreference(userId);

    const created = await prisma.notificationPreference.findUnique({
      where: { user_id: userId },
      select: NOTIFICATION_PREF_SELECT,
    });

    if (!created) {
      throw createCompanyNotificationError(
        CompanyNotificationErrorCode.DELIVERY_UNAVAILABLE,
        "Unable to initialize notification preferences.",
        500,
        this.requestId,
        { userId: userId.toString() }
      );
    }

    return created;
  }

  private async listCompanyEmployeeRecipients(
    companyId: bigint,
  ): Promise<Array<{ userId: bigint; firstName: string }>> {
    const company = await prisma.company.findUnique({
      where: { company_id: companyId },
      select: { admin_id: true, created_by: true },
    });

    const primaryAdminId = company?.admin_id ?? company?.created_by ?? null;

    const employees = await prisma.companyEmployee.findMany({
      where: {
        company_id: companyId,
        is_active: true,
        role: { in: ["employee", "manager", "viewer"] },
      },
      select: {
        user_id: true,
        user: {
          select: {
            first_name: true,
            is_active: true,
          },
        },
      },
    });

    const recipients: Array<{ userId: bigint; firstName: string }> = [];

    for (const employee of employees) {
      if (!employee.user.is_active) continue;
      if (primaryAdminId !== null && employee.user_id === primaryAdminId) continue;
      recipients.push({
        userId: employee.user_id,
        firstName: employee.user.first_name,
      });
    }

    return recipients;
  }

  private async listCompanyRecipients(
    companyId: bigint,
    policy: CompanyNotificationPolicy
  ): Promise<CompanyNotificationRecipient[]> {
    const employees = await prisma.companyEmployee.findMany({
      where: {
        company_id: companyId,
        is_active: true,
        role: { in: ["admin", "manager"] },
      },
      select: {
        user_id: true,
        user: {
          select: {
            user_id: true,
            first_name: true,
            email: true,
            is_active: true,
            credentials: {
              select: {
                email_verified: true,
              },
            },
            notificationPreference: {
              select: NOTIFICATION_PREF_SELECT,
            },
          },
        },
      },
    });

    const recipients: CompanyNotificationRecipient[] = [];

    for (const employee of employees) {
      if (!employee.user.is_active || !employee.user.email) {
        continue;
      }

      let preference = employee.user.notificationPreference;
      if (!preference) {
        preference = await this.loadNotificationPreference(employee.user.user_id);
      }

      if (!preference.email_verified && employee.user.credentials?.email_verified === true) {
        preference = await prisma.notificationPreference.update({
          where: { user_id: employee.user.user_id },
          data: {
            email_verified: true,
            updated_at: new Date(),
          },
          select: NOTIFICATION_PREF_SELECT,
        });
      }

      const nextDigestTime = isValidTime(preference.digest_time) ? preference.digest_time : "08:00";
      const nextTimezone = isValidTimezone(preference.timezone) ? preference.timezone : policy.timezone;
      const nextDigestSchedule = coerceDigestSchedule(preference.digest_schedule);

      if (
        nextDigestTime !== preference.digest_time ||
        nextTimezone !== preference.timezone ||
        nextDigestSchedule !== preference.digest_schedule
      ) {
        preference = await prisma.notificationPreference.update({
          where: { user_id: employee.user.user_id },
          data: {
            digest_time: nextDigestTime,
            timezone: nextTimezone,
            digest_schedule: nextDigestSchedule,
            updated_at: new Date(),
          },
          select: NOTIFICATION_PREF_SELECT,
        });
      }

      recipients.push({
        userId: employee.user.user_id,
        email: employee.user.email,
        firstName: employee.user.first_name,
        preference,
      });
    }

    return recipients;
  }

  private shouldSendDigest(
    preference: NotificationPreferenceSnapshot,
    eventType: string,
    schedule: Exclude<DigestSchedule, "never">,
    now: Date
  ): boolean {
    if (preference.unsubscribed_at !== null) return false;
    if (!preference.email_verified) return false;

    const effectiveSchedule = coerceDigestSchedule(preference.digest_schedule);
    if (effectiveSchedule === "never") return false;
    if (effectiveSchedule !== schedule) return false;

    const eventPreferences = parseEventPreferenceMap(preference.preferences);
    const eventConfig = eventPreferences[eventType] ?? DEFAULT_EVENT_PREFERENCE;
    if (eventConfig.email !== true) return false;

    if (shouldSuppressForQuietHours(preference.quiet_hours, now)) {
      return false;
    }

    return isDigestDue({
      now,
      timezone: preference.timezone,
      digestTime: preference.digest_time,
      schedule,
      lastDigestSent: preference.last_digest_sent,
    });
  }

  private canSendEventEmail(
    preference: NotificationPreferenceSnapshot,
    eventType: string,
    now: Date
  ): boolean {
    if (preference.unsubscribed_at !== null) return false;
    if (!preference.email_verified) return false;

    const eventPreferences = parseEventPreferenceMap(preference.preferences);
    const eventConfig = eventPreferences[eventType] ?? DEFAULT_EVENT_PREFERENCE;
    if (eventConfig.email !== true) return false;

    return !shouldSuppressForQuietHours(preference.quiet_hours, now);
  }

  private async queueCompanyEmailNotification(params: {
    userId: bigint;
    recipientEmail: string;
    recipientName: string;
    eventType: "system_update" | "achievement";
    priority: "high" | "medium";
    title: string;
    message: string;
    actionUrl: string;
    actionText: string;
    templateName: string;
    templateData: Record<string, unknown>;
    emailType: string;
    priorityWeight: number;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const notificationId = randomId("notif");

    await prisma.userNotification.create({
      data: {
        id: notificationId,
        user_id: params.userId,
        event_type: params.eventType,
        priority: params.priority,
        title: params.title,
        message: params.message,
        metadata: JSON.stringify(params.metadata),
        action_url: params.actionUrl,
        action_text: params.actionText,
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

    try {
      await queueEmailForNotification({
        userId: params.userId,
        notificationId,
        recipientEmail: params.recipientEmail,
        recipientName: params.recipientName,
        subject: params.title,
        templateName: params.templateName,
        templateData: params.templateData,
        emailType: params.emailType,
        priority: params.priorityWeight,
      });
    } catch (error) {
      await prisma.notificationDelivery.updateMany({
        where: {
          notification_id: notificationId,
          channel: "email",
        },
        data: {
          status: "failed",
          error_message: error instanceof Error ? error.message.slice(0, 1000) : "Queue failure",
        },
      });
      throw error;
    }

    clearNotificationCachePrefix(`notifications:${params.userId.toString()}:`);
  }

  private isPolicyTimeDue(now: Date, targetTime: string, timezone: string): boolean {
    if (!isValidTime(targetTime)) return false;
    if (!isValidTimezone(timezone)) return false;

    const [targetHour, targetMinute] = targetTime.split(":").map((value) => Number(value));
    const local = getLocalParts(now, timezone);

    if (local.hour !== targetHour) return false;
    return Math.abs(local.minute - targetMinute) <= 15;
  }

  private startOfUtcDay(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}