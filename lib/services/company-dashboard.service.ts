import type { Prisma as MainPrismaType } from "@prisma/client";
import type { Prisma as AnalyticsPrismaType } from "@prisma/client";

const AnalyticsPrisma = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../generated/analytics-client").Prisma;
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@prisma/client").Prisma;
  }
})();
const MainPrisma = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@prisma/client").Prisma;
  } catch (err) {
    return undefined as unknown as typeof import("@prisma/client").Prisma;
  }
})();
import { prisma } from "@/server/lib/prisma";
import { prismaAnalytics } from "@/server/lib/prisma-analytics";
import {
  DashboardErrorCode,
  createDashboardError,
} from "@/lib/errors/dashboard-errors";
import {
  type DailyBoundary,
  type FilterType,
  assertValidTimezone,
  buildDailyBoundaries,
  formatDateForChart,
  getCurrentWeekDateRange,
  getDateRange,
  validateDateRange,
} from "@/lib/utils/date-range";

export interface DashboardSummary {
  total_profile_views: number;
  total_employees: number;
  leads_generated: number;
  total_inquiries: number;
  comparisons: {
    profile_views: { value: number; percentage: number; direction: "up" | "down" | "same" };
    leads: { value: number; percentage: number; direction: "up" | "down" | "same" };
    inquiries: { value: number; percentage: number; direction: "up" | "down" | "same" };
  };
}

export interface TimeSeriesData {
  labels: string[];
  datasets: {
    profile_views: number[];
    leads: number[];
    inquiries: number[];
  };
}

export interface TopEmployee {
  employee_id: number;
  user_id: number;
  name: string;
  email: string;
  profile_image: string | null;
  profile_views: number;
  role: string;
}

export type RankingMetric = "profile_views" | "leads" | "inquiries";

export interface EmployeeRanking {
  rank: number;
  employee_id: number;
  user_id: number;
  name: string;
  email: string;
  profile_image: string | null;
  metric_value: number;
  role: string;
  trend: string;
}

export interface EmployeeRankingsResult {
  rankings: EmployeeRanking[];
  summary: {
    total_employees: number;
    metric: RankingMetric;
    period: {
      start: string;
      end: string;
    };
    average_value: number;
  };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isPoolTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2024"
  );
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

export class CompanyDashboardService {
  private readonly companyId: bigint;
  private readonly requestId: string;
  private readonly timezone: string;

  constructor(companyId: bigint, requestId: string, timezone: string = "UTC") {
    assertValidTimezone(timezone);
    this.companyId = companyId;
    this.requestId = requestId;
    this.timezone = timezone;
  }

  /**
   * Verify that the user is a company admin/manager member of the requested company.
   */
  async verifyCompanyAdmin(userId: string): Promise<void> {
    const parsed = Number(userId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw createDashboardError(
        DashboardErrorCode.UNAUTHORIZED_ACCESS,
        "Authentication required",
        401,
        this.requestId,
        { userId }
      );
    }

    const employee = await prisma.companyEmployee.findFirst({
      where: {
        company_id: this.companyId,
        user_id: BigInt(parsed),
        role: { in: ["admin", "manager"] },
        is_active: true,
      },
      select: { employee_id: true },
    });

    if (!employee) {
      throw createDashboardError(
        DashboardErrorCode.NOT_COMPANY_ADMIN,
        "User does not have admin permissions for this company",
        403,
        this.requestId,
        { companyId: this.companyId.toString(), userId }
      );
    }
  }

