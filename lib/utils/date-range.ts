export type FilterType = "today" | "last_7_days" | "last_30_days" | "this_week" | "this_month" | "last_month" | "custom";

export interface DateRange {
  start: Date;
  end: Date;
  previousStart: Date;
  previousEnd: Date;
  label: string;
}

export interface TimeSeriesDataPoint {
  date: string;
  profile_views: number;
  leads: number;
  inquiries: number;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
}

interface ZonedDateTimeParts extends ZonedDateParts {
  hour: number;
  minute: number;
  second: number;
}

export interface DailyBoundary {
  isoDate: string;
  dayStart: Date;
  dayEndExclusive: Date;
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const zonedDateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedDateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const cacheKey = `datetime:${timezone}`;
  const existing = zonedDateTimeFormatterCache.get(cacheKey);
  if (existing) return existing;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  zonedDateTimeFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toIsoDate(parts: ZonedDateParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function parseIsoDateParts(input: string): ZonedDateParts | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const [yearRaw, monthRaw, dayRaw] = input.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function compareDateParts(a: ZonedDateParts, b: ZonedDateParts): number {
  const aValue = Date.UTC(a.year, a.month - 1, a.day);
  const bValue = Date.UTC(b.year, b.month - 1, b.day);
  if (aValue === bValue) return 0;
  return aValue < bValue ? -1 : 1;
}

function addDays(parts: ZonedDateParts, delta: number): ZonedDateParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function getDateSpanInclusive(start: ZonedDateParts, end: ZonedDateParts): number {
  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);
  return Math.floor((endUtc - startUtc) / DAY_MS) + 1;
}

function getZonedDateTimeParts(date: Date, timezone: string): ZonedDateTimeParts {
  const parts = getZonedDateTimeFormatter(timezone).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function getTimeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = getZonedDateTimeParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(
  date: ZonedDateParts,
  time: { hour: number; minute: number; second: number; millisecond: number },
  timezone: string
): Date {
  const utcGuess = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    time.hour,
    time.minute,
    time.second,
    time.millisecond
  );

  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timezone);
  let adjusted = utcGuess - firstOffset;

  // One extra pass handles daylight-saving transitions where offsets change.
  const secondOffset = getTimeZoneOffsetMs(new Date(adjusted), timezone);
  if (firstOffset !== secondOffset) {
    adjusted = utcGuess - secondOffset;
  }

  return new Date(adjusted);
}

function startOfZonedDay(parts: ZonedDateParts, timezone: string): Date {
  return zonedDateTimeToUtc(parts, { hour: 0, minute: 0, second: 0, millisecond: 0 }, timezone);
}

function endOfZonedDay(parts: ZonedDateParts, timezone: string): Date {
  const nextDay = addDays(parts, 1);
  const nextDayStart = startOfZonedDay(nextDay, timezone);
  return new Date(nextDayStart.getTime() - 1);
}

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

