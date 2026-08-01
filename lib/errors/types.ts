export enum ErrorCode {
  THEME_NOT_FOUND = "THEME_1000",
  THEME_SLUG_TAKEN = "THEME_1001",
  THEME_INACTIVE = "THEME_1002",
  THEME_PREMIUM_REQUIRED = "THEME_1003",

  COLOR_WAY_NOT_FOUND = "COLOR_WAY_1100",
  COLOR_WAY_DUPLICATE = "COLOR_WAY_1101",
  COLOR_WAY_INVALID_VARIABLES = "COLOR_WAY_1102",

  SELECTION_NOT_FOUND = "SELECTION_1200",
  SELECTION_ALREADY_EXISTS = "SELECTION_1201",
  SELECTION_PERMISSION_DENIED = "SELECTION_1202",
  BIZCARD_NOT_FOUND = "SELECTION_1203",

  UNAUTHORIZED = "AUTH_1300",
  INVALID_SESSION = "AUTH_1301",
  INSUFFICIENT_PERMISSIONS = "AUTH_1302",

  VALIDATION_ERROR = "VALIDATION_1400",
  MISSING_REQUIRED_FIELD = "VALIDATION_1401",
  INVALID_FORMAT = "VALIDATION_1402",

  DATABASE_ERROR = "SYSTEM_1500",
  CACHE_ERROR = "SYSTEM_1501",
  RATE_LIMIT_EXCEEDED = "SYSTEM_1502",
  INTERNAL_SERVER_ERROR = "SYSTEM_1503",

  MEDIA_NOT_FOUND = "MEDIA_1600",
  MEDIA_PERMISSION_DENIED = "MEDIA_1601",
  MEDIA_VALIDATION_FAILED = "MEDIA_1602",
  MEDIA_UNSUPPORTED_TYPE = "MEDIA_1603",
  MEDIA_REORDER_INVALID = "MEDIA_1604",

  MEDIA_NOT_FOUND_V2 = "MEDIA_2000",
  MEDIA_UPLOAD_FAILED = "MEDIA_2001",
  MEDIA_DELETE_FAILED = "MEDIA_2002",
  MEDIA_INVALID_TYPE = "MEDIA_2003",
  MEDIA_TOO_LARGE = "MEDIA_2004",
  MEDIA_CORRUPTED = "MEDIA_2005",
  MEDIA_ALREADY_DELETED = "MEDIA_2006",
  MEDIA_NO_FILE = "MEDIA_2007",
  MEDIA_INVALID_BIZCARD = "MEDIA_2008",

  CLOUDINARY_UPLOAD_FAILED = "CLOUDINARY_2100",
  CLOUDINARY_DELETE_FAILED = "CLOUDINARY_2101",
  CLOUDINARY_CONNECTION_ERROR = "CLOUDINARY_2102",

  GALLERY_ACCESS_DENIED = "GALLERY_2200",
  GALLERY_FEATURE_LIMIT = "GALLERY_2201",
  GALLERY_ORDER_INVALID = "GALLERY_2202",
  GALLERY_BIZCARD_NOT_FOUND = "GALLERY_2203",

  AUDIT_LOG_FAILED = "AUDIT_2300",

  COMPANY_NOT_FOUND = "COMPANY_3000",
  COMPANY_ALREADY_EXISTS = "COMPANY_3001",
  COMPANY_PENDING_APPROVAL = "COMPANY_3002",
  COMPANY_SUSPENDED = "COMPANY_3003",
  COMPANY_REJECTED = "COMPANY_3004",
  COMPANY_NAME_CHANGE_PENDING = "COMPANY_3005",
  COMPANY_NAME_CHANGE_COOLDOWN = "COMPANY_3006",

  SUBSCRIPTION_REQUIRED = "SUBSCRIPTION_3100",
  EMPLOYEE_LIMIT_REACHED = "SUBSCRIPTION_3101",
  INVALID_SUBSCRIPTION_TIER = "SUBSCRIPTION_3102",

  EMPLOYEE_NOT_FOUND = "EMPLOYEE_3200",
  EMPLOYEE_ALREADY_IN_COMPANY = "EMPLOYEE_3201",
  EMPLOYEE_IN_ANOTHER_COMPANY = "EMPLOYEE_3202",
  EMPLOYEE_RESTRICTED = "EMPLOYEE_3203",
  EMPLOYEE_PERMISSION_DENIED = "EMPLOYEE_3204",
  CANNOT_REMOVE_LAST_ADMIN = "EMPLOYEE_3205",
  INVALID_EMPLOYEE_DATA = "EMPLOYEE_3206",

  JOIN_REQUEST_NOT_FOUND = "JOIN_3300",
  JOIN_REQUEST_PENDING = "JOIN_3301",
  JOIN_REQUEST_ALREADY_PROCESSED = "JOIN_3302",
  INVALID_SECURITY_CODE = "JOIN_3303",
  COMPANY_JOIN_DISABLED = "JOIN_3304",

  UNAUTHORIZED_COMPANY_ACTION = "AUTH_3400",
  ADMIN_REQUIRED = "AUTH_3401",
  SUPER_ADMIN_REQUIRED = "AUTH_3402",

  ANALYTICS_NOT_FOUND = "ANALYTICS_3500",
  INVALID_PERIOD = "ANALYTICS_3501",

  QR_CODE_GENERATION_FAILED = "QR_5000",
  QR_CODE_NOT_FOUND = "QR_5001",
  QR_CODE_ALREADY_EXISTS = "QR_5002",
  QR_CODE_INVALID_URL = "QR_5003",

  PHYSICAL_CARD_NOT_FOUND = "PHYSICAL_5100",
  PHYSICAL_CARD_ALREADY_LINKED = "PHYSICAL_5101",
  PHYSICAL_CARD_INVALID_SERIAL = "PHYSICAL_5102",
  PHYSICAL_CARD_SCAN_FAILED = "PHYSICAL_5103",
  PHYSICAL_CARD_EMPTY_RECORD = "PHYSICAL_5104",

  SERIAL_ID_MISSING = "SERIAL_5200",
  SERIAL_ID_INVALID_FORMAT = "SERIAL_5201",
  SERIAL_ID_ALREADY_USED = "SERIAL_5202",
  SERIAL_ID_NOT_ALLOWED = "SERIAL_5203",

  MERGE_FAILED_CARD_EXISTS = "MERGE_5300",
  MERGE_FAILED_ALREADY_MERGED = "MERGE_5301",
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  path?: string;
  method?: string;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly statusCode: number;
  public readonly requestId?: string;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>,
    requestId?: string
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
    this.requestId = requestId;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  toJSON(): ApiError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      requestId: this.requestId,
      timestamp: new Date().toISOString(),
    };
  }
}

export function createNotFoundError(resource: string, identifier: string | number, requestId?: string): AppError {
  return new AppError(
    ErrorCode.THEME_NOT_FOUND,
    `${resource} with identifier '${identifier}' not found`,
    404,
    { resource, identifier },
    requestId
  );
}

export function createUnauthorizedError(reason: string, requestId?: string): AppError {
  return new AppError(ErrorCode.UNAUTHORIZED, `Unauthorized: ${reason}`, 401, { reason }, requestId);
}

export function createValidationError(field: string, message: string, requestId?: string): AppError {
  return new AppError(
    ErrorCode.VALIDATION_ERROR,
    `Validation failed for field '${field}': ${message}`,
    400,
    { field, message },
    requestId
  );
}
