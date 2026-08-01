import { AppError, ErrorCode } from "@/lib/errors/types";

export enum DashboardErrorCode {
  // Authorization errors (6000-6099)
  UNAUTHORIZED_ACCESS = "DASHBOARD_6000",
  NOT_COMPANY_ADMIN = "DASHBOARD_6001",
  COMPANY_NOT_FOUND = "DASHBOARD_6002",
  EMPLOYEE_NOT_FOUND = "DASHBOARD_6003",

  // Date/Filter errors (6100-6199)
  INVALID_DATE_RANGE = "DASHBOARD_6100",
  INVALID_FILTER_TYPE = "DASHBOARD_6101",
  DATE_RANGE_TOO_LARGE = "DASHBOARD_6102",
  INVALID_TIMEZONE = "DASHBOARD_6103",

  // Data errors (6200-6299)
  ANALYTICS_DATA_UNAVAILABLE = "DASHBOARD_6200",
  NO_EMPLOYEES_FOUND = "DASHBOARD_6201",

  // Rate limiting (6300-6399)
  RATE_LIMIT_EXCEEDED = "DASHBOARD_6300",
}

export interface DashboardErrorResponse {
  success: false;
  error: {
    code: DashboardErrorCode;
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

export function toDashboardErrorCode(code: DashboardErrorCode): ErrorCode {
  return code as unknown as ErrorCode;
}

export function createDashboardError(
  code: DashboardErrorCode,
  message: string,
  statusCode: number,
  requestId: string,
  details?: Record<string, unknown>
): AppError {
  return new AppError(toDashboardErrorCode(code), message, statusCode, details, requestId);
}

export function toDashboardErrorResponse(
  code: DashboardErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
  responseTime?: number
): DashboardErrorResponse {
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

export function extractDashboardErrorCode(error: AppError): DashboardErrorCode | null {
  const value = String(error.code);
  if (value.startsWith("DASHBOARD_")) {
    return value as DashboardErrorCode;
  }
  return null;
}
