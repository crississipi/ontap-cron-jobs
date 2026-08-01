/**
 * Cron Job: Process QR Code Queue
 * 
 * Endpoint: GET /api/cron/process-qr-queue
 * 
 * This endpoint processes the QR code generation queue asynchronously.
 * Call this periodically from an external cron service (e.g., Vercel Cron).
 * 
 * Can also be called manually to flush the queue on-demand.
 */

import { NextRequest, NextResponse } from "next/server";
import { getQRQueueStats, flushQRQueue } from "@/lib/services/qr-code.queue";
import { requireCronAuth } from "@/server/lib/notification-cron";

export const maxDuration = 60; // 60 second timeout for cron jobs

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  try {
    // Get current queue statistics
    const statsBefore = getQRQueueStats();

    console.info("[cron/process-qr-queue] Starting QR queue flush", {
      queueDepth: statsBefore.queueDepth,
      dlqSize: statsBefore.dlqSize,
    });

    // Wait for queue to process (up to 55 seconds, leaving 5s buffer)
    await Promise.race([
      flushQRQueue(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Queue flush timeout")), 55000)
      ),
    ]);

    const statsAfter = getQRQueueStats();

    console.info("[cron/process-qr-queue] QR queue flush completed", {
      queueDepthBefore: statsBefore.queueDepth,
      queueDepthAfter: statsAfter.queueDepth,
      dlqSize: statsAfter.dlqSize,
    });

    return NextResponse.json(
      {
        success: true,
        message: "QR queue processed",
        statsBefore,
        statsAfter,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[cron/process-qr-queue] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
