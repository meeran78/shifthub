"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

const DEFAULT_DAY_START = 6;
const DEFAULT_DAY_END = 20;
/** Calendar column spans full local day (0:00–24:00); hours outside [visibleStart, visibleEnd) are visually blocked. */
const HOURS_IN_DAY = 24;
const PX_PER_MINUTE = 1.2;
/** Visual grid every 15 minutes */
const SUBGRID_MINUTES = 15;

export type TimelineShift = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  site: { name: string; colorHex: string };
  assignee?: { id: string; name: string } | null;
};

export type SlotPick = { slotStart: Date; slotEnd: Date };

export type PendingPickup = { id: string; shiftId: string; requesterId: string };

export type SlotStepMinutes = 15 | 30;

/** Split a day segment into pickable slots (15 or 30 min); merges trailing &lt;15 min into previous */
export function iterSlotSegments(
  segStart: Date,
  segEnd: Date,
  stepMinutes: SlotStepMinutes,
): SlotPick[] {
  const totalMin = (segEnd.getTime() - segStart.getTime()) / 60000;
  if (totalMin <= 0) return [];
  if (totalMin < 15) {
    return [{ slotStart: new Date(segStart), slotEnd: new Date(segEnd) }];
  }
  const slots: SlotPick[] = [];
  let t = new Date(segStart);
  while (t < segEnd) {
    const next = new Date(t);
    next.setMinutes(next.getMinutes() + stepMinutes);
    const end = next > segEnd ? new Date(segEnd) : next;
    if (end > t) {
      slots.push({ slotStart: new Date(t), slotEnd: end });
    }
    t = next;
    if (t >= segEnd) break;
  }
  if (slots.length >= 2) {
    const last = slots[slots.length - 1]!;
    const dur = (last.slotEnd.getTime() - last.slotStart.getTime()) / 60000;
    if (dur < 15) {
      slots[slots.length - 2]!.slotEnd = last.slotEnd;
      slots.pop();
    }
  }
  return slots.length > 0 ? slots : [{ slotStart: new Date(segStart), slotEnd: new Date(segEnd) }];
}

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

/** Visible portion of a shift on a given calendar day (local), before visible-hour window clip */
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

/** Intersect [segStart, segEnd] with the fixed daily visible window [startHour, endHour] */
function clipSegmentToVisibleHours(
  seg: { segStart: Date; segEnd: Date },
  day: Date,
  startHour: number,
  endHour: number,
): { segStart: Date; segEnd: Date } | null {
  const sod = startOfDay(day);
  const wStart = new Date(sod);
  wStart.setHours(startHour, 0, 0, 0);
  const wEnd = new Date(sod);
  wEnd.setHours(endHour, 0, 0, 0);
  if (endHour <= startHour || wEnd.getTime() <= wStart.getTime()) return null;
  const s = Math.max(seg.segStart.getTime(), wStart.getTime());
  const e = Math.min(seg.segEnd.getTime(), wEnd.getTime());
  if (e <= s) return null;
  return { segStart: new Date(s), segEnd: new Date(e) };
}

/** Earliest start and latest end among segments actually shown in the visible window */
function dayScheduleSpan(
  day: Date,
  shifts: TimelineShift[],
  startHour: number,
  endHour: number,
): { start: Date; end: Date } | null {
  let minStart: Date | null = null;
  let maxEnd: Date | null = null;
  for (const s of shifts) {
    const raw = segmentForDay(s, day);
    if (!raw) continue;
    const seg = clipSegmentToVisibleHours(raw, day, startHour, endHour);
    if (!seg) continue;
    if (!minStart || seg.segStart.getTime() < minStart.getTime()) minStart = new Date(seg.segStart);
    if (!maxEnd || seg.segEnd.getTime() > maxEnd.getTime()) maxEnd = new Date(seg.segEnd);
  }
  if (!minStart || !maxEnd) return null;
  return { start: minStart, end: maxEnd };
}

function formatClock(d: Date) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Minutes from local midnight for `day` (same calendar day as `t` for clipped segments). */
function minutesFromMidnight(day: Date, t: Date) {
  const sod = startOfDay(day);
  return (t.getTime() - sod.getTime()) / 60000;
}