  /**
   * Get company dashboard summary with period-over-period comparisons.
   */
  async getDashboardSummary(
    filter: FilterType,
    customStartDate?: string,
    customEndDate?: string
  ): Promise<DashboardSummary> {
    const dateRange = getDateRange(filter, customStartDate, customEndDate, this.timezone);
    if (!validateDateRange(dateRange.start, dateRange.end, 90)) {
      throw createDashboardError(
        DashboardErrorCode.DATE_RANGE_TOO_LARGE,
        "Date range exceeds maximum of 90 days",
        400,
        this.requestId,
        { start: dateRange.start.toISOString(), end: dateRange.end.toISOString(), maxDays: 90 }
      );
    }

    const employeeIds = await this.getActiveEmployeeUserIds();
    if (employeeIds.length === 0) {
      return {
        total_profile_views: 0,
        total_employees: 0,
        leads_generated: 0,
        total_inquiries: 0,
        comparisons: {
          profile_views: { value: 0, percentage: 0, direction: "same" },
          leads: { value: 0, percentage: 0, direction: "same" },
          inquiries: { value: 0, percentage: 0, direction: "same" },
        },
      };
    }

    const currentPeriod = await this.getPeriodAnalytics(employeeIds, dateRange.start, dateRange.end);
    const previousPeriod = await this.getPeriodAnalytics(
      employeeIds,
      dateRange.previousStart,
      dateRange.previousEnd
    );

    const comparisons = {
      profile_views: this.calculateComparison(currentPeriod.profile_views, previousPeriod.profile_views),
      leads: this.calculateComparison(currentPeriod.leads, previousPeriod.leads),
      inquiries: this.calculateComparison(currentPeriod.inquiries, previousPeriod.inquiries),
    };

    return {
      total_profile_views: currentPeriod.profile_views,
      total_employees: employeeIds.length,
      leads_generated: currentPeriod.leads,
      total_inquiries: currentPeriod.inquiries,
      comparisons,
    };
  }

  /**
   * Get weekly time-series data (Monday to Sunday).
   */
  async getWeeklyTimeSeries(): Promise<TimeSeriesData> {
    const weekStarts = getCurrentWeekDateRange(this.timezone);
    const employeeIds = await this.getActiveEmployeeUserIds();

    const boundaries = buildDailyBoundaries(
      weekStarts[0],
      weekStarts[6],
      this.timezone,
      "EEE"
    );

    if (employeeIds.length === 0) {
      return {
        labels: boundaries.map((entry) => entry.label),
        datasets: {
          profile_views: new Array(boundaries.length).fill(0),
          leads: new Array(boundaries.length).fill(0),
          inquiries: new Array(boundaries.length).fill(0),
        },
      };
    }

    const metrics = await this.getMetricsForBoundaries(employeeIds, boundaries);

    return {
      labels: boundaries.map((entry) => entry.label),
      datasets: metrics,
    };
  }

  /**
   * Get the employee with most profile views for the current day.
   */
  async getTopEmployeeForToday(): Promise<TopEmployee | null> {
    const dateRange = getDateRange("today", undefined, undefined, this.timezone);
    const employees = await prisma.companyEmployee.findMany({
      where: {
        company_id: this.companyId,
        is_active: true,
      },
      include: {
        user: {
          select: {
            user_id: true,
            first_name: true,
            last_name: true,
            email: true,
            profile_url: true,
          },
        },
      },
    });

    if (employees.length === 0) {
      return null;
    }

    const userIds = employees.map((employee) => employee.user_id);

    let topRow: Array<{ user_id: bigint; profile_views: bigint }> = [];
    try {
      topRow = (await prismaAnalytics.$queryRaw(
        AnalyticsPrisma.sql`
          SELECT
            portfolio_owner_id AS user_id,
            COUNT(*) AS profile_views
          FROM PortfolioView
          WHERE portfolio_owner_id IN (${AnalyticsPrisma.join(userIds)})
            AND created_at >= ${dateRange.start}
            AND created_at <= ${dateRange.end}
          GROUP BY portfolio_owner_id
          ORDER BY profile_views DESC, portfolio_owner_id ASC
          LIMIT 1
        `
      )) as Array<{ user_id: bigint; profile_views: bigint }>;
    } catch (error) {
      if (!isPoolTimeoutError(error)) {
        throw error;
      }
      return null;
    }

    if (topRow.length === 0) {
      return null;
    }

    const best = topRow[0];
    const profileViews = toNumber(best.profile_views);
    if (profileViews <= 0) {
      return null;
    }

    const employee = employees.find((entry) => entry.user_id === best.user_id);
    if (!employee) {
      return null;
    }

    return {
      employee_id: Number(employee.employee_id),
      user_id: Number(employee.user.user_id),
      name: `${employee.user.first_name} ${employee.user.last_name}`.trim(),
      email: employee.user.email,
      profile_image: employee.user.profile_url,
      profile_views: profileViews,
      role: employee.role,
    };
  }

