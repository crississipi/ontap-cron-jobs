import { timingSafeEqual } from "crypto";

export function safeCompare(provided: string, secret: string): boolean {
  if (typeof provided !== "string" || typeof secret !== "string") return false;

  const providedBuffer = Buffer.from(provided, "utf8");
  const secretBuffer = Buffer.from(secret, "utf8");

  if (providedBuffer.length !== secretBuffer.length) return false;

  try {
    return timingSafeEqual(providedBuffer, secretBuffer);
  } catch {
    return false;
  }
}