/** Optional: expand grid from shift times (can stretch to full day for long shifts). Default: fixed window. */
function deriveDayBoundsFromShifts(shifts: TimelineShift[]): { minHour: number; maxHour: number } {
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

function normalizeVisibleHours(
  start: number | undefined,
  end: number | undefined,
): { minHour: number; maxHour: number } {
  let minH = Math.floor(start ?? DEFAULT_DAY_START);
  let maxH = Math.floor(end ?? DEFAULT_DAY_END);
  minH = Math.max(0, Math.min(23, minH));
  maxH = Math.max(1, Math.min(24, maxH));
  if (maxH <= minH) {
    maxH = Math.min(24, minH + 1);
  }
  return { minHour: minH, maxHour: maxH };
}

export function WeekTimeline({
  weekStart,
  shifts,
  className,
  currentUserId,
  pendingPickups = [],
  slotStepMinutes = 15,
  onSlotClick,
  onShiftClick,
  /** Top of the grid (hour 0–23). Shifts are clipped to this window instead of filling the full day. */
  visibleStartHour = DEFAULT_DAY_START,
  /** Bottom of the grid (hour 1–24, must be &gt; visibleStartHour). */
  visibleEndHour = DEFAULT_DAY_END,
  /** If true, min/max hours follow shift data (old behavior; long shifts expand the calendar). */
  deriveBoundsFromShifts = false,
}: {
  weekStart: Date;
  shifts: TimelineShift[];
  className?: string;
  currentUserId?: string | null;
  pendingPickups?: PendingPickup[];
  /** Pickable slot size (15 or 30 minutes per tile) */
  slotStepMinutes?: SlotStepMinutes;
  /** Preferred: click passes exact slot window (use for pickup / swap context) */
  onSlotClick?: (shift: TimelineShift, slot: SlotPick) => void;
  /** Fallback when onSlotClick not provided */
  onShiftClick?: (shift: TimelineShift) => void;
  visibleStartHour?: number;
  visibleEndHour?: number;
  deriveBoundsFromShifts?: boolean;
}) {
  const { minHour, maxHour } = useMemo(() => {
    if (deriveBoundsFromShifts) {
      return deriveDayBoundsFromShifts(shifts);
    }
    return normalizeVisibleHours(visibleStartHour, visibleEndHour);
  }, [deriveBoundsFromShifts, shifts, visibleStartHour, visibleEndHour]);
  const fullDayMinutes = HOURS_IN_DAY * 60;
  const gridHeight = fullDayMinutes * PX_PER_MINUTE;
  const blockedTopPx = minHour * 60 * PX_PER_MINUTE;
  const blockedBottomPx = (HOURS_IN_DAY - maxHour) * 60 * PX_PER_MINUTE;

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

  const handleActivate = (s: TimelineShift, slot: SlotPick) => {
    if (onSlotClick) {
      onSlotClick(s, slot);
    } else {
      onShiftClick?.(s);
    }
  };

  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="max-h-[min(80vh,1200px)] overflow-auto">
        <div className="flex min-w-[960px]">
          <div
            className="w-16 flex-shrink-0 border-r border-border text-xs text-muted-foreground"
            style={{ minHeight: gridHeight + 52 }}
          >
            <div className="sticky top-0 z-20 space-y-0.5 bg-card/95 px-1 py-2 text-center backdrop-blur">
              <div className="text-[10px] font-semibold text-foreground">Time</div>
              <div className="tabular-nums text-[10px] font-medium leading-tight">
                Open {minHour}:00–{maxHour}:00
              </div>
            </div>
            {Array.from({ length: HOURS_IN_DAY }, (_, h) => (
              <div
                key={h}
                style={{ height: 60 * PX_PER_MINUTE }}
                className="border-t border-border/60 pr-2 text-right"
              >
                {h}:00
              </div>
            ))}
          </div>
          {days.map((day) => {
            const daySpan = dayScheduleSpan(day, shifts, minHour, maxHour);
            return (
            <div key={day.toISOString()} className="relative min-w-0 flex-1 border-l border-border">
              <div className="sticky top-0 z-20 space-y-0.5 bg-card/95 px-2 py-2 text-center backdrop-blur">
                <div className="text-sm font-semibold">
                  {day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                </div>
                <div className="text-xs font-medium tabular-nums text-muted-foreground">
                  {daySpan ? (
                    <>
                      {formatClock(daySpan.start)} – {formatClock(daySpan.end)}
                    </>
                  ) : (
                    <span className="text-muted-foreground/80">No shifts</span>
                  )}
                </div>
              </div>
              <div className="relative isolate" style={{ height: gridHeight }}>
                {/* Blocked: before visible start / after visible end (each local day) */}
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 z-[5] border-b border-dashed border-border/50 bg-muted/50"
                  style={{ height: blockedTopPx }}
                  aria-hidden
                />
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] border-t border-dashed border-border/50 bg-muted/50"
                  style={{ height: blockedBottomPx }}
                  aria-hidden
                />
                {/* Hour lines — full day */}
                {Array.from({ length: HOURS_IN_DAY }, (_, h) => (
                  <div
                    key={`h-${h}`}
                    className="pointer-events-none absolute left-0 right-0 border-t border-border/40"
                    style={{ top: h * 60 * PX_PER_MINUTE }}
                  />
                ))}
                {/* 15-minute sub-grid */}
                {Array.from({ length: Math.ceil(fullDayMinutes / SUBGRID_MINUTES) }, (_, i) => {
                  const m = i * SUBGRID_MINUTES;
                  if (m === 0 || m % 60 === 0) return null;
                  return (
                    <div
                      key={`sub-${i}`}
                      className="pointer-events-none absolute left-0 right-0 border-t border-border/20"
                      style={{ top: m * PX_PER_MINUTE }}
                    />
                  );
                })}
                {shifts.flatMap((s) => {
                  const raw = segmentForDay(s, day);
                  if (!raw) return [];
                  const seg = clipSegmentToVisibleHours(raw, day, minHour, maxHour);
                  if (!seg) return [];
                  const slots = iterSlotSegments(seg.segStart, seg.segEnd, slotStepMinutes);

                  const assigneeId = s.assignee?.id;
                  const isOpen = !assigneeId;
                  const isMine = Boolean(currentUserId && assigneeId === currentUserId);
                  const pend = pendingByShift.get(s.id) ?? [];
                  const myPending = currentUserId ? pend.some((p) => p.requesterId === currentUserId) : false;
                  const otherPending = pend.some((p) => p.requesterId !== currentUserId);

                  const canPickOpen = isOpen && s.status === "PUBLISHED";
                  const canSwapMine = isMine;
                  const hasHandler = Boolean(onSlotClick || onShiftClick);
                  const canInteract = hasHandler && (canPickOpen || canSwapMine);

                  return slots.map((slot, slotIdx) => {
                    const startMin = minutesFromMidnight(day, slot.slotStart);
                    const endMin = minutesFromMidnight(day, slot.slotEnd);
                    const top = Math.max(0, startMin * PX_PER_MINUTE);
                    const height = Math.max(28, (endMin - startMin) * PX_PER_MINUTE);

                    const timeLine = `${toDate(slot.slotStart).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })} – ${toDate(slot.slotEnd).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}`;

                    // Stacking: later tiles draw above; interactive above non-interactive (avoid disabled-button quirks)
                    const stackKey = Math.round(top * 100) + slotIdx;
                    const z = canInteract ? 40 + (stackKey % 50) : 10 + (stackKey % 20);

                    return (
                      <button
                        key={`${s.id}-${day.toISOString()}-${slotIdx}`}
                        type="button"
                        aria-disabled={!canInteract}
                        tabIndex={canInteract ? 0 : -1}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canInteract) return;
                          handleActivate(s, slot);
                        }}
                        className={cn(
                          "absolute left-1 right-1 overflow-hidden rounded border px-1.5 py-0.5 text-left text-[10px] shadow-sm transition",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          canInteract && "cursor-pointer hover:opacity-95 active:opacity-100",
                          !canInteract && "cursor-default opacity-80",
                          !canInteract && "pointer-events-none",
                          canPickOpen && s.status === "PUBLISHED" && "border-dashed",
                          myPending && "ring-2 ring-amber-400/80",
                        )}
                        style={{
                          top,
                          height,
                          zIndex: z,
                          backgroundColor: `${s.site.colorHex}22`,
                          borderLeftWidth: 3,
                          borderLeftColor: s.site.colorHex,
                        }}
                        title={
                          canInteract
                            ? canPickOpen
                              ? `${s.site.name} — ${timeLine} (click to book)`
                              : `${s.site.name} — ${timeLine} (click)`
                            : `${s.site.name} — ${timeLine}`
                        }
                      >
                        <div className="truncate font-semibold leading-tight" style={{ color: s.site.colorHex }}>
                          {s.site.name}
                        </div>
                        <div className="truncate text-[9px] text-muted-foreground">
                          {canPickOpen ? (
                            <span>Open</span>
                          ) : isMine ? (
                            <span>You</span>
                          ) : (
                            <span>{s.assignee?.name ?? "—"}</span>
                          )}
                          {myPending && (
                            <span className="ml-0.5 font-medium text-amber-700 dark:text-amber-300">· Pending</span>
                          )}
                          {!myPending && otherPending && (
                            <span className="ml-0.5 font-medium text-amber-700 dark:text-amber-300">· Review</span>
                          )}
                        </div>
                        <div className="tabular-nums text-[9px] font-medium text-foreground">{timeLine}</div>
                      </button>
                    );
                  });
                })}
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
