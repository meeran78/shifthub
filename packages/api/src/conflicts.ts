import type { prisma as prismaClient } from "@shifthub/db";

type Prisma = typeof prismaClient;

export type ConflictShift = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  siteId: string;
  site: { id: string; name: string; colorHex: string };
  assigneeId: string | null;
  assignee: { id: string; name: string; role: string } | null;
};

export type ConflictReport = {
  /** Other shifts at the same site whose time window overlaps. */
  siteConflicts: ConflictShift[];
  /** Other shifts assigned to the same person whose time window overlaps (across all sites). */
  assigneeConflicts: ConflictShift[];
};

export type FindShiftConflictsInput = {
  startsAt: Date;
  endsAt: Date;
  /** Restrict site overlap check to this site (skipped when omitted). */
  siteId?: string;
  /** Restrict assignee overlap check to this user (skipped when omitted/null). */
  assigneeId?: string | null;
  /** Shift to ignore (e.g. when updating an existing shift). */
  excludeShiftId?: string;
};

const SHIFT_INCLUDE = {
  site: { select: { id: true, name: true, colorHex: true } },
  assignee: { select: { id: true, name: true, role: true } },
} as const;

/**
 * Find shifts that overlap [startsAt, endsAt) for the same site and/or the same assignee.
 *
 * Used everywhere we (or AI) want to validate that a new/edited shift won't double-book
 * either the location or the person — including across sites for the assignee check.
 */
export async function findShiftConflicts(
  prisma: Prisma,
  input: FindShiftConflictsInput,
): Promise<ConflictReport> {
  const { startsAt, endsAt, siteId, assigneeId, excludeShiftId } = input;
  if (endsAt.getTime() <= startsAt.getTime()) {
    return { siteConflicts: [], assigneeConflicts: [] };
  }

  const overlap = {
    AND: [{ startsAt: { lt: endsAt } }, { endsAt: { gt: startsAt } }],
  };
  const exclude = excludeShiftId ? { id: { not: excludeShiftId } } : {};

  const [siteConflicts, assigneeConflicts] = await Promise.all([
    siteId
      ? prisma.shift.findMany({
          where: { siteId, ...exclude, ...overlap },
          include: SHIFT_INCLUDE,
          orderBy: { startsAt: "asc" },
        })
      : Promise.resolve([] as Awaited<ReturnType<typeof prisma.shift.findMany>>),
    assigneeId
      ? prisma.shift.findMany({
          where: { assigneeId, ...exclude, ...overlap },
          include: SHIFT_INCLUDE,
          orderBy: { startsAt: "asc" },
        })
      : Promise.resolve([] as Awaited<ReturnType<typeof prisma.shift.findMany>>),
  ]);

  return {
    siteConflicts: siteConflicts as unknown as ConflictShift[],
    assigneeConflicts: assigneeConflicts as unknown as ConflictShift[],
  };
}

export function hasConflicts(report: ConflictReport): boolean {
  return report.siteConflicts.length > 0 || report.assigneeConflicts.length > 0;
}

export function summarizeConflict(report: ConflictReport): string {
  const parts: string[] = [];
  if (report.siteConflicts.length > 0) {
    parts.push(`${report.siteConflicts.length} site overlap(s)`);
  }
  if (report.assigneeConflicts.length > 0) {
    parts.push(`${report.assigneeConflicts.length} assignee overlap(s) across sites`);
  }
  return parts.length > 0 ? parts.join(", ") : "no conflicts";
}
