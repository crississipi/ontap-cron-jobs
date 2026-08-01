// ──────────────────────────────────────────────────────────────
// Request Utilities
// ──────────────────────────────────────────────────────────────
// Common utilities for handling HTTP requests
// ──────────────────────────────────────────────────────────────

import { randomBytes } from 'crypto';

/**
 * Generate unique request ID for tracking
 */
export function generateRequestId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Get client IP address from request
 */
export function getClientIP(req: Request): string {
  return req.headers.get('x-forwarded-for') || 
         req.headers.get('x-real-ip') || 
         req.headers.get('cf-connecting-ip') || 
         'unknown';
}

/**
 * Resolve the public site origin for email links and redirects behind reverse proxies.
 */
export function getPublicRequestOrigin(req: Pick<Request, "headers"> & { url?: string }): string {
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();

  if (forwardedHost) {
    const proto = forwardedProto === "http" ? "http" : "https";
    return `${proto}://${forwardedHost}`.replace(/\/+$/, "");
  }

  if (req.url) {
    try {
      return new URL(req.url).origin.replace(/\/+$/, "");
    } catch {
      // Fall through to empty string.
    }
  }

  return "";
}

/**
 * Get user agent from request
 */
export function getUserAgent(req: Request): string {
  return req.headers.get('user-agent') || 'unknown';
}

/**
 * Parse pagination parameters
 */
export function parsePaginationParams(searchParams: URLSearchParams): {
  page: number;
  limit: number;
  offset: number;
} {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));
  const offset = (page - 1) * limit;
  
  return { page, limit, offset };
}

/**
 * Create pagination metadata
 */
export function createPaginationMeta(
  page: number,
  limit: number,
  total: number
): {
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrevious: boolean;
} {
  const pages = Math.ceil(total / limit);
  
  return {
    page,
    limit,
    total,
    pages,
    hasNext: page < pages,
    hasPrevious: page > 1
  };
}

/**
 * Create API response metadata
 */
export function createResponseMeta(
  requestId: string,
  responseTime: number,
  additional?: Record<string, any>
): {
  requestId: string;
  responseTime: number;
  timestamp: string;
  [key: string]: any;
} {
  return {
    requestId,
    responseTime,
    timestamp: new Date().toISOString(),
    ...additional
  };
}

/**
 * Validate sort parameters
 */
export function validateSortParams(
  searchParams: URLSearchParams,
  allowedFields: string[]
): {
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
} {
  const sortBy = searchParams.get('sort_by');
  const sortOrder = searchParams.get('sort_order') as 'asc' | 'desc';
  
  if (sortBy && !allowedFields.includes(sortBy)) {
    throw new Error(`Invalid sort field: ${sortBy}`);
  }
  
  if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
    throw new Error(`Invalid sort order: ${sortOrder}`);
  }
  
  return {
    sortBy: sortBy || undefined,
    sortOrder: sortOrder || 'desc'
  };
}

/**
 * Extract search query safely
 */
export function extractSearchQuery(searchParams: URLSearchParams): string | undefined {
  const query = searchParams.get('search');
  return query?.trim() || undefined;
}