  /**
   * Get custom time-series data for a date range.
   */
  async getCustomTimeSeries(startDate: Date, endDate: Date): Promise<TimeSeriesData> {
    if (!validateDateRange(startDate, endDate, 90)) {
      const days = Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
      throw createDashboardError(
        DashboardErrorCode.DATE_RANGE_TOO_LARGE,
        "Date range exceeds maximum of 90 days",
        400,
        this.requestId,
        { requestedDays: days, maxDays: 90 }
      );
    }

    const employeeIds = await this.getActiveEmployeeUserIds();
    const boundaries = buildDailyBoundaries(startDate, endDate, this.timezone, "MMM dd");

    if (employeeIds.length === 0) {
      return {
        labels: boundaries.map((entry) => entry.label),
        datasets: {
          profile_views: new Array(boundaries.length).fill(0),
          leads: new Array(boundaries.length).fill(0),
          inquiries: new Array(boundaries.length).fill(0),
        },
      };
    }

    const metrics = await this.getMetricsForBoundaries(employeeIds, boundaries);

    return {
      labels: boundaries.map((entry) => entry.label),
      datasets: metrics,
    };
  }

  /**
   * Get employee rankings by selected metric.
   */
  async getEmployeeRankings(
    filter: FilterType,
    metric: RankingMetric,
    limit: number,
    customStartDate?: string,
    customEndDate?: string
  ): Promise<EmployeeRankingsResult> {
    const safeLimit = Math.min(20, Math.max(1, limit));
    const dateRange = getDateRange(filter, customStartDate, customEndDate, this.timezone);

    if (!validateDateRange(dateRange.start, dateRange.end, 90)) {
      throw createDashboardError(
        DashboardErrorCode.DATE_RANGE_TOO_LARGE,
        "Date range exceeds maximum of 90 days",
        400,
        this.requestId,
        { maxDays: 90 }
      );
    }

    const employees = await prisma.companyEmployee.findMany({
      where: {
        company_id: this.companyId,
        is_active: true,
      },
      include: {
        user: {
          select: {
            user_id: true,
            first_name: true,
            last_name: true,
            email: true,
            profile_url: true,
          },
        },
      },
    });

    if (employees.length === 0) {
      return {
        rankings: [],
        summary: {
          total_employees: 0,
          metric,
          period: {
            start: dateRange.start.toISOString(),
            end: dateRange.end.toISOString(),
          },
          average_value: 0,
        },
      };
    }

    const employeeIds = employees.map((employee) => employee.user_id);
    const currentCounts = await this.getMetricCountsByUser(metric, employeeIds, dateRange.start, dateRange.end);
    const previousCounts = await this.getMetricCountsByUser(
      metric,
      employeeIds,
      dateRange.previousStart,
      dateRange.previousEnd
    );

    const allRankings = employees.map((employee) => {
      const userKey = employee.user_id.toString();
      const current = currentCounts.get(userKey) ?? 0;
      const previous = previousCounts.get(userKey) ?? 0;
      const comparison = this.calculateComparison(current, previous);

      return {
        rank: 0,
        employee_id: Number(employee.employee_id),
        user_id: Number(employee.user_id),
        name: `${employee.user.first_name} ${employee.user.last_name}`.trim(),
        email: employee.user.email,
        profile_image: employee.user.profile_url,
        metric_value: current,
        role: employee.role,
        trend: this.toTrendString(comparison.direction, comparison.percentage),
      } as EmployeeRanking;
    });

    allRankings.sort((a, b) => {
      if (b.metric_value !== a.metric_value) return b.metric_value - a.metric_value;
      return a.name.localeCompare(b.name);
    });

    allRankings.forEach((row, index) => {
      row.rank = index + 1;
    });

    const selected = allRankings.slice(0, safeLimit);
    const average =
      allRankings.length === 0
        ? 0
        : roundTwo(allRankings.reduce((sum, row) => sum + row.metric_value, 0) / allRankings.length);

    return {
      rankings: selected,
      summary: {
        total_employees: employees.length,
        metric,
        period: {
          start: dateRange.start.toISOString(),
          end: dateRange.end.toISOString(),
        },
        average_value: average,
      },
    };
  }

