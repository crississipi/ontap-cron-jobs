// ──────────────────────────────────────────────────────────────
// Analytics Prisma Client Singleton (static import)
// ──────────────────────────────────────────────────────────────
// Generated to ./generated/analytics-client (not node_modules) so Hostinger
// production npm installs cannot delete the client mid-build.
import { PrismaClient as PrismaAnalyticsClientCtor } from "@/generated/analytics-client";

const globalForAnalytics = globalThis as unknown as {
  prismaAnalytics?: any;
};

let loggedLegacyAnalyticsUrl = false;

function buildAnalyticsUrl(): string {
  const newUrl = process.env.NEWANALYTICS_DATABASE_URL;
  const legacyUrl = process.env.ANALYTICS_DATABASE_URL ?? "";
  const base = newUrl || legacyUrl;

  if (!newUrl && legacyUrl && process.env.NODE_ENV !== "production" && !loggedLegacyAnalyticsUrl) {
    loggedLegacyAnalyticsUrl = true;
    console.warn(
      "[prisma-analytics] NEWANALYTICS_DATABASE_URL is not set — falling back to ANALYTICS_DATABASE_URL.",
    );
  }

  const params = new URLSearchParams();
  params.set("connection_limit", "3");
  params.set("pool_timeout", "20");
  params.set("connect_timeout", "10");
  params.set("idle_connection_timeout", "20");
  const separator = base.includes("?") ? "&" : "?";
  const existing = base.includes("?") ? base.split("?")[1] : "";
  const existingKeys = new Set(existing.split("&").map((p) => p.split("=")[0]));
  const additions: string[] = [];
  params.forEach((val, key) => {
    if (!existingKeys.has(key)) additions.push(`${key}=${val}`);
  });

  return additions.length > 0 ? `${base}${separator}${additions.join("&")}` : base;
}

export const prismaAnalytics =
  globalForAnalytics.prismaAnalytics ??
  new PrismaAnalyticsClientCtor({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
    datasources: {
      db: { url: buildAnalyticsUrl() },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForAnalytics.prismaAnalytics = prismaAnalytics;
}
