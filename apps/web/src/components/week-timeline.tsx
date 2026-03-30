"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

const DEFAULT_DAY_START = 6;
const DEFAULT_DAY_END = 20;
const PX_PER_MINUTE = 1.2;

export type TimelineShift = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  site: { name: string; colorHex: string };
  assignee?: { id: string; name: string } | null;
};

export type PendingPickup = { id: string; shiftId: string; requesterId: string };

/** Consistent local display for schedule blocks */
export function formatShiftTimeRange(startsAt: Date | string, endsAt: Date | string): string {
  const start = typeof startsAt === "string" ? new Date(startsAt) : startsAt;
  const end = typeof endsAt === "string" ? new Date(endsAt) : endsAt;
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const timeFmt: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  const dateFmt: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  if (sameDay) {
    return `${start.toLocaleDateString(undefined, dateFmt)} · ${start.toLocaleTimeString(undefined, timeFmt)} – ${end.toLocaleTimeString(undefined, timeFmt)}`;
  }
  return `${start.toLocaleString(undefined, { ...dateFmt, ...timeFmt })} → ${end.toLocaleString(undefined, { ...dateFmt, ...timeFmt })}`;
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/** Visible portion of a shift on a given calendar day (local) */
function segmentForDay(
  s: TimelineShift,
  day: Date,
): { segStart: Date; segEnd: Date } | null {
  const sod = startOfDay(day);
  const eod = endOfDay(day);
  const start = toDate(s.startsAt);
  const end = toDate(s.endsAt);
  const segStart = start > sod ? start : sod;
  const segEnd = end < eod ? end : eod;
  if (segEnd.getTime() <= segStart.getTime()) return null;
  return { segStart, segEnd };
}

function minutesFromDayStart(day: Date, t: Date, startHour: number) {
  const base = new Date(day);
  base.setHours(startHour, 0, 0, 0);
  return (t.getTime() - base.getTime()) / 60000;
}

function deriveDayBounds(shifts: TimelineShift[]): { minHour: number; maxHour: number } {
  let minH = DEFAULT_DAY_START;
  let maxH = DEFAULT_DAY_END;
  for (const s of shifts) {
    const start = toDate(s.startsAt);
    const end = toDate(s.endsAt);
    minH = Math.min(minH, start.getHours() + start.getMinutes() / 60);
    maxH = Math.max(maxH, end.getHours() + end.getMinutes() / 60 + (end.getSeconds() > 0 || end.getMilliseconds() > 0 ? 0.01 : 0));
  }
  minH = Math.max(0, Math.floor(minH) - 1);
  maxH = Math.min(24, Math.ceil(maxH) + 1);
  if (maxH <= minH) {
    return { minHour: DEFAULT_DAY_START, maxHour: DEFAULT_DAY_END };
  }
  return { minHour: minH, maxHour: maxH };
}

export function WeekTimeline({
  weekStart,
  shifts,
  className,
  currentUserId,
  pendingPickups = [],
  onShiftClick,
}: {
  weekStart: Date;
  shifts: TimelineShift[];
  className?: string;
  currentUserId?: string | null;
  pendingPickups?: PendingPickup[];
  onShiftClick?: (shift: TimelineShift) => void;
}) {
  const { minHour, maxHour } = useMemo(() => deriveDayBounds(shifts), [shifts]);
  const totalMinutes = (maxHour - minHour) * 60;
  const gridHeight = totalMinutes * PX_PER_MINUTE;

  const days = useMemo(() => {
    const start = startOfDay(weekStart);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [weekStart]);

  const pendingByShift = useMemo(() => {
    const m = new Map<string, PendingPickup[]>();
    for (const p of pendingPickups) {
      const list = m.get(p.shiftId) ?? [];
      list.push(p);
      m.set(p.shiftId, list);
    }
    return m;
  }, [pendingPickups]);

  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="overflow-x-auto">
        <div className="flex min-w-[960px]">
          <div
            className="w-16 flex-shrink-0 border-r border-border pt-10 text-xs text-muted-foreground"
            style={{ minHeight: gridHeight + 40 }}
          >
            {Array.from({ length: maxHour - minHour }, (_, h) => (
              <div
                key={h}
                style={{ height: 60 * PX_PER_MINUTE }}
                className="border-t border-border/60 pr-2 text-right"
              >
                {minHour + h}:00
              </div>
            ))}
          </div>
          {days.map((day) => (
            <div key={day.toISOString()} className="relative min-w-0 flex-1 border-l border-border">
              <div className="sticky top-0 z-20 bg-card/95 px-2 py-2 text-center text-sm font-semibold backdrop-blur">
                {day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
              </div>
              <div className="relative" style={{ height: gridHeight }}>
                {Array.from({ length: maxHour - minHour }, (_, h) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-border/40"
                    style={{ top: h * 60 * PX_PER_MINUTE }}
                  />
                ))}
                {shifts.map((s) => {
                  const seg = segmentForDay(s, day);
                  if (!seg) return null;
                  const top = Math.max(
                    0,
                    minutesFromDayStart(day, seg.segStart, minHour) * PX_PER_MINUTE,
                  );
                  const startMin = minutesFromDayStart(day, seg.segStart, minHour);
                  const endMin = minutesFromDayStart(day, seg.segEnd, minHour);
                  const height = Math.max(28, (endMin - startMin) * PX_PER_MINUTE);

                  const assigneeId = s.assignee?.id;
                  const isOpen = !assigneeId;
                  const isMine = Boolean(currentUserId && assigneeId === currentUserId);
                  const pend = pendingByShift.get(s.id) ?? [];
                  const myPending = currentUserId ? pend.some((p) => p.requesterId === currentUserId) : false;
                  const otherPending = pend.some((p) => p.requesterId !== currentUserId);
                  const canInteract = Boolean(onShiftClick) && (isOpen || isMine);

                  const timeLine = `${toDate(seg.segStart).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })} – ${toDate(seg.segEnd).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}`;

                  return (
                    <button
                      key={`${s.id}-${day.toISOString()}`}
                      type="button"
                      disabled={!canInteract}
                      onClick={() => canInteract && onShiftClick?.(s)}
                      className={cn(
                        "absolute left-1 right-1 overflow-hidden rounded-md border px-2 py-1 text-left text-xs shadow-sm transition",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        canInteract && "cursor-pointer hover:opacity-95",
                        !canInteract && "cursor-default opacity-90",
                        isOpen && s.status === "PUBLISHED" && "border-dashed",
                        myPending && "ring-2 ring-amber-400/80",
                      )}
                      style={{
                        top,
                        height,
                        backgroundColor: `${s.site.colorHex}22`,
                        borderLeftWidth: 4,
                        borderLeftColor: s.site.colorHex,
                      }}
                      title={
                        canInteract
                          ? `${s.site.name} — ${timeLine} (click for actions)`
                          : `${s.site.name} — ${timeLine}`
                      }
                    >
                      <div className="font-semibold leading-tight" style={{ color: s.site.colorHex }}>
                        {s.site.name}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {isOpen ? (
                          s.status === "PUBLISHED" ? (
                            <span>Open slot</span>
                          ) : (
                            <span>Draft (not pickable)</span>
                          )
                        ) : (
                          <span>{s.assignee?.name ?? "Assigned"}</span>
                        )}
                        {myPending && (
                          <span className="ml-1 font-medium text-amber-700 dark:text-amber-300">
                            · Your request pending
                          </span>
                        )}
                        {!myPending && otherPending && (
                          <span className="ml-1 font-medium text-amber-700 dark:text-amber-300">
                            · Booking review pending
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-medium tabular-nums text-foreground">{timeLine}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