  private async getPeriodAnalytics(
    employeeIds: bigint[],
    startDate: Date,
    endDate: Date
  ): Promise<{ profile_views: number; leads: number; inquiries: number }> {
    if (employeeIds.length === 0) {
      return { profile_views: 0, leads: 0, inquiries: 0 };
    }

    const [profileViews, leads, inquiries] = await Promise.all([
      this.safeAnalyticsCount(() =>
        prismaAnalytics.portfolioView.count({
          where: {
            portfolio_owner_id: { in: employeeIds },
            created_at: { gte: startDate, lte: endDate },
          },
        })
      ),
      this.safeAnalyticsCount(() =>
        prismaAnalytics.contactSave.count({
          where: {
            portfolio_owner_id: { in: employeeIds },
            created_at: { gte: startDate, lte: endDate },
          },
        })
      ),
      prisma.inquiry.count({
        where: {
          user_id: { in: employeeIds },
          created_at: { gte: startDate, lte: endDate },
        },
      }),
    ]);

    return {
      profile_views: profileViews,
      leads,
      inquiries,
    };
  }

  private calculateComparison(
    current: number,
    previous: number
  ): {
    value: number;
    percentage: number;
    direction: "up" | "down" | "same";
  } {
    const difference = current - previous;
    const percentage = previous === 0 ? (current > 0 ? 100 : 0) : (difference / previous) * 100;

    let direction: "up" | "down" | "same" = "same";
    if (difference > 0) direction = "up";
    if (difference < 0) direction = "down";

    return {
      value: difference,
      percentage: Math.abs(Math.round(percentage)),
      direction,
    };
  }

  private toTrendString(direction: "up" | "down" | "same", percentage: number): string {
    if (direction === "same") return "0%";
    if (direction === "up") return `+${percentage}%`;
    return `-${percentage}%`;
  }

  private async getActiveEmployeeUserIds(): Promise<bigint[]> {
    const employees = await prisma.companyEmployee.findMany({
      where: {
        company_id: this.companyId,
        is_active: true,
      },
      select: {
        user_id: true,
      },
    });

    return employees.map((employee) => employee.user_id);
  }

