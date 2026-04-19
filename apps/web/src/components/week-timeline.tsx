"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const DEFAULT_DAY_START = 6;
const DEFAULT_DAY_END = 20;
/** Calendar column spans a full local day (0:00–24:00); hours outside the per-day window are visually blocked. */
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

export type PendingPickup = {
  id: string;
  shiftId: string;
  requesterId: string;
  requester: { name: string };
};

export type SlotStepMinutes = 15 | 30;

/** Per-day visible window, indexed 0..6 from `weekStart` (Monday-first if weekStart is a Monday). */
export type DayWindow = { start: number; end: number };

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

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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

/** Intersect [segStart, segEnd] with the visible window [startHour, endHour] for `day`. */
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

function clampHour(h: number, min: number, max: number) {
  if (Number.isNaN(h)) return min;
  return Math.max(min, Math.min(max, Math.floor(h)));
}

function normalizeWindow(start: number | undefined, end: number | undefined): DayWindow {
  let s = clampHour(start ?? DEFAULT_DAY_START, 0, 23);
  let e = clampHour(end ?? DEFAULT_DAY_END, 1, 24);
  if (e <= s) e = Math.min(24, s + 1);
  return { start: s, end: e };
}

function snapMinutes(minutes: number, step: number) {
  return Math.round(minutes / step) * step;
}

