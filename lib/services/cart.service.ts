import { Prisma, type CartItem as PrismaCartItem } from "@prisma/client";
import { prisma } from "@/server/lib/prisma";
import { calculateProductUnitPrice, normalizeProductOptions } from "@/lib/pricing/product-pricing.service";
import { parseJsonObject, toJsonString } from "@/server/lib/json-field";

export enum CartErrorCode {
  UNAUTHORIZED = "CART_24000",
  USER_NOT_FOUND = "CART_24001",
  PRODUCT_NOT_FOUND = "CART_24100",
  PRODUCT_OUT_OF_STOCK = "CART_24101",
  INVALID_QUANTITY = "CART_24102",
  CART_NOT_FOUND = "CART_24200",
  ITEM_NOT_IN_CART = "CART_24201",
  ITEM_ALREADY_IN_CART = "CART_24202",
  CART_EMPTY = "CART_24203",
  EMAIL_SEND_FAILED = "CART_24300",
  RATE_LIMIT_EXCEEDED = "CART_24400",
}

export interface CartLineItem {
  id: string;
  productId: string;
  name: string;
  price: number;
  quantity: number;
  image: string | null;
  category: string | null;
  isSelected: true;
  variant: string | null;
  subscriptionTier: string | null;
  logoType: string | null;
  customData: Record<string, unknown> | null;
}

export interface CartSummary {
  totalItems: number;
  subtotal: number;
  selectedItemsCount: number;
  selectedSubtotal: number;
}

export interface CartResponse {
  items: CartLineItem[];
  summary: CartSummary;
}

export interface CartItemResponse {
  id: string;
  productId: string;
  name: string;
  price: number;
  quantity: number;
  image: string | null;
  category: string | null;
  variant: string | null;
  subscriptionTier: string | null;
  logoType: string | null;
  customData: Record<string, unknown> | null;
}

export interface AddCartItemInput {
  productId: bigint;
  quantity: number;
  variant?: string | null;
  subscriptionTier?: string | null;
  logoType?: string | null;
  customData?: Prisma.InputJsonValue | null;
  note?: string | null;
}

const MERCHANDISE_SELECT = {
  id: true,
  name: true,
  price: true,
  custom_price_value: true,
  img_url: true,
  category: true,
  is_active: true,
  subscription_addon_prices: true,
  logo_addon_price: true,
  variant_prices: true,
} satisfies Prisma.MerchandiseSelect;

type SelectedMerchandise = Prisma.MerchandiseGetPayload<{ select: typeof MERCHANDISE_SELECT }>;

