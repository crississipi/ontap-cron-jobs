import { AppError, ErrorCode } from "@/lib/errors/types";

export enum CompanyNotificationErrorCode {
  AUTHENTICATION_REQUIRED = "NOTIFICATION_3600",
  INSUFFICIENT_ROLE = "NOTIFICATION_3601",
  INVALID_PAYLOAD = "NOTIFICATION_3602",
  INVALID_DIGEST_SCHEDULE = "NOTIFICATION_3603",
  INVALID_DIGEST_TIME = "NOTIFICATION_3604",
  INVALID_TIMEZONE = "NOTIFICATION_3605",
  INVALID_QUIET_HOURS = "NOTIFICATION_3606",
  EMPLOYEE_NOT_FOUND = "NOTIFICATION_3607",
  RATE_LIMIT_EXCEEDED = "NOTIFICATION_3608",
  COMPANY_NOT_FOUND = "NOTIFICATION_3609",
  DELIVERY_UNAVAILABLE = "NOTIFICATION_3610",
}

export function toCompanyNotificationErrorCode(code: CompanyNotificationErrorCode): ErrorCode {
  return code as unknown as ErrorCode;
}

export function createCompanyNotificationError(
  code: CompanyNotificationErrorCode,
  message: string,
  statusCode: number,
  requestId?: string,
  details?: Record<string, unknown>
): AppError {
  return new AppError(toCompanyNotificationErrorCode(code), message, statusCode, details, requestId);
}

export function extractCompanyNotificationErrorCode(error: AppError): CompanyNotificationErrorCode | null {
  const value = String(error.code);
  if (value.startsWith("NOTIFICATION_")) {
    return value as CompanyNotificationErrorCode;
  }
  return null;
}