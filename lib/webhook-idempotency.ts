import { prisma } from "@/server/lib/prisma";

const MAX_EVENT_AGE_MS = 5 * 60 * 1000;

export type WebhookStatus = "processed" | "failed" | "ignored";

export interface WebhookEventInput {
  provider: string;
  eventId: string;
  eventType: string;
  idempotencyKey?: string | null;
  status?: WebhookStatus;
  metadata?: Record<string, unknown>;
}

export async function wasWebhookEventProcessed(provider: string, eventId: string): Promise<boolean> {
  const existing = await prisma.webhookEvent.findUnique({
    where: {
      provider_event_id: {
        provider,
        event_id: eventId,
      },
    },
    select: { id: true },
  });

  return Boolean(existing);
}

export async function recordWebhookEvent(input: WebhookEventInput): Promise<void> {
  await prisma.webhookEvent.create({
    data: {
      provider: input.provider,
      event_id: input.eventId,
      event_type: input.eventType,
      idempotency_key: input.idempotencyKey ?? null,
      status: input.status ?? "processed",
      metadata: JSON.stringify(input.metadata ?? {}),
    },
  });
}

export function isWebhookEventFresh(eventTimestampMs: number, nowMs: number = Date.now()): boolean {
  const age = nowMs - eventTimestampMs;
  return age >= 0 && age <= MAX_EVENT_AGE_MS;
}

export async function processWebhookOnce<T>(
  input: WebhookEventInput,
  processor: () => Promise<T>
): Promise<{ processed: boolean; result?: T; duplicate?: boolean }> {
  if (await wasWebhookEventProcessed(input.provider, input.eventId)) {
    return { processed: false, duplicate: true };
  }

  try {
    const result = await processor();
    await recordWebhookEvent({ ...input, status: "processed" });
    return { processed: true, result };
  } catch (error) {
    await recordWebhookEvent({
      ...input,
      status: "failed",
      metadata: {
        ...(input.metadata ?? {}),
        error: error instanceof Error ? error.message : "unknown",
      },
    }).catch(() => undefined);
    throw error;
  }
}

export async function cleanupOldWebhookEvents(days: number = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.webhookEvent.deleteMany({
    where: { created_at: { lt: cutoff } },
  });
  return result.count;
}