function normalizeVariant(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toId(value: bigint | number | string): string {
  return value.toString();
}

function mapMerchandise(item: PrismaCartItem, merchandise: SelectedMerchandise | undefined): CartLineItem {
  const unitPrice = Number(item.price_at_time);

  const baseCustomData = parseJsonObject<Record<string, unknown>>(item.custom_data);
  const mergedCustomData = baseCustomData
    ? { ...baseCustomData, ...(item.note ? { note: item.note } : {}) }
    : item.note
    ? { note: item.note }
    : null;

  return {
    id: toId(item.id),
    productId: toId(item.item_id),
    name: merchandise?.name ?? "Unknown item",
    price: unitPrice,
    quantity: item.quantity,
    image: merchandise?.img_url ?? null,
    category: merchandise?.category ?? null,
    isSelected: true,
    variant: item.variant ?? null,
    subscriptionTier: item.subscription_tier ?? null,
    logoType: item.logo_type ?? null,
    customData: mergedCustomData,
  };
}

async function ensureCart(userId: bigint) {
  return prisma.cart.upsert({
    where: { user_id: userId },
    create: { user_id: userId },
    update: {},
  });
}

export async function ensureCartRecord(userId: bigint) {
  return ensureCart(userId);
}

async function touchCart(userId: bigint) {
  await prisma.$executeRaw`UPDATE Cart SET updated_at = NOW() WHERE user_id = ${userId}`;
}

async function loadMerchandiseMap(productIds: bigint[]) {
  if (productIds.length === 0) {
    return new Map<string, SelectedMerchandise>();
  }

  const merchandise = await prisma.merchandise.findMany({
    where: { id: { in: productIds } },
    select: MERCHANDISE_SELECT,
  });

  return new Map(merchandise.map((product) => [product.id.toString(), product]));
}

export async function getCartForUser(userId: bigint): Promise<CartResponse> {
  await ensureCart(userId);

  const cartItems = await prisma.cartItem.findMany({
    where: {
      user_id: userId,
      item_type: "merchandise",
    },
    orderBy: [{ added_at: "desc" }, { id: "desc" }],
  });

  const merchandiseMap = await loadMerchandiseMap(cartItems.map((item) => item.item_id));

  const items = cartItems.map((item) => {
    const merchandise = merchandiseMap.get(item.item_id.toString());
    return mapMerchandise(item, merchandise);
  });

  const summary = items.reduce<CartSummary>(
    (accumulator, item) => {
      const lineTotal = item.price * item.quantity;
      accumulator.totalItems += item.quantity;
      accumulator.subtotal += lineTotal;
      accumulator.selectedItemsCount += item.quantity;
      accumulator.selectedSubtotal += lineTotal;
      return accumulator;
    },
    { totalItems: 0, subtotal: 0, selectedItemsCount: 0, selectedSubtotal: 0 }
  );

  return {
    items,
    summary: {
      totalItems: Math.round(summary.totalItems),
      subtotal: Math.round(summary.subtotal * 100) / 100,
      selectedItemsCount: Math.round(summary.selectedItemsCount),
      selectedSubtotal: Math.round(summary.selectedSubtotal * 100) / 100,
    },
  };
}

export async function addMerchandiseToCart(
  userId: bigint,
  input: AddCartItemInput
): Promise<{ cartItem: CartItemResponse; cartSummary: CartSummary; created: boolean }> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
    throw new Error(CartErrorCode.INVALID_QUANTITY);
  }

  const variant = normalizeVariant(input.variant);
  const normalizedOptions = normalizeProductOptions({
    variant,
    subscriptionTier: input.subscriptionTier,
    logoType: input.logoType,
  });
  const product = await prisma.merchandise.findFirst({
    where: { id: input.productId, is_active: true },
    select: MERCHANDISE_SELECT,
  });

  if (!product) {
    throw new Error(CartErrorCode.PRODUCT_NOT_FOUND);
  }

  const pricing = await calculateProductUnitPrice(input.productId, {
    variant: normalizedOptions.variant,
    subscriptionTier: normalizedOptions.subscriptionTier,
    logoType: normalizedOptions.logoType,
  });

  const cart = await ensureCart(userId);

  const existing = await prisma.cartItem.findFirst({
    where: {
      user_id: userId,
      item_type: "merchandise",
      item_id: input.productId,
      variant,
      subscription_tier: normalizedOptions.subscriptionTier,
      logo_type: normalizedOptions.logoType,
    },
  });

  let cartItem: PrismaCartItem;
  let created = false;

  if (existing) {
    const nextQuantity = existing.quantity + input.quantity;
    if (nextQuantity > 99) {
      throw new Error(CartErrorCode.INVALID_QUANTITY);
    }

    cartItem = await prisma.cartItem.update({
      where: { id: existing.id },
      data: {
        quantity: nextQuantity,
        price_at_time: pricing.unitPrice,
        variant,
        subscription_tier: normalizedOptions.subscriptionTier,
        logo_type: normalizedOptions.logoType,
        custom_data: toJsonString(input.customData),
        ...(input.note !== undefined ? { note: input.note } : {}),
        cart_id: cart.id,
      },
    });
  } else {
    cartItem = await prisma.cartItem.create({
      data: {
        cart_id: cart.id,
        user_id: userId,
        item_type: "merchandise",
        item_id: input.productId,
        variant,
        subscription_tier: normalizedOptions.subscriptionTier,
        logo_type: normalizedOptions.logoType,
        quantity: input.quantity,
        price_at_time: pricing.unitPrice,
        custom_data: toJsonString(input.customData),
        note: input.note ?? null,
      },
    });
    created = true;
  }

  await touchCart(userId);

  const cartState = await getCartForUser(userId);
  const responseItem = mapMerchandise(cartItem, product);

  return {
    cartItem: responseItem,
    cartSummary: cartState.summary,
    created,
  };
}

