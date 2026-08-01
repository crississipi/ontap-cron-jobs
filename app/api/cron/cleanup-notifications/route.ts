import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/server/lib/prisma";
import { requireCronAuth } from "@/server/lib/notification-cron";

async function safeExecute(query: string, params: unknown[] = []): Promise<number> {
  try {
    return await prisma.$executeRawUnsafe(query, ...params);
  } catch {
    // Some deployments may not have legacy notification tables.
    return 0;
  }
}

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  const archiveCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const readDeleteCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const emailRecordCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [archived, deletedRead, cleanedQueue, deletedExpiredTokens] = await Promise.all([
    safeExecute(
      "UPDATE UserNotification SET is_archived = 1, updated_at = NOW() WHERE created_at < ? AND is_archived = 0",
      [archiveCutoff]
    ),
    safeExecute(
      "DELETE FROM UserNotification WHERE is_read = 1 AND created_at < ?",
      [readDeleteCutoff]
    ),
    safeExecute(
      "DELETE FROM NotificationEmailQueue WHERE created_at < ? AND status IN ('sent','failed','cancelled')",
      [emailRecordCutoff]
    ),
    safeExecute(
      "DELETE FROM UserNotificationToken WHERE expires_at < NOW()"
    ),
  ]);

  return NextResponse.json({
    success: true,
    archived,
    deleted_read: deletedRead,
    cleaned_queue: cleanedQueue,
    deleted_expired_tokens: deletedExpiredTokens,
  });
}