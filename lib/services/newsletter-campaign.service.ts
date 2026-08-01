import { prisma } from "@/server/lib/prisma";
import { randomId } from "@/server/lib/notifications";
import { parseJsonArray, toJsonString } from "@/server/lib/json-field";
import {
  createProductPromoError,
  ProductPromoErrorCode,
} from "@/lib/errors/product-promo-errors";

export type AudienceSegment =
  | "basic"
  | "standard"
  | "premium"
  | "company_admins"
  | "free_trial"
  | "custom";

export type CampaignData = {
  title: string;
  content: string;
  image_urls?: string[];
  audience: AudienceSegment[];
  custom_user_ids?: string[];
  scheduled_at?: Date | null;
};

function parsePreferences(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readPromotionalEmailOptIn(preferencesRaw: string): boolean {
  const prefs = parsePreferences(preferencesRaw);
  const promotional = prefs.promotional;
  if (!promotional || typeof promotional !== "object" || Array.isArray(promotional)) {
    return false;
  }
  return (promotional as Record<string, unknown>).email === true;
}

function cleanImageUrls(urls: string[] | undefined): string[] {
  if (!Array.isArray(urls)) return [];
  return urls
    .map((url) => String(url ?? "").trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 6);
}

function toCampaignResponse(campaign: {
  id: string;
  title: string;
  content: string;
  image_urls?: string | null;
  audience: string | null;
  custom_user_ids: string | null;
  status: string;
  recipient_count: number;
  scheduled_at: Date | null;
  sent_at: Date | null;
  created_by: bigint | null;
  created_at: Date;
  updated_at: Date | null;
}) {
  return {
    id: campaign.id,
    title: campaign.title,
    content: campaign.content,
    image_urls: parseJsonArray<string>(campaign.image_urls ?? null),
    audience: parseJsonArray<AudienceSegment>(campaign.audience),
    custom_user_ids: parseJsonArray<string>(campaign.custom_user_ids),
    status: campaign.status,
    recipient_count: campaign.recipient_count,
    scheduled_at: campaign.scheduled_at,
    sent_at: campaign.sent_at,
    created_by: campaign.created_by?.toString() ?? null,
    created_at: campaign.created_at,
    updated_at: campaign.updated_at,
  };
}

export class NewsletterCampaignService {
  constructor(private readonly requestId: string) {}

  async listSubscribers(options: { page?: number; limit?: number; search?: string }) {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const skip = (page - 1) * limit;

    const prefs = await prisma.notificationPreference.findMany({
      where: { unsubscribed_at: null },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            first_name: true,
            last_name: true,
            role: true,
            created_at: true,
            bizcards: {
              where: { deactivated_flag: false },
              select: { subscription_tier: true },
              take: 3,
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });

    const optedIn = prefs.filter((pref) => readPromotionalEmailOptIn(pref.preferences));
    const search = options.search?.trim().toLowerCase();

    const filtered = optedIn.filter((pref) => {
      if (!search) return true;
      const name = `${pref.user.first_name} ${pref.user.last_name}`.toLowerCase();
      return name.includes(search) || pref.user.email.toLowerCase().includes(search);
    });

    const total = filtered.length;
    const slice = filtered.slice(skip, skip + limit);

    return {
      subscribers: slice.map((pref) => {
        const tiers = pref.user.bizcards
          .map((b) => b.subscription_tier)
          .filter(Boolean) as string[];
        const tierSummary = tiers.length ? [...new Set(tiers)].join(", ") : "—";
        return {
          user_id: pref.user.user_id.toString(),
          email: pref.user.email,
          name: `${pref.user.first_name} ${pref.user.last_name}`.trim(),
          role: pref.user.role,
          tier: tierSummary,
          opted_in_at: pref.created_at,
        };
      }),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async resolveAudienceUserIds(audience: AudienceSegment[], customUserIds: string[] = []): Promise<bigint[]> {
    const userIdSet = new Set<string>();

    if (audience.includes("custom") && customUserIds.length) {
      customUserIds.forEach((id) => userIdSet.add(id));
    }

    const tierSegments = audience.filter((s) =>
      ["basic", "standard", "premium"].includes(s)
    ) as Array<"basic" | "standard" | "premium">;

    if (tierSegments.length) {
      const bizcards = await prisma.bizcard.findMany({
        where: {
          deactivated_flag: false,
          subscription_tier: { in: tierSegments },
          user: { deactivated_flag: false, is_active: true },
        },
        select: { user_id: true },
        distinct: ["user_id"],
      });
      bizcards.forEach((b) => {
        if (b.user_id != null) userIdSet.add(b.user_id.toString());
      });
    }

    if (audience.includes("free_trial")) {
      const trialPlans = await prisma.subscriptionPlan.findMany({
        where: { is_trial: true, is_active: true },
        select: { id: true },
      });
      if (trialPlans.length) {
        const subs = await prisma.bizcardSubscription.findMany({
          where: {
            plan_id: { in: trialPlans.map((p) => p.id) },
            status: { in: ["active", "pending"] },
          },
          include: { bizcard: { select: { user_id: true } } },
        });
        subs.forEach((s) => {
          if (s.bizcard.user_id != null) userIdSet.add(s.bizcard.user_id.toString());
        });
      }
    }

    if (audience.includes("company_admins")) {
      const admins = await prisma.user.findMany({
        where: {
          deactivated_flag: false,
          is_active: true,
          role: { in: ["company_admin", "admin"] },
          company_id: { not: null },
        },
        select: { user_id: true },
      });
      admins.forEach((u) => userIdSet.add(u.user_id.toString()));
    }

    if (!userIdSet.size) return [];

    const prefs = await prisma.notificationPreference.findMany({
      where: {
        unsubscribed_at: null,
        user_id: { in: Array.from(userIdSet).map((id) => BigInt(id)) },
      },
      include: {
        user: { select: { user_id: true, email: true, deactivated_flag: true, is_active: true } },
      },
    });

    return prefs
      .filter(
        (pref) =>
          readPromotionalEmailOptIn(pref.preferences) &&
          !pref.user.deactivated_flag &&
          pref.user.is_active &&
          pref.user.email
      )
      .map((pref) => pref.user_id);
  }

  async listCampaigns() {
    const campaigns = await prisma.marketingEmailCampaign.findMany({
      orderBy: { created_at: "desc" },
    });
    return campaigns.map(toCampaignResponse);
  }

  async getCampaignById(id: string) {
    const campaign = await prisma.marketingEmailCampaign.findUnique({ where: { id } });
    if (!campaign) {
      throw createProductPromoError(
        ProductPromoErrorCode.PRODUCT_NOT_FOUND,
        "Campaign not found",
        404,
        this.requestId,
        { campaignId: id }
      );
    }
    return toCampaignResponse(campaign);
  }

  async createCampaign(data: CampaignData, createdBy: string) {
    if (!data.title?.trim()) {
      throw createProductPromoError(
        ProductPromoErrorCode.PRODUCT_CREATION_FAILED,
        "Campaign title is required",
        400,
        this.requestId
      );
    }
    const imageUrls = cleanImageUrls(data.image_urls);
    const content = data.content?.trim() ?? "";
    if (!content && !imageUrls.length) {
      throw createProductPromoError(
        ProductPromoErrorCode.PRODUCT_CREATION_FAILED,
        "Add campaign content or attach at least one image",
        400,
        this.requestId
      );
    }
    if (!data.audience?.length) {
      throw createProductPromoError(
        ProductPromoErrorCode.INVALID_TARGET_GROUP,
        "At least one audience segment is required",
        400,
        this.requestId
      );
    }

    const campaign = await prisma.marketingEmailCampaign.create({
      data: {
        id: randomId("mkt"),
        title: data.title.trim(),
        content: content || " ",
        image_urls: toJsonString(imageUrls),
        audience: toJsonString(data.audience) ?? "[]",
        custom_user_ids: toJsonString(data.custom_user_ids ?? []),
        status: "draft",
        scheduled_at: data.scheduled_at ?? null,
        created_by: BigInt(createdBy),
      },
    });

    return toCampaignResponse(campaign);
  }

  async updateCampaign(id: string, data: Partial<CampaignData> & { status?: string }) {
    const existing = await prisma.marketingEmailCampaign.findUnique({ where: { id } });
    if (!existing) {
      throw createProductPromoError(
        ProductPromoErrorCode.PRODUCT_NOT_FOUND,
        "Campaign not found",
        404,
        this.requestId,
        { campaignId: id }
      );
    }
    if (existing.status === "sent") {
      throw createProductPromoError(
        ProductPromoErrorCode.PRODUCT_UPDATE_FAILED,
        "Cannot update a campaign that has already been sent",
        400,
        this.requestId
      );
    }

    const campaign = await prisma.marketingEmailCampaign.update({
      where: { id },
      data: {
        ...(data.title !== undefined ? { title: data.title.trim() } : {}),
        ...(data.content !== undefined ? { content: data.content.trim() || " " } : {}),
        ...(data.image_urls !== undefined
          ? { image_urls: toJsonString(cleanImageUrls(data.image_urls)) }
          : {}),
        ...(data.audience !== undefined ? { audience: toJsonString(data.audience) ?? "[]" } : {}),
        ...(data.custom_user_ids !== undefined ? { custom_user_ids: toJsonString(data.custom_user_ids) } : {}),
        ...(data.scheduled_at !== undefined ? { scheduled_at: data.scheduled_at } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        updated_at: new Date(),
      },
    });

    return toCampaignResponse(campaign);
  }

  async deleteCampaign(id: string) {
    const existing = await prisma.marketingEmailCampaign.findUnique({ where: { id } });
    if (!existing) {
      throw createProductPromoError(
        ProductPromoErrorCode.PRODUCT_NOT_FOUND,
        "Campaign not found",
        404,
        this.requestId,
        { campaignId: id }
      );
    }
    await prisma.marketingEmailCampaign.delete({ where: { id } });
    return { deleted: true, id };
  }

  async sendCampaign(id: string) {
    const campaign = await prisma.marketingEmailCampaign.findUnique({ where: { id } });
    if (!campaign) {
      throw createProductPromoError(
        ProductPromoErrorCode.PRODUCT_NOT_FOUND,
        "Campaign not found",
        404,
        this.requestId,
        { campaignId: id }
      );
    }
    if (campaign.status === "sent") {
      throw createProductPromoError(
        ProductPromoErrorCode.PRODUCT_UPDATE_FAILED,
        "Campaign has already been sent",
        400,
        this.requestId
      );
    }

    const audience = parseJsonArray<AudienceSegment>(
      typeof campaign.audience === "string" ? campaign.audience : JSON.stringify(campaign.audience ?? []),
    );
    const customIds = parseJsonArray<string>(
      typeof campaign.custom_user_ids === "string"
        ? campaign.custom_user_ids
        : JSON.stringify(campaign.custom_user_ids ?? []),
    );
    const imageUrls = parseJsonArray<string>(
      typeof (campaign as { image_urls?: string | null }).image_urls === "string"
        ? (campaign as { image_urls?: string | null }).image_urls ?? null
        : null,
    );

    const recipientIds = await this.resolveAudienceUserIds(audience, customIds);
    if (!recipientIds.length) {
      throw createProductPromoError(
        ProductPromoErrorCode.INVALID_TARGET_GROUP,
        "No eligible subscribers found for the selected audience",
        400,
        this.requestId
      );
    }

    const users = await prisma.user.findMany({
      where: { user_id: { in: recipientIds } },
      select: { user_id: true, email: true, first_name: true, last_name: true },
    });

    const now = new Date();
    for (const user of users) {
      await prisma.notificationEmailQueue.create({
        data: {
          id: randomId("email"),
          user_id: user.user_id,
          email_type: "marketing_campaign",
          priority: 5,
          subject: campaign.title,
          template_name: "marketing_campaign",
          template_data: JSON.stringify({
            title: campaign.title,
            content: campaign.content,
            image_urls: imageUrls,
            recipientName: `${user.first_name} ${user.last_name}`.trim(),
          }),
          recipient_email: user.email,
          recipient_name: `${user.first_name} ${user.last_name}`.trim(),
          status: "queued",
        },
      });
    }

    const updated = await prisma.marketingEmailCampaign.update({
      where: { id },
      data: {
        status: "queued",
        recipient_count: users.length,
        sent_at: now,
        updated_at: now,
      },
    });

    return toCampaignResponse(updated);
  }

  async processScheduledCampaigns(): Promise<{ processed: number; campaignIds: string[]; errors: string[] }> {
    const now = new Date();
    const dueCampaigns = await prisma.marketingEmailCampaign.findMany({
      where: {
        status: "draft",
        scheduled_at: { lte: now, not: null },
      },
      orderBy: { scheduled_at: "asc" },
      take: 20,
    });

    const campaignIds: string[] = [];
    const errors: string[] = [];

    for (const campaign of dueCampaigns) {
      try {
        await this.sendCampaign(campaign.id);
        campaignIds.push(campaign.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown campaign send error";
        errors.push(`${campaign.id}: ${message}`);
        console.error("[NEWSLETTER_CRON] Failed to send scheduled campaign", campaign.id, error);
      }
    }

    return { processed: campaignIds.length, campaignIds, errors };
  }
}
