import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AppError, ErrorCode } from "@/lib/errors/types";

export function getRequestId(headers: Headers): string {
  return headers.get("x-request-id") ?? randomUUID();
}

export function jsonSuccess<T>(
  data: T,
  meta: { requestId: string; responseTime: number; timestamp?: string },
  status = 200
): NextResponse {
  return NextResponse.json(
    {
      success: true,
      data,
      meta: {
        requestId: meta.requestId,
        responseTime: meta.responseTime,
        timestamp: meta.timestamp ?? new Date().toISOString(),
      },
    },
    { status }
  );
}

export function jsonAppError(error: AppError, responseTime: number): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: error.toJSON(),
      meta: {
        requestId: error.requestId,
        responseTime,
      },
    },
    { status: error.statusCode }
  );
}

export function jsonUnknownError(requestId: string, responseTime: number): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: ErrorCode.INTERNAL_SERVER_ERROR,
        message: "An unexpected error occurred",
        requestId,
      },
      meta: { requestId, responseTime },
    },
    { status: 500 }
  );
}