  private async safeAnalyticsCount(run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      if (isPoolTimeoutError(error)) {
        return 0;
      }
      throw error;
    }
  }

  private buildAnalyticsSeriesColumns(boundaries: DailyBoundary[]): AnalyticsPrismaType.Sql[] {
    return boundaries.map((boundary, index) =>
      AnalyticsPrisma.sql`SUM(CASE WHEN created_at >= ${boundary.dayStart} AND created_at < ${boundary.dayEndExclusive} THEN 1 ELSE 0 END) AS ${AnalyticsPrisma.raw(`d${index}`)}`
    );
  }

  private buildMainSeriesColumns(boundaries: DailyBoundary[]): MainPrismaType.Sql[] {
    return boundaries.map((boundary, index) =>
      MainPrisma.sql`SUM(CASE WHEN created_at >= ${boundary.dayStart} AND created_at < ${boundary.dayEndExclusive} THEN 1 ELSE 0 END) AS ${MainPrisma.raw(`d${index}`)}`
    );
  }

  private mapSeriesRowToNumbers(
    row: Record<string, unknown> | undefined,
    boundaries: DailyBoundary[]
  ): number[] {
    return boundaries.map((_, index) => {
      const key = `d${index}`;
      return toNumber(row?.[key] ?? 0);
    });
  }

  private async getMetricsForBoundaries(
    employeeIds: bigint[],
    boundaries: DailyBoundary[]
  ): Promise<{ profile_views: number[]; leads: number[]; inquiries: number[] }> {
    if (boundaries.length === 0) {
      return { profile_views: [], leads: [], inquiries: [] };
    }

    if (employeeIds.length === 0) {
      const zeros = new Array(boundaries.length).fill(0);
      return { profile_views: zeros, leads: [...zeros], inquiries: [...zeros] };
    }

    const overallStart = boundaries[0].dayStart;
    const overallEndExclusive = boundaries[boundaries.length - 1].dayEndExclusive;

    const analyticsColumns = this.buildAnalyticsSeriesColumns(boundaries);
    const inquiryColumns = this.buildMainSeriesColumns(boundaries);

    const [profileRows, leadRows, inquiryRows] = await Promise.all([
      this.safeAnalyticsSeriesQuery(() =>
        prismaAnalytics.$queryRaw(AnalyticsPrisma.sql`
            SELECT ${AnalyticsPrisma.join(analyticsColumns, ", ")}
            FROM PortfolioView
            WHERE portfolio_owner_id IN (${AnalyticsPrisma.join(employeeIds)})
              AND created_at >= ${overallStart}
              AND created_at < ${overallEndExclusive}
          `) as Promise<Array<Record<string, unknown>>>
      ),
      this.safeAnalyticsSeriesQuery(() =>
        prismaAnalytics.$queryRaw(AnalyticsPrisma.sql`
            SELECT ${AnalyticsPrisma.join(analyticsColumns, ", ")}
            FROM ContactSave
            WHERE portfolio_owner_id IN (${AnalyticsPrisma.join(employeeIds)})
              AND created_at >= ${overallStart}
              AND created_at < ${overallEndExclusive}
          `) as Promise<Array<Record<string, unknown>>>
      ),
      prisma.$queryRaw<Array<Record<string, unknown>>>(
        MainPrisma.sql`
          SELECT ${MainPrisma.join(inquiryColumns, ", ")}
          FROM Inquiry
          WHERE user_id IN (${MainPrisma.join(employeeIds)})
            AND created_at >= ${overallStart}
            AND created_at < ${overallEndExclusive}
        `
      ),
    ]);

    return {
      profile_views: this.mapSeriesRowToNumbers(profileRows[0], boundaries),
      leads: this.mapSeriesRowToNumbers(leadRows[0], boundaries),
      inquiries: this.mapSeriesRowToNumbers(inquiryRows[0], boundaries),
    };
  }

  private async safeAnalyticsSeriesQuery(
    run: () => Promise<Array<Record<string, unknown>>>
  ): Promise<Array<Record<string, unknown>>> {
    try {
      return await run();
    } catch (error) {
      if (isPoolTimeoutError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async getMetricCountsByUser(
    metric: RankingMetric,
    employeeIds: bigint[],
    startDate: Date,
    endDate: Date
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    if (employeeIds.length === 0) {
      return result;
    }

    if (metric === "profile_views") {
      const rows = await this.safeAnalyticsCountsByUser(() =>
        prismaAnalytics.$queryRaw(AnalyticsPrisma.sql`
              SELECT portfolio_owner_id AS user_id, COUNT(*) AS total
              FROM PortfolioView
              WHERE portfolio_owner_id IN (${AnalyticsPrisma.join(employeeIds)})
                AND created_at >= ${startDate}
                AND created_at <= ${endDate}
              GROUP BY portfolio_owner_id
            `) as Promise<Array<{ user_id: bigint; total: bigint }>>
      );

      rows.forEach((row) => {
        result.set(row.user_id.toString(), toNumber(row.total));
      });

      return result;
    }

    if (metric === "leads") {
      const rows = await this.safeAnalyticsCountsByUser(() =>
        prismaAnalytics.$queryRaw(AnalyticsPrisma.sql`
            SELECT portfolio_owner_id AS user_id, COUNT(*) AS total
            FROM ContactSave
            WHERE portfolio_owner_id IN (${AnalyticsPrisma.join(employeeIds)})
              AND created_at >= ${startDate}
              AND created_at <= ${endDate}
            GROUP BY portfolio_owner_id
          `) as Promise<Array<{ user_id: bigint; total: bigint }>>
      );

      rows.forEach((row) => {
        result.set(row.user_id.toString(), toNumber(row.total));
      });

      return result;
    }

    const rows = await prisma.inquiry.groupBy({
      by: ["user_id"],
      where: {
        user_id: { in: employeeIds },
        created_at: { gte: startDate, lte: endDate },
      },
      _count: {
        _all: true,
      },
    });

    rows.forEach((row) => {
      result.set(row.user_id.toString(), row._count._all);
    });

    return result;
  }

  private async safeAnalyticsCountsByUser(
    run: () => Promise<Array<{ user_id: bigint; total: bigint }>>
  ): Promise<Array<{ user_id: bigint; total: bigint }>> {
    try {
      return await run();
    } catch (error) {
      if (isPoolTimeoutError(error)) {
        return [];
      }
      throw error;
    }
  }

  getCurrentTimezone(): string {
    return this.timezone;
  }

  getChartLabel(date: Date, format: string): string {
    return formatDateForChart(date, format, this.timezone);
  }
}
