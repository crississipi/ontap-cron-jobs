// lib/backend/subscription/seed-tiers.ts
import { prisma } from "@/server/lib/prisma";
import { Prisma } from "@prisma/client";

// Tier configuration based on requirements
const TIER_CONFIGS = [
  {
    name: "Free Trial",
    tier_code: "free_trial",
    price_monthly: new Prisma.Decimal(0),
    price_yearly: new Prisma.Decimal(0),
    max_virtual_cards: 1,
    max_physical_cards: 0,
    max_themes: 5,
    max_associates: 15,
    can_create_company: false,
    can_upload_gallery: false,
    can_manage_inquiries: false,
    can_real_time_analytics: false,
    can_affiliate: true,
    can_dashboard: true,
    trial_days: 30,
    is_trial: true,
    analytics_included: false,
    priority_support: false,
    features: JSON.stringify([
      "Create 1 virtual card",
      "Affiliate access",
      "Basic dashboard",
      "5 free themes",
      "15 associates limit",
    ]),
  },
  {
    name: "Basic",
    tier_code: "basic",
    price_monthly: new Prisma.Decimal(9.99),
    price_yearly: new Prisma.Decimal(99.99),
    max_virtual_cards: 1,
    max_physical_cards: 1,
    max_themes: 5,
    max_associates: 15,
    can_create_company: false,
    can_upload_gallery: false,
    can_manage_inquiries: false,
    can_real_time_analytics: false,
    can_affiliate: true,
    can_dashboard: true,
    trial_days: 0,
    is_trial: false,
    analytics_included: false,
    priority_support: false,
    features: JSON.stringify([
      "Create 1 virtual card",
      "Merge physical cards",
      "Basic dashboard",
      "5 free themes",
      "15 associates limit",
      "Inquiry management",
    ]),
  },
  {
    name: "Standard",
    tier_code: "standard",
    price_monthly: new Prisma.Decimal(19.99),
    price_yearly: new Prisma.Decimal(199.99),
    max_virtual_cards: 3,
    max_physical_cards: 3,
    max_themes: 7,
    max_associates: 30,
    can_create_company: true,
    can_upload_gallery: true,
    can_manage_inquiries: true,
    can_real_time_analytics: true,
    can_affiliate: true,
    can_dashboard: true,
    trial_days: 0,
    is_trial: false,
    analytics_included: true,
    priority_support: false,
    features: JSON.stringify([
      "Create up to 3 virtual/physical cards",
      "Gallery upload",
      "Inquiry management",
      "Real-time analytics",
      "7 themes",
      "30 associates limit",
    ]),
  },
  {
    name: "Premium",
    tier_code: "premium",
    price_monthly: new Prisma.Decimal(39.99),
    price_yearly: new Prisma.Decimal(399.99),
    max_virtual_cards: null, // unlimited
    max_physical_cards: null, // unlimited
    max_themes: 10,
    max_associates: null, // unlimited
    can_create_company: true,
    can_upload_gallery: true,
    can_manage_inquiries: true,
    can_real_time_analytics: true,
    can_affiliate: true,
    can_dashboard: true,
    trial_days: 0,
    is_trial: false,
    analytics_included: true,
    priority_support: true,
    features: JSON.stringify([
      "Unlimited virtual/physical cards",
      "Company creation & management",
      "Inquiry management",
      "Real-time analytics",
      "10 themes",
      "Unlimited associates",
      "All features unlocked",
    ]),
  },
];

export async function seedSubscriptionTiers(): Promise<{
  created: number;
  updated: number;
  errors: number;
}> {
  const results = {
    created: 0,
    updated: 0,
    errors: 0,
  };

  for (const tier of TIER_CONFIGS) {
    try {
      await prisma.subscriptionPlan.upsert({
        where: { tier_code: tier.tier_code },
        create: tier,
        update: tier,
      });

      // Check if it existed before
      const existing = await prisma.subscriptionPlan.findUnique({
        where: { tier_code: tier.tier_code },
      });

      if (existing?.created_at && existing.created_at < new Date(Date.now() - 60000)) {
        results.updated++;
        console.log(`[Seed] Updated tier: ${tier.tier_code}`);
      } else {
        results.created++;
        console.log(`[Seed] Created tier: ${tier.tier_code}`);
      }
    } catch (error) {
      console.error(`[Seed] Error seeding tier ${tier.tier_code}:`, error);
      results.errors++;
    }
  }

  return results;
}

// ─── MIGRATION FUNCTIONS REMOVED ──────────────────────────────────────────────
// The old userSubscription model has been replaced by bizcardSubscription.
// Migration from legacy userSubscription data is not required for new deployments.
// If a migration is needed, it should be handled via a separate script.

// ─── INITIALIZATION ─────────────────────────────────────────────────────────────
// Only seeds the subscription plans; does not attempt to migrate old data.

export async function initializeSubscriptionSystem(): Promise<void> {
  console.log("[Init] Seeding subscription plans...");
  const seedResults = await seedSubscriptionTiers();
  console.log(
    `[Init] Tier seeding: ${seedResults.created} created, ${seedResults.updated} updated, ${seedResults.errors} errors`
  );
}