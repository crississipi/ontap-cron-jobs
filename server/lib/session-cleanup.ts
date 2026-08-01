import { prisma } from "@/server/lib/prisma";

/**
 * Delete revoked/expired sessions older than 7 days.
 * Extracted from ontapnewsystem auth for the cron-only worker (no full auth stack).
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      OR: [
        { revoked: true, updated_at: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        { expires_at: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return result.count;
}
