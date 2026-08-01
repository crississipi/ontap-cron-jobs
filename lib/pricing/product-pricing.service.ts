import { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/prisma";

export enum ProductConfigErrorCode {
  MISSING_CONFIGURATION = "PROD_CFG_40000",
  INVALID_SUBSCRIPTION_TIER = "PROD_CFG_40001",
  INVALID_LOGO_TYPE = "PROD_CFG_40002",
  PRICE_MISMATCH = "PROD_CFG_40003",
  PRODUCT_NOT_FOUND = "PROD_CFG_40004",
}

export type SubscriptionTier = "basic" | "standard" | "premium";
export type LogoType = "default" | "custom";

export interface ProductOptionsInput {
  variant?: string | null;
  subscriptionTier?: string | null;
  logoType?: string | null;
}

export interface NormalizedProductOptions {
  variant: string | null;
  variantKey: string | null;
  subscriptionTier: SubscriptionTier;
  logoType: LogoType;
}

export interface ProductPricingBreakdown {
  basePrice: number;
  subscriptionAddon: number;
  logoAddon: number;
  variantAddon: number;
  unitPrice: number;
}

export interface ProductPricingResult {
  productId: bigint;
  productName: string;
  options: NormalizedProductOptions;
  breakdown: ProductPricingBreakdown;
  unitPrice: number;
}

const DEFAULT_SUBSCRIPTION_ADDON_PRICES: Record<SubscriptionTier, number> = {
  basic: 0,
  standard: 199,
  premium: 300,
};

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeVariant(value: string | null | undefined): string | null {
  return normalizeText(value);
}

function normalizeSubscriptionTier(value: string | null | undefined): SubscriptionTier {
  const normalized = normalizeText(value)?.toLowerCase();
  if (normalized === "standard" || normalized === "premium") return normalized;
  return "basic";
}

function normalizeLogoType(value: string | null | undefined): LogoType {
  const normalized = normalizeText(value)?.toLowerCase();
  if (normalized === "custom") return "custom";
  return "default";
}

function readJsonNumberMap(value: Prisma.JsonValue | string | null | undefined): Record<string, number> {
  let parsedValue: unknown = value;
  if (typeof parsedValue === "string") {
    const trimmed = parsedValue.trim();
    if (!trimmed) return {};
    try {
      parsedValue = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }

  if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(parsedValue as Record<string, unknown>)) {
    const parsed = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (Number.isFinite(parsed)) {
      result[key.toLowerCase()] = parsed;
    }
  }
  return result;
}

export function resolveMerchandiseBasePrice(product: {
  price: number | bigint;
  custom_price?: boolean | null;
  custom_price_value?: Prisma.Decimal | number | null;
}): number {
  if (product.custom_price_value !== null && product.custom_price_value !== undefined) {
    const customValue = Number(product.custom_price_value);
    if (Number.isFinite(customValue)) {
      return customValue;
    }
  }

  return Number(product.price);
}

export function normalizeProductOptions(input: ProductOptionsInput): NormalizedProductOptions {
  return {
    variant: normalizeVariant(input.variant),
    variantKey: normalizeVariant(input.variant)?.toLowerCase() ?? null,
    subscriptionTier: normalizeSubscriptionTier(input.subscriptionTier),
    logoType: normalizeLogoType(input.logoType),
  };
}

export async function calculateProductUnitPrice(
  productId: bigint,
  input: ProductOptionsInput,
): Promise<ProductPricingResult> {
  const product = await prisma.merchandise.findFirst({
    where: { id: productId, is_active: true },
    select: {
      id: true,
      name: true,
      price: true,
      custom_price_value: true,
      subscription_addon_prices: true,
      logo_addon_price: true,
      variant_prices: true,
    },
  });

  if (!product) {
    throw new Error(ProductConfigErrorCode.PRODUCT_NOT_FOUND);
  }

  const options = normalizeProductOptions(input);
  const basePrice = resolveMerchandiseBasePrice(product);
  const subscriptionAddonPrices = readJsonNumberMap(product.subscription_addon_prices);
  const variantPrices = readJsonNumberMap(product.variant_prices);

  const subscriptionAddon =
    options.subscriptionTier === "basic"
      ? DEFAULT_SUBSCRIPTION_ADDON_PRICES.basic
      : subscriptionAddonPrices[options.subscriptionTier] ?? DEFAULT_SUBSCRIPTION_ADDON_PRICES[options.subscriptionTier];

  const logoAddon = options.logoType === "custom" ? Number(product.logo_addon_price ?? 0) : 0;
  const variantAddon = options.variantKey ? variantPrices[options.variantKey] ?? 0 : 0;

  const unitPrice = Math.round((basePrice + subscriptionAddon + logoAddon + variantAddon) * 100) / 100;

  return {
    productId: product.id,
    productName: product.name,
    options,
    breakdown: {
      basePrice,
      subscriptionAddon,
      logoAddon,
      variantAddon,
      unitPrice,
    },
    unitPrice,
  };
}