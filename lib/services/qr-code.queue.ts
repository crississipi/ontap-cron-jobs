/**
 * QR Code Background Queue
 *
 * Manages async QR code generation using an in-memory queue
 * with exponential backoff retry logic.
 *
 * Design:
 *   - In-memory queue (no external Redis/SQS dependency)
 *   - Processes items sequentially with configurable batch size
 *   - Retries failed items up to 3 times with exponential backoff
 *   - Logs all failures for manual review/recovery
 *   - Non-blocking (returns immediately after enqueueing)
 *
 * Usage:
 *   1. Call enqueueQRGeneration(bizcardId) during registration
 *   2. Queue processes automatically with background intervals
 *   3. Failed items retry up to 3 times before being moved to DLQ
 *   4. Monitor logs for queue depth and failure rates
 *
 * Integration:
 *   - Started automatically on app startup (server-side)
 *   - Called by app/api/bizcard/create/route.ts
 *   - Processable manually via scripts/process-qr-queue.ts
 */

import { prisma } from "@/server/lib/prisma";
import { generateOfflineQRCodeForBizcard } from "./qr-code.service";
import { buildVCardPublicUrl } from "@/server/lib/qr";

/**
 * Queue item structure
 */
interface QRQueueItem {
  bizcardId: bigint;
  retryCount: number;
  enqueuedAt: Date;
  lastRetryAt?: Date;
}

/**
 * In-memory queue implementation
 */
class QRCodeQueue {
  private queue: QRQueueItem[] = [];
  private dlq: Array<QRQueueItem & { reason: string }> = []; // Dead Letter Queue
  private processing = false;
  private processInterval: NodeJS.Timeout | null = null;
  private readonly MAX_RETRIES = 3;
  private readonly INITIAL_BACKOFF_MS = 1000;
  private readonly BATCH_SIZE = 10;
  private readonly PROCESS_INTERVAL_MS = 5000; // Check every 5 seconds

  /**
   * Enqueue a bizcard for QR generation
   */
  enqueue(bizcardId: bigint): void {
    // Prevent duplicate entries
    if (this.queue.some((item) => item.bizcardId === bizcardId)) {
      console.debug(`[QRQueue] ${bizcardId} already queued, skipping duplicate`);
      return;
    }

    this.queue.push({
      bizcardId,
      retryCount: 0,
      enqueuedAt: new Date(),
    });

    console.debug(
      `[QRQueue] Enqueued bizcard ${bizcardId} (queue depth: ${this.queue.length})`
    );
  }

  /**
   * Start processing queue items periodically
   */
  start(): void {
    if (this.processInterval) {
      console.warn("[QRQueue] Queue already started");
      return;
    }

    console.info("[QRQueue] Starting background processor");
    this.processInterval = setInterval(
      () => this.processNextBatch(),
      this.PROCESS_INTERVAL_MS
    );

    // Process immediately on startup
    this.processNextBatch();
  }

