import { Prisma } from "@prisma/client";
import type { Prisma as PrismaTypes } from "@prisma/client";

export type JsonFieldInput =
  | PrismaTypes.InputJsonValue
  | typeof PrismaTypes.JsonNull
  | typeof PrismaTypes.DbNull;

/** Serialize for plain string columns or legacy string storage. */
export function toJsonString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Write value to a Prisma `Json` column. */
export function toJsonField(value: unknown): JsonFieldInput {
  if (value === undefined || value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export function parseJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(
  raw: string | PrismaTypes.JsonValue | null | undefined,
): T | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as T;
  }
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseJsonArray<T = unknown>(
  raw: string | PrismaTypes.JsonValue | null | undefined,
): T[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
