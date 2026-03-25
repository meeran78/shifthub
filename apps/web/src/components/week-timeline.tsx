"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 20;
const PX_PER_MINUTE = 1.2;

export type TimelineShift = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  site: { name: string; colorHex: string };
  assignee?: { name: string } | null;
};

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function sameCalendarDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function minutesFromDayStart(day: Date, t: Date, startHour: number) {
  const base = new Date(day);
  base.setHours(startHour, 0, 0, 0);
  return (t.getTime() - base.getTime()) / 60000;
}

export function WeekTimeline({
  weekStart,
  shifts,
  className,
}: {
  weekStart: Date;
  shifts: TimelineShift[];
  className?: string;
}) {
  const days = useMemo(() => {
    const start = startOfDay(weekStart);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [weekStart]);

  const totalMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
  const gridHeight = totalMinutes * PX_PER_MINUTE;

  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="overflow-x-auto">
        <div className="flex min-w-[960px]">
          <div
            className="w-16 flex-shrink-0 border-r border-border pt-10 text-xs text-muted-foreground"
            style={{ minHeight: gridHeight + 40 }}
          >
            {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, h) => (
              <div
                key={h}
                style={{ height: 60 * PX_PER_MINUTE }}
                className="border-t border-border/60 pr-2 text-right"
              >
                {DAY_START_HOUR + h}:00
              </div>
            ))}
          </div>
          {days.map((day) => (
            <div key={day.toISOString()} className="relative min-w-0 flex-1 border-l border-border">
              <div className="sticky top-0 z-20 bg-card/95 px-2 py-2 text-center text-sm font-semibold backdrop-blur">
                {day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
              </div>
              <div className="relative" style={{ height: gridHeight }}>
                {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, h) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-border/40"
                    style={{ top: h * 60 * PX_PER_MINUTE }}
                  />
                ))}
                {shifts
                  .filter((s) => sameCalendarDay(s.startsAt, day))
                  .map((s) => {
                    const top = Math.max(
                      0,
                      minutesFromDayStart(day, s.startsAt, DAY_START_HOUR) * PX_PER_MINUTE,
                    );
                    const endMin = minutesFromDayStart(day, s.endsAt, DAY_START_HOUR);
                    const startMin = minutesFromDayStart(day, s.startsAt, DAY_START_HOUR);
                    const height = Math.max(24, (endMin - startMin) * PX_PER_MINUTE);
                    return (
                      <div
                        key={s.id}
                        className="absolute left-1 right-1 overflow-hidden rounded-md border border-black/10 px-2 py-1 text-xs shadow-sm"
                        style={{
                          top,
                          height,
                          backgroundColor: `${s.site.colorHex}22`,
                          borderLeftWidth: 4,
                          borderLeftColor: s.site.colorHex,
                        }}
                        title={`${s.site.name} · ${s.assignee?.name ?? "Open"}`}
                      >
                        <div className="font-semibold leading-tight" style={{ color: s.site.colorHex }}>
                          {s.site.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {s.assignee?.name ?? "Open slot"}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {s.startsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} –{" "}
                          {s.endsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </div>
                      </div>
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
