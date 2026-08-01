// ──────────────────────────────────────────────────────────────
// Prisma Client Singleton — Serverless Connection Handling
// ──────────────────────────────────────────────────────────────
// WHY singleton: Vercel serverless reuses warm containers between
// requests. Without caching the client on globalThis, each invocation
// would open a new connection, exhausting MySQL max_connections fast.
//
// Connection pool sizing for serverless + remote MySQL (Hostinger):
//   connection_limit=3  — keeps pool small so concurrent cold-starts
//                         don't saturate the DB (default=10 is too high)
//   pool_timeout=10     — fail fast if all slots are busy rather than
//                         queuing indefinitely (prevents P1017 pile-ups)
//   connect_timeout=10  — abort slow TCP handshakes (cold-start latency)
//
// P1017 root cause: a long-idle serverless container holds a stale TCP
// connection that MySQL's wait_timeout has already closed server-side.
// idle_connection_timeout=20 tells Prisma's pool to proactively close
// connections idle for >20 s — shorter than Hostinger's wait_timeout so
// the pool never hands out a dead connection. For high-traffic workloads,
// consider Prisma Accelerate (managed connection pooler).
// ──────────────────────────────────────────────────────────────

import { PrismaClient, Prisma } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let loggedLegacyDatabaseUrl = false;

/**
 * Build the primary database URL with serverless-safe pool parameters appended.
 * NEWDATABASE_URL is the production primary; DATABASE_URL is a legacy fallback.
 */
function buildDatabaseUrl(): string {
  const newUrl = process.env.NEWDATABASE_URL;
  const legacyUrl = process.env.DATABASE_URL ?? "";
  const base = newUrl || legacyUrl;

  if (!newUrl && legacyUrl && process.env.NODE_ENV !== "production" && !loggedLegacyDatabaseUrl) {
    loggedLegacyDatabaseUrl = true;
    console.warn(
      "[prisma] NEWDATABASE_URL is not set — falling back to DATABASE_URL. Set NEWDATABASE_URL for production.",
    );
  }

  const defaultConnectionLimit = process.env.NODE_ENV === "production" ? "5" : "10";

  const params = new URLSearchParams();
  params.set("connection_limit", process.env.DB_CONNECTION_LIMIT ?? defaultConnectionLimit);
  params.set("pool_timeout", process.env.DB_POOL_TIMEOUT ?? "20");
  params.set("connect_timeout", process.env.DB_CONNECT_TIMEOUT ?? "10");
  params.set("idle_connection_timeout", process.env.DB_IDLE_CONNECTION_TIMEOUT ?? "30");

  // Preserve any params already in the URL; only add what's missing
  const separator = base.includes("?") ? "&" : "?";
  const existing = base.includes("?") ? base.split("?")[1] : "";
  const existingKeys = new Set(existing.split("&").map((p) => p.split("=")[0]));

  const additions: string[] = [];
  params.forEach((val, key) => {
    if (!existingKeys.has(key)) additions.push(`${key}=${val}`);
  });

  return additions.length > 0 ? `${base}${separator}${additions.join("&")}` : base;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
    datasources: {
      db: { url: buildDatabaseUrl() },
    },
  });
}

/** After schema migrations, a warm dev/prod container may still hold an old Prisma singleton. */
function isStalePrismaClient(client: PrismaClient | undefined): boolean {
  if (!client || !("supportConversation" in client)) return true;
  if (!("orderFeedback" in client)) return true;
  // Service.tagline was added after some db-pull/generate cycles; stale clients reject it.
  return !("tagline" in Prisma.ServiceScalarFieldEnum);
}

let prismaClient = globalForPrisma.prisma;
if (isStalePrismaClient(prismaClient)) {
  if (prismaClient) {
    void prismaClient.$disconnect().catch(() => undefined);
  }
  prismaClient = createPrismaClient();
  globalForPrisma.prisma = prismaClient;
}

export const prisma = prismaClient as PrismaClient;