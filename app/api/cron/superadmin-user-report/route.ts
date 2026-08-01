/**
 * GET /api/cron/superadmin-user-report
 *
 * Cron endpoint: generates User Report Summary notifications for all active
 * superadmins who have `user_report_frequency` set in their preferences.
 *
 * Frequency-to-schedule mapping:
 *   daily      → call this route every day (e.g. 08:00)
 *   weekly     → call this route every Monday
 *   semi_monthly → call this route on the 1st and 15th of each month
 *   monthly    → call this route on the 1st of each month
 *
 * The route itself does not enforce the timing — that is the caller's
 * (cron scheduler's) responsibility. The route simply checks each
 * superadmin's configured frequency and only sends a notification when
 * the current call matches their selected period.
 *
 * Auth: Bearer CRON_SECRET header (same pattern as all other cron routes).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/server/lib/notification-cron";
import { prisma } from "@/server/lib/prisma";
import {
  getSuperadminUserIds,
  getSuperadminUserActivityPrefs,
  createSuperadminNotification,
  SA_EVENT_USER_REPORT_SUMMARY,
} from "@/lib/services/superadmin-notifications.service";

interface UserReportStats {
  newUsersCount: number;
  totalActiveUsers: number;
  totalInactiveUsers: number;
  totalUsers: number;
}

/**
 * Returns aggregated user stats for the given look-back window.
 * Inactive = is_active: false (deactivated) OR last_active older than 30 days
 * with at least one prior login.
 */
async function fetchUserStats(since: Date): Promise<UserReportStats> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [newUsersCount, totalActiveUsers, totalInactiveUsers, totalUsers] = await Promise.all([
    // New registrations in the look-back window
    prisma.user.count({
      where: {
        role: { notIn: ["super_admin", "admin"] },
        created_at: { gte: since },
      },
    }),
    // Active users (is_active: true)
    prisma.user.count({
      where: {
        role: { notIn: ["super_admin", "admin"] },
        is_active: true,
      },
    }),
    // Inactive users — deactivated OR no login in 30 days
    prisma.user.count({
      where: {
        role: { notIn: ["super_admin", "admin"] },
        OR: [
          { is_active: false },
          {
            is_active: true,
            last_active: { lt: thirtyDaysAgo },
          },
        ],
      },
    }),
    // Total non-admin users
    prisma.user.count({
      where: {
        role: { notIn: ["super_admin", "admin"] },
      },
    }),
  ]);

  return { newUsersCount, totalActiveUsers, totalInactiveUsers, totalUsers };
}

/**
 * Returns the look-back start date for a given frequency string.
 */
function getLookbackSince(frequency: string): Date {
  const now = Date.now();
  switch (frequency) {
    case "daily":
      return new Date(now - 1 * 24 * 60 * 60 * 1000);
    case "weekly":
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case "semi_monthly":
      return new Date(now - 14 * 24 * 60 * 60 * 1000);
    case "monthly":
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    default:
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
}

function buildReportMessage(stats: UserReportStats, frequency: string): string {
  const periodLabel: Record<string, string> = {
    daily: "Today",
    weekly: "This Week",
    semi_monthly: "Last 2 Weeks",
    monthly: "This Month",
  };
  const label = periodLabel[frequency] ?? "Recent Period";
  return (
    `User Report Summary (${label}): ` +
    `${stats.newUsersCount} new registration${stats.newUsersCount !== 1 ? "s" : ""}, ` +
    `${stats.totalActiveUsers} active user${stats.totalActiveUsers !== 1 ? "s" : ""}, ` +
    `${stats.totalInactiveUsers} inactive user${stats.totalInactiveUsers !== 1 ? "s" : ""}. ` +
    `Total: ${stats.totalUsers} users.`
  );
}

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const superadminIds = await getSuperadminUserIds();
    if (superadminIds.length === 0) {
      return NextResponse.json({ success: true, notified: 0, reason: "no_superadmins" });
    }

    let notified = 0;

    await Promise.allSettled(
      superadminIds.map(async (saId) => {
        const prefs = await getSuperadminUserActivityPrefs(saId);

        // Only send if the toggle is on AND a frequency is configured
        if (!prefs.user_report_frequency) return;

        const since = getLookbackSince(prefs.user_report_frequency);
        const stats = await fetchUserStats(since);
        const message = buildReportMessage(stats, prefs.user_report_frequency);

        const notifId = await createSuperadminNotification({
          superadminUserId: saId,
          eventType: SA_EVENT_USER_REPORT_SUMMARY,
          priority: "medium",
          title: "User Report Summary",
          message,
          actionUrl: "/superadmin/client-list",
          actionText: "View Users",
          metadata: {
            frequency: prefs.user_report_frequency,
            new_users: stats.newUsersCount,
            active_users: stats.totalActiveUsers,
            inactive_users: stats.totalInactiveUsers,
            total_users: stats.totalUsers,
            report_generated_at: new Date().toISOString(),
          },
        });

        if (notifId) notified++;
      }),
    );

    return NextResponse.json({
      success: true,
      notified,
      tag: "[CRON_SA_USER_REPORT]",
    });
  } catch (error) {
    console.error("[cron/superadmin-user-report]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "User report cron failed",
        tag: "[CRON_SA_USER_REPORT]",
      },
      { status: 500 },
    );
  }
}
