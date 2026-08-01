/**
 * GET /api/cron/superadmin-inactive-users
 *
 * Cron endpoint: detects inactive users and notifies superadmins who have
 * the `inactive_users` preference toggle enabled.
 *
 * Inactivity definition (consistent with the rest of the system):
 *   - Users where is_active = false (deactivated), OR
 *   - Users where is_active = true but last_active < 30 days ago
 *     (i.e. they have not logged in / been active for 30+ days)
 *
 * Only runs for superadmins who have inactive_users: true in their prefs.
 *
 * Auth: Bearer CRON_SECRET header.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/server/lib/notification-cron";
import { prisma } from "@/server/lib/prisma";
import {
  getSuperadminUserIds,
  getSuperadminUserActivityPrefs,
  createSuperadminNotification,
  SA_EVENT_INACTIVE_USERS,
} from "@/lib/services/superadmin-notifications.service";

const INACTIVITY_THRESHOLD_DAYS = 30;

interface InactiveUserCount {
  deactivated: number;
  dormant: number;
  total: number;
}

async function fetchInactiveUserStats(): Promise<InactiveUserCount> {
  const cutoff = new Date(Date.now() - INACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  const [deactivated, dormant] = await Promise.all([
    // Hard-deactivated accounts
    prisma.user.count({
      where: {
        role: { notIn: ["super_admin", "admin"] },
        is_active: false,
      },
    }),
    // Soft-inactive: still active flag but no activity in threshold window
    prisma.user.count({
      where: {
        role: { notIn: ["super_admin", "admin"] },
        is_active: true,
        last_active: { lt: cutoff },
      },
    }),
  ]);

  return { deactivated, dormant, total: deactivated + dormant };
}

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const superadminIds = await getSuperadminUserIds();
    if (superadminIds.length === 0) {
      return NextResponse.json({ success: true, notified: 0, reason: "no_superadmins" });
    }

    // Fetch stats once — same data for all superadmins
    const stats = await fetchInactiveUserStats();

    if (stats.total === 0) {
      return NextResponse.json({
        success: true,
        notified: 0,
        reason: "no_inactive_users",
        tag: "[CRON_SA_INACTIVE_USERS]",
      });
    }

    let notified = 0;

    await Promise.allSettled(
      superadminIds.map(async (saId) => {
        const prefs = await getSuperadminUserActivityPrefs(saId);
        if (!prefs.inactive_users) return;

        const message =
          `Inactive Users Alert: ${stats.total} inactive user${stats.total !== 1 ? "s" : ""} detected — ` +
          `${stats.deactivated} deactivated, ${stats.dormant} dormant (no activity in ${INACTIVITY_THRESHOLD_DAYS}+ days). ` +
          `Review and consider outreach or cleanup.`;

        const notifId = await createSuperadminNotification({
          superadminUserId: saId,
          eventType: SA_EVENT_INACTIVE_USERS,
          priority: "medium",
          title: "Inactive Users Detected",
          message,
          actionUrl: "/superadmin/client-list",
          actionText: "View Inactive Users",
          metadata: {
            total_inactive: stats.total,
            deactivated: stats.deactivated,
            dormant: stats.dormant,
            threshold_days: INACTIVITY_THRESHOLD_DAYS,
            detected_at: new Date().toISOString(),
          },
        });

        if (notifId) notified++;
      }),
    );

    return NextResponse.json({
      success: true,
      notified,
      total_inactive: stats.total,
      tag: "[CRON_SA_INACTIVE_USERS]",
    });
  } catch (error) {
    console.error("[cron/superadmin-inactive-users]", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Inactive users cron failed",
        tag: "[CRON_SA_INACTIVE_USERS]",
      },
      { status: 500 },
    );
  }
}