export function getZonedDateParts(date: Date, timezone: string = "UTC"): ZonedDateParts {
  assertValidTimezone(timezone);
  const parts = getZonedDateTimeParts(date, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * Generate date ranges based on filter type, resolving all boundaries in the requested timezone.
 * Returned dates are UTC instants that can be used directly in database queries.
 */
function startOfMonth(parts: ZonedDateParts): ZonedDateParts {
  return { year: parts.year, month: parts.month, day: 1 };
}

function endOfMonth(parts: ZonedDateParts): ZonedDateParts {
  const nextMonth = parts.month === 12
    ? { year: parts.year + 1, month: 1, day: 1 }
    : { year: parts.year, month: parts.month + 1, day: 1 };
  return addDays(nextMonth, -1);
}

function previousMonthStart(parts: ZonedDateParts): ZonedDateParts {
  if (parts.month === 1) {
    return { year: parts.year - 1, month: 12, day: 1 };
  }
  return { year: parts.year, month: parts.month - 1, day: 1 };
}

export function getDateRange(
  filter: FilterType,
  customStartDate?: string,
  customEndDate?: string,
  timezone: string = "UTC"
): DateRange {
  assertValidTimezone(timezone);

  const today = getZonedDateParts(new Date(), timezone);

  let startParts: ZonedDateParts;
  let endParts: ZonedDateParts;
  let previousStartParts: ZonedDateParts;
  let previousEndParts: ZonedDateParts;
  let label: string;

  switch (filter) {
    case "today": {
      startParts = today;
      endParts = today;
      previousStartParts = addDays(startParts, -1);
      previousEndParts = addDays(endParts, -1);
      label = "Today";
      break;
    }
    case "last_7_days": {
      startParts = addDays(today, -6);
      endParts = today;
      previousStartParts = addDays(startParts, -7);
      previousEndParts = addDays(endParts, -7);
      label = "Last 7 Days";
      break;
    }
    case "last_30_days": {
      startParts = addDays(today, -29);
      endParts = today;
      previousStartParts = addDays(startParts, -30);
      previousEndParts = addDays(endParts, -30);
      label = "Last 30 Days";
      break;
    }
    case "this_week": {
      const dayOfWeek = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      startParts = addDays(today, -daysSinceMonday);
      endParts = today;
      const spanDays = getDateSpanInclusive(startParts, endParts);
      previousEndParts = addDays(startParts, -1);
      previousStartParts = addDays(previousEndParts, -(spanDays - 1));
      label = "This Week";
      break;
    }
    case "this_month": {
      startParts = startOfMonth(today);
      endParts = today;
      const spanDays = getDateSpanInclusive(startParts, endParts);
      previousEndParts = addDays(startParts, -1);
      previousStartParts = addDays(previousEndParts, -(spanDays - 1));
      label = "This Month";
      break;
    }
    case "last_month": {
      const prevStart = previousMonthStart(today);
      startParts = prevStart;
      endParts = endOfMonth(prevStart);
      const spanDays = getDateSpanInclusive(startParts, endParts);
      previousEndParts = addDays(startParts, -1);
      previousStartParts = addDays(previousEndParts, -(spanDays - 1));
      label = "Last Month";
      break;
    }
    case "custom": {
      if (!customStartDate || !customEndDate) {
        throw new Error("Custom date range requires start and end dates");
      }

      const parsedStart = parseIsoDateParts(customStartDate);
      const parsedEnd = parseIsoDateParts(customEndDate);
      if (!parsedStart || !parsedEnd) {
        throw new Error("Custom date range must use YYYY-MM-DD format");
      }
      if (compareDateParts(parsedStart, parsedEnd) > 0) {
        throw new Error("Custom date range start must be before or equal to end");
      }

      const spanDays = getDateSpanInclusive(parsedStart, parsedEnd);
      const previousEnd = addDays(parsedStart, -1);
      const previousStart = addDays(previousEnd, -(spanDays - 1));

      startParts = parsedStart;
      endParts = parsedEnd;
      previousStartParts = previousStart;
      previousEndParts = previousEnd;
      label = `${customStartDate} to ${customEndDate}`;
      break;
    }
    default:
      throw new Error(`Invalid filter type: ${filter}`);
  }

  return {
    start: startOfZonedDay(startParts, timezone),
    end: endOfZonedDay(endParts, timezone),
    previousStart: startOfZonedDay(previousStartParts, timezone),
    previousEnd: endOfZonedDay(previousEndParts, timezone),
    label,
  };
}

/**
 * Generate day-start timestamps for the current week (Monday to Sunday) in the given timezone.
 */
export function getCurrentWeekDateRange(timezone: string = "UTC"): Date[] {
  assertValidTimezone(timezone);

  const today = getZonedDateParts(new Date(), timezone);
  const dayOfWeek = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const weekStart = addDays(today, -daysSinceMonday);

  const dates: Date[] = [];
  for (let i = 0; i < 7; i += 1) {
    dates.push(startOfZonedDay(addDays(weekStart, i), timezone));
  }

  return dates;
}

/**
 * Build daily boundaries for time-series aggregation between start and end (inclusive).
 */
export function buildDailyBoundaries(
  start: Date,
  end: Date,
  timezone: string = "UTC",
  labelFormat: string = "MMM dd"
): DailyBoundary[] {
  assertValidTimezone(timezone);

  const startParts = getZonedDateParts(start, timezone);
  const endParts = getZonedDateParts(end, timezone);

  if (compareDateParts(startParts, endParts) > 0) {
    return [];
  }

  const boundaries: DailyBoundary[] = [];
  let cursor = startParts;

  while (compareDateParts(cursor, endParts) <= 0) {
    const nextDay = addDays(cursor, 1);
    const dayStart = startOfZonedDay(cursor, timezone);
    const dayEndExclusive = startOfZonedDay(nextDay, timezone);

    boundaries.push({
      isoDate: toIsoDate(cursor),
      dayStart,
      dayEndExclusive,
      label: formatDateForChart(dayStart, labelFormat, timezone),
    });

    cursor = nextDay;
  }

  return boundaries;
}

/**
 * Format a date for chart labels.
 * Supported patterns: EEE, MMM dd, yyyy-MM-dd.
 */
export function formatDateForChart(date: Date, formatStr: string = "EEE", timezone: string = "UTC"): string {
  assertValidTimezone(timezone);

  if (formatStr === "EEE") {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(date);
  }

  if (formatStr === "MMM dd") {
    const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: timezone }).format(date);
    const day = new Intl.DateTimeFormat("en-US", { day: "2-digit", timeZone: timezone }).format(date);
    return `${month} ${day}`;
  }

  if (formatStr === "yyyy-MM-dd") {
    return toIsoDate(getZonedDateParts(date, timezone));
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: timezone,
  }).format(date);
}

/**
 * Validate date range and enforce a max span in days.
 */
export function validateDateRange(start: Date, end: Date, maxDays: number = 90): boolean {
  if (start.getTime() > end.getTime()) return false;
  const spanDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
  return spanDays <= maxDays;
}
