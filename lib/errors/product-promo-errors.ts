import { AppError, ErrorCode } from "@/lib/errors/types";

export enum ProductPromoErrorCode {
  // Authorization errors (21000-21099)
  UNAUTHORIZED_ACCESS = "PRODUCT_PROMO_21000",
  SUPERADMIN_REQUIRED = "PRODUCT_PROMO_21001",

  // Product errors (21100-21199)
  PRODUCT_NOT_FOUND = "PRODUCT_PROMO_21100",
  PRODUCT_NAME_EXISTS = "PRODUCT_PROMO_21101",
  PRODUCT_CREATION_FAILED = "PRODUCT_PROMO_21102",
  PRODUCT_UPDATE_FAILED = "PRODUCT_PROMO_21103",
  PRODUCT_DELETE_FAILED = "PRODUCT_PROMO_21104",
  INVALID_PRODUCT_PRICE = "PRODUCT_PROMO_21105",
  INVALID_PRODUCT_CATEGORY = "PRODUCT_PROMO_21106",

  // Promo errors (21200-21299)
  PROMO_NOT_FOUND = "PRODUCT_PROMO_21200",
  PROMO_NAME_EXISTS = "PRODUCT_PROMO_21201",
  PROMO_CREATION_FAILED = "PRODUCT_PROMO_21202",
  PROMO_UPDATE_FAILED = "PRODUCT_PROMO_21203",
  PROMO_DELETE_FAILED = "PRODUCT_PROMO_21204",
  PROMO_EXPIRED = "PRODUCT_PROMO_21205",
  PROMO_NOT_STARTED = "PRODUCT_PROMO_21206",
  INVALID_PROMO_DATES = "PRODUCT_PROMO_21207",
  INVALID_PROMO_TYPE = "PRODUCT_PROMO_21208",
  INVALID_DISCOUNT_VALUE = "PRODUCT_PROMO_21209",
  PROMO_USAGE_LIMIT_REACHED = "PRODUCT_PROMO_21210",

  // Target group errors (21300-21399)
  INVALID_TARGET_GROUP = "PRODUCT_PROMO_21300",
  TARGET_GROUP_NOT_FOUND = "PRODUCT_PROMO_21301",

  // Image errors (21400-21499)
  IMAGE_UPLOAD_FAILED = "PRODUCT_PROMO_21400",
  INVALID_IMAGE_URL = "PRODUCT_PROMO_21401",

  // Date/Filter errors (21500-21599)
  INVALID_DATE_RANGE = "PRODUCT_PROMO_21500",
  START_DATE_AFTER_END_DATE = "PRODUCT_PROMO_21501",

  // Rate limiting (21600-21699)
  RATE_LIMIT_EXCEEDED = "PRODUCT_PROMO_21600",
  INTERNAL_ERROR = "PRODUCT_PROMO_21601",
}

export interface ProductPromoErrorResponse {
  success: false;
  error: {
    code: ProductPromoErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
    timestamp: string;
  };
  meta?: {
    requestId: string;
    responseTime?: number;
  };
}

export function toProductPromoErrorCode(code: ProductPromoErrorCode): ErrorCode {
  return code as unknown as ErrorCode;
}

export function createProductPromoError(
  code: ProductPromoErrorCode,
  message: string,
  statusCode: number,
  requestId: string,
  details?: Record<string, unknown>
): AppError {
  return new AppError(toProductPromoErrorCode(code), message, statusCode, details, requestId);
}

export function toProductPromoErrorResponse(
  code: ProductPromoErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
  responseTime?: number
): ProductPromoErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      details,
      requestId,
      timestamp: new Date().toISOString(),
    },
    meta: {
      requestId,
      ...(responseTime !== undefined ? { responseTime } : {}),
    },
  };
}

export function extractProductPromoErrorCode(error: AppError): ProductPromoErrorCode | null {
  const value = String(error.code);
  if (value.startsWith("PRODUCT_PROMO_")) {
    return value as ProductPromoErrorCode;
  }
  return null;
}