export async function updateCartItemQuantity(
  userId: bigint,
  itemId: bigint,
  quantity: number
): Promise<{ cartItem: CartItemResponse; cartSummary: CartSummary }> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new Error(CartErrorCode.INVALID_QUANTITY);
  }

  const existing = await prisma.cartItem.findFirst({
    where: { id: itemId, user_id: userId, item_type: "merchandise" },
  });

  if (!existing) {
    throw new Error(CartErrorCode.ITEM_NOT_IN_CART);
  }

  const product = await prisma.merchandise.findFirst({
    where: { id: existing.item_id, is_active: true },
    select: MERCHANDISE_SELECT,
  });

  if (!product) {
    throw new Error(CartErrorCode.PRODUCT_NOT_FOUND);
  }

  const updated = await prisma.cartItem.update({
    where: { id: existing.id },
    data: { quantity, price_at_time: Number(existing.price_at_time) },
  });

  await touchCart(userId);

  const cartState = await getCartForUser(userId);
  return {
    cartItem: mapMerchandise(updated, product),
    cartSummary: cartState.summary,
  };
}

export async function removeCartItem(userId: bigint, itemId: bigint): Promise<CartSummary> {
  const existing = await prisma.cartItem.findFirst({
    where: { id: itemId, user_id: userId, item_type: "merchandise" },
  });

  if (!existing) {
    throw new Error(CartErrorCode.ITEM_NOT_IN_CART);
  }

  await prisma.cartItem.delete({ where: { id: existing.id } });
  await touchCart(userId);
  return (await getCartForUser(userId)).summary;
}

export async function batchRemoveCartItems(userId: bigint, itemIds: bigint[]): Promise<CartSummary> {
  if (itemIds.length === 0) {
    return (await getCartForUser(userId)).summary;
  }

  await prisma.cartItem.deleteMany({
    where: { user_id: userId, item_type: "merchandise", id: { in: itemIds } },
  });

  await touchCart(userId);
  return (await getCartForUser(userId)).summary;
}

export async function clearCart(userId: bigint): Promise<void> {
  await prisma.cartItem.deleteMany({
    where: { user_id: userId, item_type: "merchandise" },
  });

  await touchCart(userId);
}

export async function getCartItemOrThrow(userId: bigint, itemId: bigint) {
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, user_id: userId, item_type: "merchandise" },
  });

  if (!item) {
    throw new Error(CartErrorCode.ITEM_NOT_IN_CART);
  }

  const product = await prisma.merchandise.findFirst({
    where: { id: item.item_id, is_active: true },
    select: MERCHANDISE_SELECT,
  });

  if (!product) {
    throw new Error(CartErrorCode.PRODUCT_NOT_FOUND);
  }

  return { item, product };
}

export async function listAbandonedCartCandidates(referenceDate = new Date()) {
  const minUpdatedAt = new Date(referenceDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const maxUpdatedAt = new Date(referenceDate.getTime() - 3 * 24 * 60 * 60 * 1000);

  const carts = await prisma.cart.findMany({
    where: {
      updated_at: { gte: minUpdatedAt, lte: maxUpdatedAt },
      items: { some: { item_type: "merchandise" } },
    },
    include: {
      user: {
        select: {
          user_id: true,
          email: true,
          first_name: true,
          last_name: true,
          is_active: true,
          deactivated_flag: true,
        },
      },
      items: {
        where: { item_type: "merchandise" },
        select: {
          id: true,
          item_id: true,
          quantity: true,
          variant: true,
          subscription_tier: true,
          logo_type: true,
          price_at_time: true,
          custom_data: true,
          added_at: true,
          updated_at: true,
        },
      },
    },
    orderBy: { updated_at: "asc" },
  });

  const userIds = carts.map((cart) => cart.user_id);
  const checkedOutUsers = new Set<bigint>();

  if (userIds.length > 0) {
    const recentOrders = await prisma.shopOrder.findMany({
      where: {
        user_id: { in: userIds },
        placed_at: { gte: minUpdatedAt },
        status: { notIn: ["cancelled", "refunded"] },
      },
      select: { user_id: true },
    });

    for (const order of recentOrders) {
      checkedOutUsers.add(order.user_id);
    }
  }

  return carts.filter((cart) => !checkedOutUsers.has(cart.user_id) && cart.user.is_active && !cart.user.deactivated_flag);
}