function dateAtMinutes(day: Date, minutes: number) {
  const d = startOfDay(day);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

function shiftCoversDay(shift: TimelineShift, day: Date) {
  return Boolean(segmentForDay(shift, day));
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
  /** Per-weekday windows (length 7, indexed from `weekStart`). Overrides visibleStart/EndHour when present. */
  visibleHoursByDay,
  /** Optional: override "now" (testing/demo). When unset, ticks every minute. */
  currentTime,
  /** Show a horizontal indicator on today's column at the current time. Default: true. */
  showNowLine = true,
  /** Admin editing: enables drag-to-create on background and resize handles on tiles. */
  canEdit = false,
  /** Site picker context for drag-create. Required when `onCreate` is provided. */
  defaultCreateSiteId,
  /** Drag-create handler. Called once when the user releases a background drag. */
  onCreate,
  /** Resize handler — fires on release after dragging a tile's bottom grip. */
  onResize,
  /** Number of day columns to render starting at `weekStart`. Defaults to 7 (week view). Use 1 for day view. */
  daysToShow = 7,
}: {
  weekStart: Date;
  shifts: TimelineShift[];
  className?: string;
  currentUserId?: string | null;
  pendingPickups?: PendingPickup[];
  slotStepMinutes?: SlotStepMinutes;
  onSlotClick?: (shift: TimelineShift, slot: SlotPick) => void;
  onShiftClick?: (shift: TimelineShift) => void;
  visibleStartHour?: number;
  visibleEndHour?: number;
  visibleHoursByDay?: DayWindow[];
  currentTime?: Date;
  showNowLine?: boolean;
  canEdit?: boolean;
  defaultCreateSiteId?: string;
  onCreate?: (input: { day: Date; startsAt: Date; endsAt: Date; siteId?: string }) => void;
  onResize?: (input: { shift: TimelineShift; endsAt: Date }) => void;
  daysToShow?: number;
}) {
  const fullDayMinutes = HOURS_IN_DAY * 60;
  const gridHeight = fullDayMinutes * PX_PER_MINUTE;
  const dayCount = Math.max(1, Math.min(7, Math.floor(daysToShow)));

  const days = useMemo(() => {
    const start = startOfDay(weekStart);
    return Array.from({ length: dayCount }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [weekStart, dayCount]);

  const dayWindows = useMemo<DayWindow[]>(() => {
    return days.map((_, i) => {
      const override = visibleHoursByDay?.[i];
      if (override) return normalizeWindow(override.start, override.end);
      return normalizeWindow(visibleStartHour, visibleEndHour);
    });
  }, [days, visibleHoursByDay, visibleStartHour, visibleEndHour]);

  const pendingByShift = useMemo(() => {
    const m = new Map<string, PendingPickup[]>();
    for (const p of pendingPickups) {
      const list = m.get(p.shiftId) ?? [];
      list.push(p);
      m.set(p.shiftId, list);
    }
    return m;
  }, [pendingPickups]);

  // self-ticking "now" so the indicator follows the clock without re-renders elsewhere
  const [tickedNow, setTickedNow] = useState<Date>(() => currentTime ?? new Date());
  useEffect(() => {
    if (currentTime) {
      setTickedNow(currentTime);
      return;
    }
    const id = setInterval(() => setTickedNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [currentTime]);
  const now = currentTime ?? tickedNow;

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
        <div
          className="flex"
          style={{ minWidth: dayCount === 1 ? 320 : Math.max(640, 64 + dayCount * 140) }}
        >
          <div
            className="w-16 flex-shrink-0 border-r border-border text-xs text-muted-foreground"
            style={{ minHeight: gridHeight + 52 }}
          >
            <div className="sticky top-0 z-20 space-y-0.5 bg-card/95 px-1 py-2 text-center backdrop-blur">
              <div className="text-[10px] font-semibold text-foreground">Time</div>
              <div className="tabular-nums text-[10px] font-medium leading-tight">0:00–24:00</div>
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
          {days.map((day, dayIdx) => {
            const dw = dayWindows[dayIdx]!;
            const daySpan = dayScheduleSpan(day, shifts, dw.start, dw.end);
            const dayShifts = shifts.filter((s) => shiftCoversDay(s, day));
            return (
              <DayColumn
                key={day.toISOString()}
                day={day}
                window={dw}
                shifts={dayShifts}
                pendingByShift={pendingByShift}
                slotStepMinutes={slotStepMinutes}
                onActivate={handleActivate}
                onSlotClick={onSlotClick}
                onShiftClick={onShiftClick}
                currentUserId={currentUserId ?? null}
                gridHeight={gridHeight}
                fullDayMinutes={fullDayMinutes}
                daySpan={daySpan}
                now={now}
                showNowLine={showNowLine}
                canEdit={canEdit}
                defaultCreateSiteId={defaultCreateSiteId}
                onCreate={onCreate}
                onResize={onResize}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  day,
  window: dw,
  shifts,
  pendingByShift,
  slotStepMinutes,
  onActivate,
  onSlotClick,
  onShiftClick,
  currentUserId,
  gridHeight,
  fullDayMinutes,
  daySpan,
  now,
  showNowLine,
  canEdit,
  defaultCreateSiteId,
  onCreate,
  onResize,
}: {
  day: Date;
  window: DayWindow;
  shifts: TimelineShift[];
  pendingByShift: Map<string, PendingPickup[]>;
  slotStepMinutes: SlotStepMinutes;
  onActivate: (s: TimelineShift, slot: SlotPick) => void;
  onSlotClick?: (shift: TimelineShift, slot: SlotPick) => void;
  onShiftClick?: (shift: TimelineShift) => void;
  currentUserId: string | null;
  gridHeight: number;
  fullDayMinutes: number;
  daySpan: { start: Date; end: Date } | null;
  now: Date;
  showNowLine: boolean;
  canEdit: boolean;
  defaultCreateSiteId?: string;
  onCreate?: (input: { day: Date; startsAt: Date; endsAt: Date; siteId?: string }) => void;
  onResize?: (input: { shift: TimelineShift; endsAt: Date }) => void;
}) {
  const blockedTopPx = dw.start * 60 * PX_PER_MINUTE;
  const blockedBottomPx = (HOURS_IN_DAY - dw.end) * 60 * PX_PER_MINUTE;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<{ topMin: number; bottomMin: number } | null>(null);
  const [resize, setResize] = useState<{ shiftId: string; endMin: number } | null>(null);

  const isToday = isSameDay(now, day);
  const nowMin = isToday ? minutesFromMidnight(day, now) : null;
  const showNow = showNowLine && nowMin != null && nowMin >= dw.start * 60 && nowMin <= dw.end * 60;

  const canCreate = canEdit && Boolean(onCreate);
  const canResize = canEdit && Boolean(onResize);

  function pixelsToMinutes(yPx: number) {
    return Math.max(0, Math.min(fullDayMinutes, yPx / PX_PER_MINUTE));
  }

  function clampToWindow(min: number) {
    return Math.max(dw.start * 60, Math.min(dw.end * 60, min));
  }

  function handleBackgroundPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!canCreate) return;
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return; // ignore presses that started on a tile/handle
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startMin = clampToWindow(snapMinutes(pixelsToMinutes(e.clientY - rect.top), SUBGRID_MINUTES));
    setGhost({ topMin: startMin, bottomMin: startMin + SUBGRID_MINUTES });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function handleBackgroundPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!ghost) return;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cur = clampToWindow(snapMinutes(pixelsToMinutes(e.clientY - rect.top), SUBGRID_MINUTES));
    if (cur >= ghost.topMin) {
      setGhost({ topMin: ghost.topMin, bottomMin: Math.max(ghost.topMin + SUBGRID_MINUTES, cur) });
    } else {
      setGhost({ topMin: cur, bottomMin: ghost.bottomMin });
    }
  }

  function handleBackgroundPointerUp() {
    if (!ghost) return;
    const top = ghost.topMin;
    const bottom = Math.max(top + SUBGRID_MINUTES, ghost.bottomMin);
    setGhost(null);
    if (!onCreate) return;
    if (bottom - top < 15) return;
    onCreate({
      day,
      startsAt: dateAtMinutes(day, top),
      endsAt: dateAtMinutes(day, bottom),
      siteId: defaultCreateSiteId,
    });
  }

  function handleResizeStart(
    e: React.PointerEvent<HTMLDivElement>,
    shift: TimelineShift,
    initialEndMin: number,
  ) {
    if (!canResize) return;
    e.preventDefault();
    e.stopPropagation();
    setResize({ shiftId: shift.id, endMin: initialEndMin });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resize) return;
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cur = clampToWindow(snapMinutes(pixelsToMinutes(e.clientY - rect.top), SUBGRID_MINUTES));
    setResize({ ...resize, endMin: cur });
  }

  function handleResizeEnd(shift: TimelineShift) {
    if (!resize) return;
    const finalEnd = resize.endMin;
    setResize(null);
    if (!onResize) return;
    const startMin = minutesFromMidnight(day, toDate(shift.startsAt));
    if (finalEnd - startMin < 15) return;
    onResize({ shift, endsAt: dateAtMinutes(day, finalEnd) });
  }

  return (
    <div className="relative min-w-0 flex-1 border-l border-border">
      <div className="sticky top-0 z-20 space-y-0.5 bg-card/95 px-2 py-2 text-center backdrop-blur">
        <div className={cn("text-sm font-semibold", isToday && "text-primary")}>
          {day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
        </div>
        <div className="text-[10px] tabular-nums text-muted-foreground">
          Open {dw.start}:00–{dw.end}:00
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
      <div
        ref={surfaceRef}
        className={cn("relative isolate select-none", canCreate && "cursor-crosshair")}
        style={{ height: gridHeight }}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={(e) => {
          if (ghost) handleBackgroundPointerMove(e);
          else if (resize) handleResizeMove(e);
        }}
        onPointerUp={(e) => {
          if (ghost) handleBackgroundPointerUp();
          else if (resize) {
            const s = shifts.find((x) => x.id === resize.shiftId);
            if (s) handleResizeEnd(s);
          }
          (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
        }}
        onPointerCancel={() => {
          setGhost(null);
          setResize(null);
        }}
      >
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
        {Array.from({ length: HOURS_IN_DAY }, (_, h) => (
          <div
            key={`h-${h}`}
            className="pointer-events-none absolute left-0 right-0 border-t border-border/40"
            style={{ top: h * 60 * PX_PER_MINUTE }}
          />
        ))}
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

        {showNow && nowMin != null && (
          <div
            className="pointer-events-none absolute left-0 right-0 z-[60]"
            style={{ top: nowMin * PX_PER_MINUTE }}
            aria-hidden
          >
            <div className="relative h-px bg-red-500/90 shadow-[0_0_0_1px_rgba(255,255,255,0.6)]">
              <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-red-500" />
            </div>
          </div>
        )}

        {ghost && (
          <div
            className="pointer-events-none absolute left-1 right-1 z-[55] rounded border-2 border-dashed border-primary/80 bg-primary/15"
            style={{
              top: ghost.topMin * PX_PER_MINUTE,
              height: Math.max(8, (ghost.bottomMin - ghost.topMin) * PX_PER_MINUTE),
            }}
          >
            <div className="px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary">
              {formatClock(dateAtMinutes(day, ghost.topMin))} – {formatClock(dateAtMinutes(day, ghost.bottomMin))}
            </div>
          </div>
        )}

        {shifts.flatMap((s) => {
          const raw = segmentForDay(s, day);
          if (!raw) return [];
          const seg = clipSegmentToVisibleHours(raw, day, dw.start, dw.end);
          if (!seg) return [];
          const slots = iterSlotSegments(seg.segStart, seg.segEnd, slotStepMinutes);

          const assigneeId = s.assignee?.id;
          const isOpen = !assigneeId;
          const isMine = Boolean(currentUserId && assigneeId === currentUserId);
          const pend = pendingByShift.get(s.id) ?? [];
          const myPending = currentUserId ? pend.some((p) => p.requesterId === currentUserId) : false;
          const otherPending = pend.some((p) => p.requesterId !== currentUserId);
          const pendingRequesterNames =
            pend.length > 0
              ? [...new Set(pend.map((p) => p.requester.name))].join(", ")
              : "";

          const canPickOpen = isOpen && s.status === "PUBLISHED";
          const openWithPendingReview = canPickOpen && pend.length > 0;
          const canSwapMine = isMine;
          const isBooked = Boolean(assigneeId && s.status === "PUBLISHED");
          const isBookedMine = isBooked && isMine;
          const isBookedOther = isBooked && !isMine;
          const hasHandler = Boolean(onSlotClick || onShiftClick);
          // Any tile is clickable when a handler is wired — the modal decides what to show
          // (booking, swap, or read-only site details + admin comments).
          const canInteract = hasHandler;
          const isPassive = !canPickOpen && !canSwapMine;

          // Live resize override: if this shift is being resized, replace last slot's end
          const liveResizingMin = resize?.shiftId === s.id ? resize.endMin : null;

          return slots.map((slot, slotIdx) => {
            let startMin = minutesFromMidnight(day, slot.slotStart);
            let endMin = minutesFromMidnight(day, slot.slotEnd);
            if (liveResizingMin != null && slotIdx === slots.length - 1) {
              endMin = Math.max(startMin + 15, liveResizingMin);
            }
            const top = Math.max(0, startMin * PX_PER_MINUTE);
            const height = Math.max(28, (endMin - startMin) * PX_PER_MINUTE);

            const timeLine = `${toDate(slot.slotStart).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })} – ${toDate(slot.slotEnd).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}`;

            const stackKey = Math.round(top * 100) + slotIdx;
            const z = canInteract ? 40 + (stackKey % 50) : 10 + (stackKey % 20);

            const isLast = slotIdx === slots.length - 1;

            return (
              <div
                key={`${s.id}-${day.toISOString()}-${slotIdx}`}
                className="absolute left-1 right-1"
                style={{ top, height, zIndex: z }}
              >
                <button
                  type="button"
                  aria-disabled={!canInteract}
                  tabIndex={canInteract ? 0 : -1}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!canInteract) return;
                    onActivate(s, slot);
                  }}
                  className={cn(
                    "absolute inset-0 overflow-hidden rounded border px-1.5 py-0.5 text-left text-[10px] shadow-sm transition",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    canInteract ? "cursor-pointer hover:opacity-95 active:opacity-100" : "cursor-default",
                    isPassive && "opacity-90",
                    canPickOpen && s.status === "PUBLISHED" && "border-dashed",
                    openWithPendingReview &&
                      "border-amber-600/45 bg-amber-500/[0.14] ring-1 ring-amber-500/45 dark:border-amber-400/35 dark:bg-amber-500/10",
                    isBookedMine && "border-2 border-emerald-600/55 ring-1 ring-emerald-500/25",
                    isBookedOther && "border-2 border-sky-600/50 ring-1 ring-sky-500/25 dark:border-sky-400/45",
                    myPending && "ring-2 ring-amber-400/80",
                  )}
                  style={{
                    backgroundColor: isBookedMine
                      ? `${s.site.colorHex}40`
                      : isBookedOther
                        ? `${s.site.colorHex}38`
                        : openWithPendingReview
                          ? `${s.site.colorHex}18`
                          : `${s.site.colorHex}22`,
                    borderLeftWidth: 3,
                    borderLeftColor: s.site.colorHex,
                  }}
                  title={`${s.site.name} — ${timeLine}${
                    pendingRequesterNames ? ` — requested by ${pendingRequesterNames}` : ""
                  }${s.assignee?.name ? ` — ${s.assignee.name}` : ""}${
                    canInteract
                      ? canPickOpen
                        ? " (click to book)"
                        : canSwapMine
                          ? " (click to swap)"
                          : isBookedOther
                            ? " (click to request swap / details)"
                            : " (click for details)"
                      : ""
                  }`}
                >
                  <div className="truncate font-semibold leading-tight" style={{ color: s.site.colorHex }}>
                    {s.site.name}
                    {isBooked && (
                      <span className="ml-1 rounded bg-foreground/10 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-foreground/80">
                        Assigned
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[9px] text-muted-foreground">
                    {canPickOpen ? (
                      openWithPendingReview ? (
                        <span className="block truncate">
                          <span className="font-medium text-amber-900 dark:text-amber-100">Open · </span>
                          <span className="text-foreground/90">{pendingRequesterNames}</span>
                        </span>
                      ) : (
                        <span>Open</span>
                      )
                    ) : isMine ? (
                      <span className="font-medium text-emerald-800 dark:text-emerald-200">You</span>
                    ) : (
                      <span className="font-medium text-sky-950 dark:text-sky-100">
                        {s.assignee?.name ?? "—"}
                      </span>
                    )}
                    {myPending && (
                      <span className="ml-0.5 font-medium text-amber-700 dark:text-amber-300">· Your request</span>
                    )}
                    {!myPending && otherPending && (
                      <span className="ml-0.5 font-medium text-amber-700 dark:text-amber-300">· Admin review</span>
                    )}
                  </div>
                  <div className="tabular-nums text-[9px] font-medium text-foreground">{timeLine}</div>
                </button>
                {canResize && isLast && (
                  <div
                    role="separator"
                    aria-label="Resize shift end"
                    className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize bg-foreground/10 hover:bg-foreground/20"
                    onPointerDown={(e) => handleResizeStart(e, s, endMin)}
                  />
                )}
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}