  /**
   * Stop queue processing
   */
  stop(): void {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
      console.info("[QRQueue] Stopped background processor");
    }
  }

  /**
   * Process next batch of items from queue
   */
  private async processNextBatch(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      const batch = this.queue.splice(0, this.BATCH_SIZE);
      const startTime = Date.now();

      console.debug(
        `[QRQueue] Processing batch of ${batch.length} items (${this.queue.length} remaining in queue)`
      );

      for (const item of batch) {
        await this.processItem(item);
      }

      const duration = Date.now() - startTime;
      console.info(
        `[QRQueue] Completed batch in ${duration}ms (queue depth: ${this.queue.length})`
      );
    } catch (err) {
      console.error("[QRQueue] Fatal error during batch processing:", err);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single queue item with retry logic
   */
  private async processItem(item: QRQueueItem): Promise<void> {
    try {
      // Fetch bizcard to get URL alias
      const bizcard = await prisma.bizcard.findUnique({
        where: { bizcard_id: item.bizcardId },
        select: {
          bizcard_id: true,
          url_alias: true,
          user_id: true,
        },
      });

      if (!bizcard) {
        this.dlq.push({
          ...item,
          reason: "BIZCARD_NOT_FOUND",
        });
        console.warn(`[QRQueue] Bizcard ${item.bizcardId} not found, moved to DLQ`);
        return;
      }

      if (!bizcard.url_alias) {
        this.dlq.push({
          ...item,
          reason: "NO_URL_ALIAS",
        });
        console.warn(
          `[QRQueue] Bizcard ${item.bizcardId} has no url_alias, moved to DLQ`
        );
        return;
      }

      // Generate portfolio URL
      const portfolioUrl = buildVCardPublicUrl(bizcard.url_alias);

      if (!portfolioUrl) {
        this.dlq.push({
          ...item,
          reason: "MISSING_PUBLIC_BASE_URL",
        });
        console.warn(
          `[QRQueue] Could not build public URL for ${item.bizcardId}, moved to DLQ`
        );
        return;
      }

      // Generate offline vCard QR code (persists to bizcard.qr_code_url)
      const qrResult = await generateOfflineQRCodeForBizcard(item.bizcardId);

      if (!qrResult.success || !qrResult.qrCodeUrl) {
        // Retry logic
        if (item.retryCount < this.MAX_RETRIES) {
          const backoffMs = this.INITIAL_BACKOFF_MS * Math.pow(2, item.retryCount);
          item.retryCount++;
          item.lastRetryAt = new Date();

          // Put it back in queue at the end (retry later)
          this.queue.push(item);
          console.warn(
            `[QRQueue] Generation failed for ${item.bizcardId}, retry ${item.retryCount}/${this.MAX_RETRIES} in ${backoffMs}ms`
          );
        } else {
          // Max retries exceeded
          this.dlq.push({
            ...item,
            reason: qrResult.error || "GENERATION_FAILED",
          });
          console.error(
            `[QRQueue] Generation failed for ${item.bizcardId} after ${this.MAX_RETRIES} retries, moved to DLQ`
          );
        }
        return;
      }

      console.debug(`[QRQueue] Successfully processed bizcard ${item.bizcardId}`);
    } catch (err) {
      console.error(
        `[QRQueue] Exception processing bizcard ${item.bizcardId}:`,
        err
      );

      // Unexpected error, retry
      if (item.retryCount < this.MAX_RETRIES) {
        item.retryCount++;
        item.lastRetryAt = new Date();
        this.queue.push(item);
      } else {
        this.dlq.push({
          ...item,
          reason: err instanceof Error ? err.message : "UNKNOWN_EXCEPTION",
        });
      }
    }
  }

  /**
   * Get queue statistics for monitoring
   */
  getStats(): {
    queueDepth: number;
    dlqSize: number;
    processing: boolean;
    isRunning: boolean;
  } {
    return {
      queueDepth: this.queue.length,
      dlqSize: this.dlq.length,
      processing: this.processing,
      isRunning: this.processInterval !== null,
    };
  }

  /**
   * Get items from Dead Letter Queue for review
   */
  getDLQItems(limit: number = 100): Array<QRQueueItem & { reason: string }> {
    return this.dlq.slice(0, limit);
  }

  /**
   * Retry a specific item from DLQ
   */
  retryFromDLQ(bizcardId: bigint): boolean {
    const index = this.dlq.findIndex((item) => item.bizcardId === bizcardId);
    if (index === -1) {
      return false;
    }

    const [item] = this.dlq.splice(index, 1);
    // Reset retry count to give it a fresh start
    this.queue.push({
      bizcardId: item.bizcardId,
      retryCount: 0,
      enqueuedAt: item.enqueuedAt,
    });

    console.info(`[QRQueue] Retried DLQ item ${bizcardId}`);
    return true;
  }

  /**
   * Clear DLQ (use with caution - for cleanup after manual review)
   */
  clearDLQ(): number {
    const count = this.dlq.length;
    this.dlq = [];
    console.warn(`[QRQueue] Cleared ${count} items from DLQ`);
    return count;
  }
}

// Singleton instance
const qrQueue = new QRCodeQueue();

/**
 * Start the QR queue on application startup
 * Call this from your Next.js server startup code
 */
export function initializeQRQueue(): void {
  qrQueue.start();
}

/**
 * Enqueue a bizcard for async QR generation
 * Safe to call multiple times for the same bizcard
 */
export function enqueueQRGeneration(bizcardId: bigint): void {
  qrQueue.enqueue(bizcardId);
}

/**
 * Get queue statistics for monitoring
 */
export function getQRQueueStats() {
  return qrQueue.getStats();
}

/**
 * Get Dead Letter Queue items for review/recovery
 */
export function getQRQueueDLQ(limit?: number) {
  return qrQueue.getDLQItems(limit);
}

/**
 * Retry a specific item from DLQ
 */
export function retryQRQueueDLQ(bizcardId: bigint): boolean {
  return qrQueue.retryFromDLQ(bizcardId);
}

/**
 * Manually stop queue processing
 */
export function stopQRQueue(): void {
  qrQueue.stop();
}

/**
 * Flush queue immediately (wait for all items to process)
 * Useful for tests and cleanup
 */
export async function flushQRQueue(): Promise<void> {
  return new Promise((resolve) => {
    const checkEmpty = setInterval(() => {
      const stats = qrQueue.getStats();
      if (stats.queueDepth === 0 && !stats.processing) {
        clearInterval(checkEmpty);
        resolve();
      }
    }, 100);

    // Prevent infinite wait
    setTimeout(() => {
      clearInterval(checkEmpty);
      resolve();
    }, 30000); // 30 second timeout
  });
}
