"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { trpc } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  WeekTimeline,
  formatShiftTimeRange,
  type DayWindow,
  type PendingPickup,
  type SlotPick,
  type SlotStepMinutes,
  type TimelineShift,
} from "@/components/week-timeline";

type StatusFilter = "all" | "open" | "mine" | "others";
type CalendarMode = "day" | "week" | "month";

function startOfMonth(d: Date) {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addMonths(d: Date, n: number) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function defaultWindowsFrom(start: number, end: number): DayWindow[] {
  return Array.from({ length: 7 }, () => ({ start, end }));
}

function startOfWeekMonday(d: Date) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day + 6) % 7;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function formatLocalDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function SchedulePage() {
  const { user, isLoaded } = useUser();
  const sync = trpc.user.sync.useMutation();
  const me = trpc.user.me.useQuery(undefined, { enabled: Boolean(isLoaded && user) });
  const syncedRef = useRef(false);

  const [calendarMode, setCalendarMode] = useState<CalendarMode>("week");
  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeekMonday(new Date()));
  /** Anchor used by Day mode (the single visible day). */
  const [dayAnchor, setDayAnchor] = useState(() => {
    const x = new Date();
    x.setHours(0, 0, 0, 0);
    return x;
  });
  /** Anchor used by Month mode (any date in the visible month). */
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()));
  const [slotStepMinutes, setSlotStepMinutes] = useState<SlotStepMinutes>(15);
  /** Per-day visible window (hours), Mon..Sun. Shifts are clipped to each day's range. */
  const [dayWindows, setDayWindows] = useState<DayWindow[]>(() => defaultWindowsFrom(6, 20));
  const [perDayMode, setPerDayMode] = useState(false);
  const [siteFilter, setSiteFilter] = useState<Set<string>>(new Set());
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [createSiteId, setCreateSiteId] = useState<string>("");
  const [selected, setSelected] = useState<{ shift: TimelineShift; slot: SlotPick } | null>(null);
  const [swapTargetId, setSwapTargetId] = useState("");
  /** When viewing someone else&apos;s booked shift: your shift offered in exchange (shift A in API). */
  const [offerMyShiftId, setOfferMyShiftId] = useState("");

  /**
   * Visible date range driving `shift.list`. Day mode shows 1 day, Week mode shows 7 days
   * starting Monday, Month mode shows the full calendar month containing `monthAnchor`.
   */
  const range = useMemo(() => {
    if (calendarMode === "day") {
      return { from: dayAnchor, to: addDays(dayAnchor, 1) };
    }
    if (calendarMode === "month") {
      const start = startOfMonth(monthAnchor);
      const end = startOfMonth(addMonths(monthAnchor, 1));
      return { from: start, to: end };
    }
    return { from: weekAnchor, to: addDays(weekAnchor, 7) };
  }, [calendarMode, dayAnchor, weekAnchor, monthAnchor]);

  const utils = trpc.useUtils();
  const versions = trpc.schedule.listVersions.useQuery();
  const sites = trpc.site.list.useQuery();
  /** Prefer latest published year so open shifts are PUBLISHED and bookable; else fall back to newest row. */
  const activeVersionId = useMemo(() => {
    const list = versions.data;
    if (!list?.length) return undefined;
    const published = list.filter((v) => v.status === "PUBLISHED");
    if (published.length > 0) {
      return published.reduce((best, cur) => (cur.year > best.year ? cur : best)).id;
    }
    return list[0]!.id;
  }, [versions.data]);

  const bookingDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = bookingDialogRef.current;
    if (!d) return;
    if (selected) {
      if (!d.open) d.showModal();
    } else if (d.open) {
      d.close();
    }
  }, [selected]);

  const shifts = trpc.shift.list.useQuery(
    {
      scheduleVersionId: activeVersionId,
      from: range.from,
      to: range.to,
    },
    {
      enabled: !!activeVersionId,
      /** Admin approvals happen out-of-band; keep the calendar from staying stale. */
      refetchInterval: 25_000,
      refetchOnWindowFocus: true,
    },
  );

  const shiftIds = useMemo(() => shifts.data?.map((s) => s.id) ?? [], [shifts.data]);

  const pendingPickups = trpc.workflow.pickupRequestsForShifts.useQuery(
    { shiftIds },
    {
      enabled: shiftIds.length > 0,
      refetchInterval: 12_000,
      refetchOnWindowFocus: true,
    },
  );

  const mySwaps = trpc.workflow.listMySwapRequests.useQuery(undefined, {
    enabled: Boolean(me.data?.user),
  });

  const myPickups = trpc.workflow.myPickupRequests.useQuery(undefined, {
    enabled: Boolean(me.data?.user),
    /** Detect admin approve/deny without a full page reload. */
    refetchInterval: 8_000,
    refetchOnWindowFocus: true,
  });

  const myPickupStatusSig = useMemo(
    () =>
      (myPickups.data ?? [])
        .map((p) => `${p.id}:${p.status}`)
        .sort()
        .join("|"),
    [myPickups.data],
  );
  const myPickupSigPrev = useRef<string | null>(null);
  useEffect(() => {
    if (!me.data?.user) {
      myPickupSigPrev.current = null;
      return;
    }
    if (myPickups.isLoading) return;
    const prev = myPickupSigPrev.current;
    if (prev !== null && prev !== myPickupStatusSig) {
      void utils.shift.list.invalidate();
      void utils.workflow.pickupRequestsForShifts.invalidate();
    }
    myPickupSigPrev.current = myPickupStatusSig;
  }, [me.data?.user, myPickups.isLoading, myPickupStatusSig, utils]);

  const requestPickup = trpc.workflow.requestPickup.useMutation({
    onSuccess: async () => {
      await utils.workflow.pickupRequestsForShifts.invalidate();
      await utils.workflow.myPickupRequests.invalidate();
      await utils.workflow.listPendingPickups.invalidate();
      await utils.shift.list.invalidate();
      setSelected(null);
    },
  });

  const requestSwap = trpc.workflow.requestSwap.useMutation({
    onSuccess: async () => {
      await utils.workflow.listMySwapRequests.invalidate();
      await utils.workflow.listPendingSwaps.invalidate();
      await utils.shift.list.invalidate();
      setSelected(null);
      setSwapTargetId("");
      setOfferMyShiftId("");
    },
  });

  const acceptSwap = trpc.workflow.acceptSwapCounterparty.useMutation({
    onSuccess: async () => {
      await utils.workflow.listMySwapRequests.invalidate();
      await utils.workflow.listPendingSwaps.invalidate();
      await utils.shift.list.invalidate();
    },
  });

  const createShift = trpc.shift.create.useMutation({
    onSuccess: async () => {
      await utils.shift.list.invalidate();
    },
  });

  const updateShift = trpc.shift.update.useMutation({
    onSuccess: async () => {
      await utils.shift.list.invalidate();
    },
  });

  useEffect(() => {
    if (!isLoaded || !user || syncedRef.current) return;
    syncedRef.current = true;
    const emailHint =
      user.primaryEmailAddress?.emailAddress?.trim() ||
      user.emailAddresses?.[0]?.emailAddress?.trim();
    const nameHint = user.fullName ?? user.firstName ?? undefined;
    const phoneHint = user.primaryPhoneNumber?.phoneNumber ?? undefined;
    const syncInput: {
      email?: string;
      name?: string;
      phone?: string;
    } = {};
    if (emailHint) syncInput.email = emailHint;
    if (nameHint?.trim()) syncInput.name = nameHint.trim();
    if (phoneHint?.trim()) syncInput.phone = phoneHint.trim();
    sync.mutate(Object.keys(syncInput).length > 0 ? syncInput : undefined, {
      onSuccess: () => {
        void me.refetch();
      },
      onError: (err) => {
        if (process.env.NODE_ENV === "development") {
          console.error("[user.sync]", err);
        }
      },
    });
  }, [isLoaded, user, sync, me]);

  /** All shifts for the week, mapped for the timeline. Filters apply afterwards. */
  const allTimelineShifts: TimelineShift[] | undefined = useMemo(() => {
    if (!shifts.data) return undefined;
    return shifts.data.map((s) => ({
      id: s.id,
      startsAt: new Date(s.startsAt),
      endsAt: new Date(s.endsAt),
      status: s.status,
      site: s.site,
      assignee: s.assignee ? { id: s.assignee.id, name: s.assignee.name } : null,
    }));
  }, [shifts.data]);

  /** Map shiftId → siteId so site filter can run on TimelineShift items. */
  const siteIdByShift = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shifts.data ?? []) m.set(s.id, s.siteId);
    return m;
  }, [shifts.data]);

  /** Distinct assignees seen in this week's shifts (used by the assignee filter chips). */
  const assigneeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of allTimelineShifts ?? []) {
      if (s.assignee) seen.set(s.assignee.id, s.assignee.name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [allTimelineShifts]);

  const timelineShifts: TimelineShift[] | undefined = useMemo(() => {
    if (!allTimelineShifts) return undefined;
    const myId = me.data?.user.id;
    return allTimelineShifts.filter((s) => {
      if (siteFilter.size > 0) {
        const sid = siteIdByShift.get(s.id);
        if (!sid || !siteFilter.has(sid)) return false;
      }
      // Open = unassigned (People chips do not apply — no assignee on these rows).
      if (statusFilter === "open" && s.assignee) return false;
      // Until `me` resolves, do not treat "Mine" as "exclude everything" (undefined myId used to hide all rows).
      if (statusFilter === "mine" && myId && s.assignee?.id !== myId) return false;
      if (statusFilter === "others") {
        if (!s.assignee) return false;
        if (myId && s.assignee.id === myId) return false;
      }
      if (assigneeFilter.size > 0 && statusFilter !== "open") {
        if (!s.assignee || !assigneeFilter.has(s.assignee.id)) return false;
      }
      return true;
    });
  }, [allTimelineShifts, siteFilter, siteIdByShift, statusFilter, assigneeFilter, me.data?.user.id]);

  /** Query finished (including empty list); distinct from initial undefined before first response. */
  const timelineReady = Boolean(activeVersionId && timelineShifts !== undefined);
  const shiftsExistInRange = (shifts.data?.length ?? 0) > 0;
  const filtersHideAllShifts =
    timelineReady && shiftsExistInRange && (timelineShifts?.length ?? 0) === 0;

  const isAdmin = me.data?.user.role === "ADMIN";

  /** Default the admin "create on drag" site to the first site once loaded. */
  useEffect(() => {
    if (!createSiteId && sites.data && sites.data.length > 0) {
      setCreateSiteId(sites.data[0]!.id);
    }
  }, [sites.data, createSiteId]);

  const swapOptions = useMemo(() => {
    if (!selected || !timelineShifts || !me.data?.user.id) return [];
    const myId = me.data.user.id;
    return timelineShifts.filter(
      (s) =>
        s.id !== selected.shift.id &&
        s.assignee?.id &&
        s.assignee.id !== myId,
    );
  }, [selected, timelineShifts, me.data?.user.id]);

  /** Your assigned shifts you can offer when requesting a swap for someone else&apos;s slot. */
  const myShiftsToOffer = useMemo(() => {
    if (!selected || !allTimelineShifts || !me.data?.user.id) return [];
    const myId = me.data.user.id;
    return allTimelineShifts.filter(
      (s) =>
        s.id !== selected.shift.id &&
        s.assignee?.id === myId &&
        s.status === "PUBLISHED",
    );
  }, [selected, allTimelineShifts, me.data?.user.id]);

  const uid = me.data?.user.id;

  useEffect(() => {
    setOfferMyShiftId("");
  }, [selected?.shift.id]);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-4">
        <div>
          <h1 className="text-2xl font-bold">My schedule</h1>
          <p className="text-sm text-muted-foreground">
            {calendarMode === "day"
              ? "Day view"
              : calendarMode === "month"
                ? "Month view"
                : "Week view"}{" "}
            · tap any slot for details; book open shifts; request swaps on your shifts or on colleagues&apos; booked shifts
            (offer one of yours in exchange)
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button asChild variant="outline">
            <Link href="/">Home</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin">Admin</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-6 p-4">
        <Card>
          <CardHeader>
            <CardTitle>
              {calendarMode === "day" ? "Day" : calendarMode === "month" ? "Month" : "Week"} navigation
            </CardTitle>
            <CardDescription>
              Switch between Day, Week, and Month views. Shifts load from the latest schedule version.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label>View</Label>
              <div className="flex flex-wrap gap-1">
                {(["day", "week", "month"] as const).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="sm"
                    variant={calendarMode === m ? "default" : "outline"}
                    onClick={() => setCalendarMode(m)}
                  >
                    {m[0]!.toUpperCase() + m.slice(1)}
                  </Button>
                ))}
              </div>
            </div>

            {calendarMode === "day" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="dayPick">Day</Label>
                  <Input
                    id="dayPick"
                    type="date"
                    className="w-48"
                    value={formatLocalDate(dayAnchor)}
                    onChange={(e) => {
                      const v = e.target.valueAsDate;
                      if (v) {
                        const x = new Date(v);
                        x.setHours(0, 0, 0, 0);
                        setDayAnchor(x);
                      }
                    }}
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={() => setDayAnchor((d) => addDays(d, -1))}>
                    Previous day
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      const x = new Date();
                      x.setHours(0, 0, 0, 0);
                      setDayAnchor(x);
                    }}
                  >
                    Today
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setDayAnchor((d) => addDays(d, 1))}>
                    Next day
                  </Button>
                </div>
              </>
            )}

            {calendarMode === "week" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="week">Week starting</Label>
                  <Input
                    id="week"
                    type="date"
                    className="w-48"
                    value={formatLocalDate(weekAnchor)}
                    onChange={(e) => {
                      const v = e.target.valueAsDate;
                      if (v) setWeekAnchor(startOfWeekMonday(v));
                    }}
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={() => setWeekAnchor((w) => addDays(w, -7))}>
                    Previous week
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setWeekAnchor(startOfWeekMonday(new Date()))}
                  >
                    This week
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setWeekAnchor((w) => addDays(w, 7))}>
                    Next week
                  </Button>
                </div>
              </>
            )}

            {calendarMode === "month" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="monthPick">Month</Label>
                  <Input
                    id="monthPick"
                    type="month"
                    className="w-44"
                    value={`${monthAnchor.getFullYear()}-${String(monthAnchor.getMonth() + 1).padStart(2, "0")}`}
                    onChange={(e) => {
                      const [yStr, mStr] = e.target.value.split("-");
                      const y = Number(yStr);
                      const m = Number(mStr);
                      if (Number.isFinite(y) && Number.isFinite(m)) {
                        setMonthAnchor(new Date(y, m - 1, 1));
                      }
                    }}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setMonthAnchor((m) => addMonths(m, -1))}
                  >
                    Previous month
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setMonthAnchor(startOfMonth(new Date()))}
                  >
                    This month
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setMonthAnchor((m) => addMonths(m, 1))}
                  >
                    Next month
                  </Button>
                </div>
              </>
            )}
            <div className="space-y-2 pt-2">
              <Label>Slot size (click targets)</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={slotStepMinutes === 15 ? "default" : "outline"}
                  onClick={() => setSlotStepMinutes(15)}
                >
                  15 minutes
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={slotStepMinutes === 30 ? "default" : "outline"}
                  onClick={() => setSlotStepMinutes(30)}
                >
                  30 minutes
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Open published shifts are split into tiles. Pickup requests can include a 15–30 minute preferred
                window when you choose a tile.
              </p>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm">Open hours</Label>
                <div className="flex items-center gap-2 text-xs">
                  <Button
                    type="button"
                    size="sm"
                    variant={perDayMode ? "outline" : "default"}
                    onClick={() => {
                      const first = dayWindows[0] ?? { start: 6, end: 20 };
                      setDayWindows(defaultWindowsFrom(first.start, first.end));
                      setPerDayMode(false);
                    }}
                  >
                    Same every day
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={perDayMode ? "default" : "outline"}
                    onClick={() => setPerDayMode(true)}
                  >
                    Per weekday
                  </Button>
                </div>
              </div>

              {!perDayMode ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="vh0">Day starts at (hour)</Label>
                    <Input
                      id="vh0"
                      type="number"
                      min={0}
                      max={22}
                      className="w-32"
                      value={dayWindows[0]?.start ?? 6}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isNaN(v)) return;
                        const s = Math.max(0, Math.min(22, v));
                        const cur = dayWindows[0] ?? { start: 6, end: 20 };
                        const e2 = cur.end <= s ? Math.min(24, s + 1) : cur.end;
                        setDayWindows(defaultWindowsFrom(s, e2));
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="vh1">Day ends at (hour)</Label>
                    <Input
                      id="vh1"
                      type="number"
                      min={1}
                      max={24}
                      className="w-32"
                      value={dayWindows[0]?.end ?? 20}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isNaN(v)) return;
                        const end = Math.max(1, Math.min(24, v));
                        const cur = dayWindows[0] ?? { start: 6, end: 20 };
                        const s2 = end <= cur.start ? Math.max(0, end - 1) : cur.start;
                        setDayWindows(defaultWindowsFrom(s2, end));
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-7">
                  {WEEKDAY_LABELS.map((wd, i) => {
                    const w = dayWindows[i] ?? { start: 6, end: 20 };
                    return (
                      <div key={wd} className="space-y-1 rounded-md border border-border p-2">
                        <div className="text-xs font-semibold">{wd}</div>
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={0}
                            max={22}
                            className="h-8 w-14 px-1"
                            value={w.start}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isNaN(v)) return;
                              const s = Math.max(0, Math.min(22, v));
                              const end = w.end <= s ? Math.min(24, s + 1) : w.end;
                              setDayWindows((prev) => prev.map((x, idx) => (idx === i ? { start: s, end } : x)));
                            }}
                          />
                          <span className="text-xs text-muted-foreground">–</span>
                          <Input
                            type="number"
                            min={1}
                            max={24}
                            className="h-8 w-14 px-1"
                            value={w.end}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isNaN(v)) return;
                              const end = Math.max(1, Math.min(24, v));
                              const start = end <= w.start ? Math.max(0, end - 1) : w.start;
                              setDayWindows((prev) => prev.map((x, idx) => (idx === i ? { start, end } : x)));
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Each day is a full 0:00–24:00 column; times outside the open window are shaded as blocked. Pickup tiles
                only appear in the open window; long shifts are clipped to the visible band while full times stay in
                details and requests.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Filters</Label>
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground">Status:</span>
                {(["all", "open", "mine", "others"] as const).map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant={statusFilter === s ? "default" : "outline"}
                    onClick={() => setStatusFilter(s)}
                  >
                    {s === "all" ? "All" : s === "open" ? "Open" : s === "mine" ? "Mine" : "Others"}
                  </Button>
                ))}
              </div>
              {sites.data && sites.data.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-muted-foreground">Sites:</span>
                  {sites.data.map((site) => {
                    const active = siteFilter.has(site.id);
                    return (
                      <Button
                        key={site.id}
                        type="button"
                        size="sm"
                        variant={active ? "default" : "outline"}
                        onClick={() =>
                          setSiteFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(site.id)) next.delete(site.id);
                            else next.add(site.id);
                            return next;
                          })
                        }
                        style={
                          active
                            ? { borderColor: site.colorHex, backgroundColor: `${site.colorHex}33` }
                            : undefined
                        }
                      >
                        <span
                          className="mr-1 inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: site.colorHex }}
                        />
                        {site.name}
                      </Button>
                    );
                  })}
                  {siteFilter.size > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setSiteFilter(new Set())}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              )}
              {assigneeOptions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-muted-foreground">People:</span>
                  {assigneeOptions.map((a) => {
                    const active = assigneeFilter.has(a.id);
                    return (
                      <Button
                        key={a.id}
                        type="button"
                        size="sm"
                        variant={active ? "default" : "outline"}
                        onClick={() =>
                          setAssigneeFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(a.id)) next.delete(a.id);
                            else next.add(a.id);
                            return next;
                          })
                        }
                      >
                        {a.name}
                      </Button>
                    );
                  })}
                  {assigneeFilter.size > 0 && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setAssigneeFilter(new Set())}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Calendar export (.ics)</Label>
              <div className="flex flex-wrap gap-2">
                <Button asChild type="button" size="sm" variant="outline">
                  <a href="/api/calendar.ics?scope=mine" download>
                    Download my shifts
                  </a>
                </Button>
                <Button asChild type="button" size="sm" variant="outline">
                  <a href="/api/calendar.ics?scope=open" download>
                    Open shifts
                  </a>
                </Button>
                {isAdmin && (
                  <Button asChild type="button" size="sm" variant="outline">
                    <a href="/api/calendar.ics?scope=all" download>
                      All shifts (admin)
                    </a>
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Subscribe to the same URL in Outlook / Google / Apple Calendar to keep an always-updating feed.
              </p>
            </div>

            {isAdmin && (
              <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                <Label className="text-sm">Admin: drag-to-create</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">New shifts use site:</span>
                  <select
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    value={createSiteId}
                    onChange={(e) => setCreateSiteId(e.target.value)}
                  >
                    {(sites.data ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground">
                  Drag on empty calendar space to create a draft shift; drag the bottom edge of a tile to resize.
                  Snaps to 15 minutes; only works in the open window.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {myPickups.data?.some(
          (p) =>
            p.status === "PENDING" ||
            (p.status === "DENIED" && p.resolutionNote) ||
            (p.status === "APPROVED" && p.adminApprovalNote),
        ) && (
          <Card>
            <CardHeader>
              <CardTitle>Your pickup requests</CardTitle>
              <CardDescription>
                Pending bookings, approvals with an admin message, and rejections with a reason.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {myPickups.data
                ?.filter(
                  (p) =>
                    p.status === "PENDING" ||
                    (p.status === "DENIED" && p.resolutionNote) ||
                    (p.status === "APPROVED" && p.adminApprovalNote),
                )
                .slice(0, 8)
                .map((p) => (
                  <div key={p.id} className="rounded-md border border-border p-3">
                    <div className="font-medium">{p.shift.site.name}</div>
                    <div className="text-muted-foreground">
                      {formatShiftTimeRange(p.shift.startsAt, p.shift.endsAt)}
                    </div>
                    {p.status === "PENDING" && (
                      <div className="mt-1 text-amber-700 dark:text-amber-300">Awaiting admin approval</div>
                    )}
                    {p.status === "APPROVED" && p.adminApprovalNote && (
                      <div className="mt-1 text-emerald-800 dark:text-emerald-200">
                        Approved — message from admin: {p.adminApprovalNote}
                      </div>
                    )}
                    {p.status === "DENIED" && p.resolutionNote && (
                      <div className="mt-1 text-destructive">Rejected: {p.resolutionNote}</div>
                    )}
                  </div>
                ))}
            </CardContent>
          </Card>
        )}

        {mySwaps.data && mySwaps.data.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Swap requests</CardTitle>
              <CardDescription>Accept incoming swaps or wait for admin approval.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {mySwaps.data.map((sw) => {
                const imB = sw.userBId === uid;
                const pendingCp = sw.status === "PENDING_COUNTERPARTY";
                const pendingAd = sw.status === "PENDING_ADMIN";
                const denied = sw.status === "DENIED";
                return (
                  <div
                    key={sw.id}
                    className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="font-medium">
                        {sw.shiftA.site.name} ↔ {sw.shiftB.site.name}
                      </div>
                      <div className="text-muted-foreground">
                        {sw.userA.name} ↔ {sw.userB.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatShiftTimeRange(sw.shiftA.startsAt, sw.shiftA.endsAt)} ·{" "}
                        {formatShiftTimeRange(sw.shiftB.startsAt, sw.shiftB.endsAt)}
                      </div>
                      <div className="text-xs">
                        {pendingCp && "Awaiting counterpart"}
                        {pendingAd && "Awaiting admin approval"}
                        {denied && sw.resolutionNote && (
                          <span className="text-destructive">Rejected by admin: {sw.resolutionNote}</span>
                        )}
                        {denied && !sw.resolutionNote && (
                          <span className="text-muted-foreground">Swap rejected</span>
                        )}
                      </div>
                    </div>
                    {pendingCp && imB && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => acceptSwap.mutate({ swapId: sw.id })}
                        disabled={acceptSwap.isPending}
                      >
                        Accept swap
                      </Button>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {!activeVersionId && (
          <Card>
            <CardHeader>
              <CardTitle>No schedule yet</CardTitle>
              <CardDescription>
                An admin needs to create a schedule version and add shifts. Visit Admin when you are ready.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {activeVersionId && shifts.data && shifts.data.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle>
                Nothing on this {calendarMode === "day" ? "day" : calendarMode === "month" ? "month" : "week"}
              </CardTitle>
              <CardDescription>
                Try another {calendarMode}, or ask an admin to publish shifts for this period.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {filtersHideAllShifts && (
          <Card>
            <CardHeader>
              <CardTitle>No shifts match your filters</CardTitle>
              <CardDescription>
                Try setting Status to All, clearing Sites or People, or picking a different date range. Open shifts
                always ignore the People filter.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {timelineReady && calendarMode !== "month" && (
          <WeekTimeline
            weekStart={calendarMode === "day" ? dayAnchor : weekAnchor}
            daysToShow={calendarMode === "day" ? 1 : 7}
            shifts={timelineShifts ?? []}
            currentUserId={uid}
            pendingPickups={pendingPickups.data ?? []}
            slotStepMinutes={slotStepMinutes}
            visibleHoursByDay={
              calendarMode === "day"
                ? // In Day mode the timeline only renders one column, but the prop expects an array
                  // indexed from `weekStart`. Repeat the matching weekday window so it lines up.
                  [dayWindows[(dayAnchor.getDay() + 6) % 7]!]
                : dayWindows
            }
            canEdit={isAdmin}
            defaultCreateSiteId={createSiteId}
            onCreate={
              isAdmin && activeVersionId
                ? ({ startsAt, endsAt, siteId }) => {
                    if (!siteId) return;
                    createShift.mutate({
                      scheduleVersionId: activeVersionId,
                      siteId,
                      coverageCategory: "OFFICE_LOCATION",
                      startsAt,
                      endsAt,
                      status: "DRAFT",
                    });
                  }
                : undefined
            }
            onResize={
              isAdmin
                ? ({ shift, endsAt }) => {
                    updateShift.mutate({ id: shift.id, endsAt });
                  }
                : undefined
            }
            onSlotClick={(shift, slot) => setSelected({ shift, slot })}
          />
        )}

        {timelineReady && calendarMode === "month" && (
          <MonthGrid
            monthAnchor={monthAnchor}
            shifts={timelineShifts ?? []}
            currentUserId={uid}
            pendingPickups={pendingPickups.data ?? []}
            onShiftClick={(shift) => {
              // Reuse the existing modal: synthesize a slot covering the whole shift since
              // Month view doesn't have a sub-hour click target.
              setSelected({
                shift,
                slot: {
                  slotStart: new Date(shift.startsAt),
                  slotEnd: new Date(shift.endsAt),
                },
              });
            }}
          />
        )}

        <dialog
          ref={bookingDialogRef}
          onClose={() => setSelected(null)}
          onClick={(e) => {
            if (e.target === bookingDialogRef.current) setSelected(null);
          }}
          className="fixed left-1/2 top-1/2 z-50 w-[min(100vw-2rem,28rem)] max-h-[min(90vh,640px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-0 text-foreground shadow-lg backdrop:bg-black/50"
        >
          {selected && (
            <div className="p-6">
              <h2 className="text-lg font-semibold">
                {uid && selected.shift.assignee?.id === uid
                  ? "Request swap"
                  : uid &&
                      selected.shift.assignee &&
                      selected.shift.assignee.id !== uid &&
                      selected.shift.status === "PUBLISHED"
                    ? "Request swap"
                    : !selected.shift.assignee && selected.shift.status === "PUBLISHED"
                      ? "Book shift"
                      : "Shift details"}
              </h2>
              <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: selected.shift.site.colorHex }}
                  aria-hidden
                />
                <span className="font-medium text-foreground">{selected.shift.site.name}</span>
                <span aria-hidden>·</span>
                <span>{formatShiftTimeRange(selected.shift.startsAt, selected.shift.endsAt)}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Selected slot: {formatShiftTimeRange(selected.slot.slotStart, selected.slot.slotEnd)}
              </p>

              <ShiftDetailPanel shiftId={selected.shift.id} canEdit={isAdmin} />

              <div className="mt-5 space-y-4">
                {!selected.shift.assignee && selected.shift.status === "PUBLISHED" && (
                  <BookingForm
                    key={`book-${selected.shift.id}`}
                    shift={selected.shift}
                    initialSlot={selected.slot}
                    disabled={!uid || requestPickup.isPending}
                    busy={requestPickup.isPending}
                    onSubmit={(payload) => requestPickup.mutate(payload)}
                  />
                )}

                {uid && selected.shift.assignee?.id === uid && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Propose a swap with a colleague&apos;s assigned shift this week. They must accept, then an admin
                      approves. The swap applies to the full shifts, not only this tile.
                    </p>
                    <div className="space-y-2">
                      <Label htmlFor="swapWith">Swap with (their shift)</Label>
                      <select
                        id="swapWith"
                        className="flex h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                        value={swapTargetId}
                        onChange={(e) => setSwapTargetId(e.target.value)}
                      >
                        <option value="">Select shift…</option>
                        {swapOptions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.site.name} · {s.assignee?.name} · {formatShiftTimeRange(s.startsAt, s.endsAt)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button
                      type="button"
                      className="w-full sm:w-auto"
                      disabled={!swapTargetId || requestSwap.isPending}
                      onClick={() => {
                        const other = timelineShifts?.find((x) => x.id === swapTargetId);
                        const otherAssignee = other?.assignee?.id;
                        if (!otherAssignee) return;
                        requestSwap.mutate({
                          myShiftId: selected.shift.id,
                          theirShiftId: swapTargetId,
                          counterpartyId: otherAssignee,
                        });
                      }}
                    >
                      {requestSwap.isPending ? "Sending…" : "Request swap"}
                    </Button>
                  </div>
                )}

                {uid &&
                  selected.shift.assignee &&
                  selected.shift.assignee.id !== uid &&
                  selected.shift.status === "PUBLISHED" && (
                    <div className="space-y-3 rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
                      <p className="text-sm text-muted-foreground">
                        This shift is <strong className="text-foreground">booked</strong> by{" "}
                        <span className="font-medium text-foreground">{selected.shift.assignee.name}</span>. Pick one of
                        your assigned shifts to offer in exchange. They will be notified to accept; then it goes to
                        admin for approval.
                      </p>
                      {myShiftsToOffer.length === 0 ? (
                        <p className="text-xs text-amber-800 dark:text-amber-200">
                          You have no other published shifts in this date range to offer. Change the calendar range or
                          ask admin to adjust assignments.
                        </p>
                      ) : (
                        <>
                          <div className="space-y-2">
                            <Label htmlFor="offerMyShift">Your shift to offer</Label>
                            <select
                              id="offerMyShift"
                              className="flex h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                              value={offerMyShiftId}
                              onChange={(e) => setOfferMyShiftId(e.target.value)}
                            >
                              <option value="">Select your shift…</option>
                              {myShiftsToOffer.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.site.name} · {formatShiftTimeRange(s.startsAt, s.endsAt)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <Button
                            type="button"
                            className="w-full sm:w-auto"
                            disabled={!offerMyShiftId || requestSwap.isPending}
                            onClick={() => {
                              const counterId = selected.shift.assignee?.id;
                              if (!counterId || !offerMyShiftId) return;
                              requestSwap.mutate({
                                myShiftId: offerMyShiftId,
                                theirShiftId: selected.shift.id,
                                counterpartyId: counterId,
                              });
                            }}
                          >
                            {requestSwap.isPending ? "Sending…" : "Send swap request"}
                          </Button>
                        </>
                      )}
                    </div>
                  )}

                {uid &&
                  selected.shift.assignee &&
                  selected.shift.assignee.id !== uid &&
                  selected.shift.status !== "PUBLISHED" && (
                    <p className="text-sm text-muted-foreground">This slot is assigned (not on a published schedule).</p>
                  )}

                {uid && (
                  <ContactAdminForm
                    key={`contact-${selected.shift.id}`}
                    shiftId={selected.shift.id}
                    initialSlot={selected.slot}
                    shiftStart={new Date(selected.shift.startsAt)}
                    shiftEnd={new Date(selected.shift.endsAt)}
                  />
                )}

                <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setSelected(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </dialog>

        {me.data?.user && (
          <p className="text-sm text-muted-foreground">
            Signed in as{" "}
            <span className="font-medium text-foreground">{me.data.user.name}</span> ({me.data.user.role}).
          </p>
        )}
      </main>
    </div>
  );
}

/**
 * Renders site metadata, admin notes, and the comment thread for a shift.
 * Read-only for physicians/APPs. Admins get inline note editing and a comment composer.
 *
 * Mounted inside the schedule modal so any signed-in user who clicks an assigned
 * (scheduled) slot can see the site details and admin commentary alongside the
 * existing booking/swap actions.
 */
function ShiftDetailPanel({ shiftId, canEdit }: { shiftId: string; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const detail = trpc.shift.byId.useQuery({ id: shiftId }, { staleTime: 5_000 });

  const updateNotes = trpc.shift.updateNotes.useMutation({
    onSuccess: () => utils.shift.byId.invalidate({ id: shiftId }),
  });
  const addComment = trpc.shift.addComment.useMutation({
    onSuccess: () => utils.shift.byId.invalidate({ id: shiftId }),
  });
  const deleteComment = trpc.shift.deleteComment.useMutation({
    onSuccess: () => utils.shift.byId.invalidate({ id: shiftId }),
  });

  const [noteDraft, setNoteDraft] = useState<string>("");
  const [noteEditing, setNoteEditing] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");

  useEffect(() => {
    if (detail.data) setNoteDraft(detail.data.adminNotes ?? "");
  }, [detail.data]);

  if (detail.isLoading) {
    return <p className="mt-4 text-xs text-muted-foreground">Loading shift details…</p>;
  }
  if (!detail.data) return null;
  const s = detail.data;

  const coverageLabel = [
    s.coverageCategory.replace(/_/g, " ").toLowerCase(),
    s.inpatientSplit ? `(${s.inpatientSplit.toLowerCase()})` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className="mt-4 space-y-4 rounded-md border border-border bg-muted/20 p-3 text-sm">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Site</div>
          <div className="font-medium text-foreground">{s.site.name}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Coverage</div>
          <div className="font-medium capitalize text-foreground">{coverageLabel || "—"}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Status</div>
          <div className="font-medium text-foreground">
            {s.status === "PUBLISHED" ? "Published" : "Draft"}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Assigned to</div>
          <div className="font-medium text-foreground">
            {s.assignee ? `${s.assignee.name} (${s.assignee.role})` : "Open"}
          </div>
        </div>
        <div className="col-span-2">
          <div className="text-muted-foreground">Schedule version</div>
          <div className="font-medium text-foreground">
            {s.scheduleVersion.label}{" "}
            <span className="text-muted-foreground">
              · {s.scheduleVersion.year} · {s.scheduleVersion.status.toLowerCase()}
            </span>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Admin notes
          </span>
          {canEdit && !noteEditing && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setNoteEditing(true)}
            >
              {s.adminNotes ? "Edit" : "Add note"}
            </Button>
          )}
        </div>
        {!canEdit || !noteEditing ? (
          s.adminNotes ? (
            <p className="whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 text-sm">
              {s.adminNotes}
            </p>
          ) : (
            <p className="text-xs italic text-muted-foreground">No admin notes for this shift.</p>
          )
        ) : (
          <div className="space-y-2">
            <textarea
              className="min-h-[88px] w-full rounded-md border border-border bg-background p-2 text-sm"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Visible to everyone on this shift."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={updateNotes.isPending}
                onClick={() =>
                  updateNotes.mutate(
                    { id: shiftId, adminNotes: noteDraft.trim() || null },
                    { onSuccess: () => setNoteEditing(false) },
                  )
                }
              >
                {updateNotes.isPending ? "Saving…" : "Save note"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNoteDraft(s.adminNotes ?? "");
                  setNoteEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Admin comments {s.comments.length > 0 ? `(${s.comments.length})` : ""}
        </div>
        {s.comments.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">No comments yet.</p>
        ) : (
          <ul className="space-y-2">
            {s.comments.map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-border bg-background p-2 text-sm"
              >
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    <span className="font-medium text-foreground">{c.author.name}</span>{" "}
                    · {c.author.role.toLowerCase()}
                  </span>
                  <span className="flex items-center gap-2">
                    <span>{new Date(c.createdAt).toLocaleString()}</span>
                    {canEdit && (
                      <button
                        type="button"
                        className="text-destructive hover:underline"
                        onClick={() => deleteComment.mutate({ id: c.id })}
                        disabled={deleteComment.isPending}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <div className="mt-2 space-y-2">
            <textarea
              className="min-h-[64px] w-full rounded-md border border-border bg-background p-2 text-sm"
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              placeholder="Post a comment for the team (admins only)."
            />
            <Button
              type="button"
              size="sm"
              disabled={!commentDraft.trim() || addComment.isPending}
              onClick={() =>
                addComment.mutate(
                  { shiftId, body: commentDraft.trim() },
                  { onSuccess: () => setCommentDraft("") },
                )
              }
            >
              {addComment.isPending ? "Posting…" : "Post comment"}
            </Button>
          </div>
        ) : s.comments.length > 0 ? (
          <p className="text-xs text-muted-foreground">Admin comments are read-only for your role.</p>
        ) : null}
      </div>
    </section>
  );
}

const MONTH_WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Compact month grid (Mon..Sun columns) showing shifts as colored chips.
 * Reuses the existing modal flow: clicking a chip opens the same `ShiftDetailPanel`.
 *
 * Designed for low information density (a physician scanning their month) — the per-day
 * cell shows up to 3 chips and a "+N more" overflow.
 */
function MonthGrid({
  monthAnchor,
  shifts,
  currentUserId,
  pendingPickups = [],
  onShiftClick,
}: {
  monthAnchor: Date;
  shifts: TimelineShift[];
  currentUserId?: string | null;
  pendingPickups?: PendingPickup[];
  onShiftClick: (shift: TimelineShift) => void;
}) {
  const cells = useMemo(() => {
    const first = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1);
    const gridStart = startOfWeekMonday(first);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [monthAnchor]);

  const todayKey = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
  }, []);

  const shiftsByDay = useMemo(() => {
    const m = new Map<string, TimelineShift[]>();
    for (const s of shifts) {
      const d = new Date(s.startsAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = m.get(key) ?? [];
      list.push(s);
      m.set(key, list);
    }
    for (const list of m.values()) {
      list.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    }
    return m;
  }, [shifts]);

  const pendingRequestersByShift = useMemo(() => {
    const acc = new Map<string, string[]>();
    for (const p of pendingPickups) {
      const list = acc.get(p.shiftId) ?? [];
      list.push(p.requester.name);
      acc.set(p.shiftId, list);
    }
    const m = new Map<string, string>();
    for (const [shiftId, names] of acc) {
      m.set(shiftId, [...new Set(names)].join(", "));
    }
    return m;
  }, [pendingPickups]);

  const monthIndex = monthAnchor.getMonth();

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="grid grid-cols-7 border-b border-border bg-muted/40 text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {MONTH_WEEKDAY_LABELS.map((l) => (
          <div key={l} className="px-2 py-2">
            {l}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d) => {
          const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
          const inMonth = d.getMonth() === monthIndex;
          const isToday = key === todayKey;
          const list = shiftsByDay.get(key) ?? [];
          const visible = list.slice(0, 3);
          const overflow = list.length - visible.length;
          return (
            <div
              key={key}
              className={
                "min-h-[110px] border-b border-r border-border p-1.5 text-xs " +
                (inMonth ? "bg-background" : "bg-muted/30 text-muted-foreground")
              }
            >
              <div className="mb-1 flex items-center justify-between">
                <span
                  className={
                    "tabular-nums " +
                    (isToday
                      ? "rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold text-primary-foreground"
                      : "text-[11px] font-medium")
                  }
                >
                  {d.getDate()}
                </span>
                {list.length > 0 && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">{list.length}</span>
                )}
              </div>
              <ul className="space-y-1">
                {visible.map((s) => {
                  const mine = currentUserId && s.assignee?.id === currentUserId;
                  const open = !s.assignee && s.status === "PUBLISHED";
                  const booked = Boolean(s.assignee && s.status === "PUBLISHED");
                  const pendingNames = pendingRequestersByShift.get(s.id);
                  const openAwaitingReview = open && pendingNames;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onShiftClick(s)}
                        className={
                          "block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] leading-tight hover:opacity-90 " +
                          (booked && mine
                            ? "ring-1 ring-emerald-600/40"
                            : booked
                              ? "ring-1 ring-sky-600/40 dark:ring-sky-500/35"
                              : openAwaitingReview
                                ? "ring-1 ring-amber-500/50"
                                : "")
                        }
                        style={{
                          backgroundColor: booked
                            ? `${s.site.colorHex}38`
                            : openAwaitingReview
                              ? `${s.site.colorHex}1a`
                              : `${s.site.colorHex}22`,
                          borderLeft: `3px solid ${s.site.colorHex}`,
                        }}
                        title={`${s.site.name} · ${formatShiftTimeRange(s.startsAt, s.endsAt)}${
                          s.assignee
                            ? ` · ${s.assignee.name} (assigned)`
                            : pendingNames
                              ? ` · Open — requested by ${pendingNames}`
                              : " · Open"
                        }`}
                      >
                        <span className="font-medium">
                          {new Date(s.startsAt).toLocaleTimeString(undefined, {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>{" "}
                        <span className="text-muted-foreground">{s.site.name}</span>
                        {mine && booked && (
                          <span className="ml-1 text-[10px] font-semibold text-emerald-800 dark:text-emerald-200">
                            · you
                          </span>
                        )}
                        {!mine && booked && (
                          <span className="ml-1 text-[10px] font-medium text-sky-950 dark:text-sky-100">
                            · {s.assignee?.name ?? "—"}
                          </span>
                        )}
                        {openAwaitingReview && (
                          <span className="ml-1 text-[10px] font-medium text-amber-950 dark:text-amber-100">
                            · {pendingNames}
                          </span>
                        )}
                        {open && !openAwaitingReview && (
                          <span className="ml-1 text-[10px] text-emerald-700 dark:text-emerald-300">· open</span>
                        )}
                      </button>
                    </li>
                  );
                })}
                {overflow > 0 && (
                  <li className="pl-1 text-[10px] text-muted-foreground">+{overflow} more</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slot picker + admin-note helpers
// ---------------------------------------------------------------------------

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/** Format a Date as `HH:MM` for `<input type="time">`. */
function toTimeInputValue(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Combine a calendar day (taken from `anchor`) with an `HH:MM` string into a Date in local time.
 * Returns `null` when the input is malformed.
 */
function combineDateAndTime(anchor: Date, hhmm: string): Date | null {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const out = new Date(anchor);
  out.setHours(h, m, 0, 0);
  return out;
}

/**
 * Booking form for OPEN published shifts. Lets the physician pick a sub-window inside the
 * shift, attach a note to admin, and submit a pickup request that fires the admin
 * notification (webhook + log; email when SHIFTHUB_NOTIFY_WEBHOOK is wired to a mail relay).
 */
function BookingForm({
  shift,
  initialSlot,
  disabled,
  busy,
  onSubmit,
}: {
  shift: TimelineShift;
  initialSlot: SlotPick;
  disabled: boolean;
  busy: boolean;
  onSubmit: (payload: {
    shiftId: string;
    preferredStartsAt?: Date;
    preferredEndsAt?: Date;
    note?: string;
  }) => void;
}) {
  const shiftStart = useMemo(() => new Date(shift.startsAt), [shift.startsAt]);
  const shiftEnd = useMemo(() => new Date(shift.endsAt), [shift.endsAt]);

  const [usePreferred, setUsePreferred] = useState(true);
  const [startStr, setStartStr] = useState(() => toTimeInputValue(initialSlot.slotStart));
  const [endStr, setEndStr] = useState(() => toTimeInputValue(initialSlot.slotEnd));
  const [note, setNote] = useState("");

  const parsed = useMemo(() => {
    if (!usePreferred) return { ok: true as const };
    const s = combineDateAndTime(shiftStart, startStr);
    const e = combineDateAndTime(shiftStart, endStr);
    if (!s || !e) return { ok: false as const, reason: "Pick valid start and end times." };
    if (s < shiftStart || e > shiftEnd) {
      return { ok: false as const, reason: "Preferred window must stay inside the shift." };
    }
    if (e.getTime() - s.getTime() < 15 * 60_000) {
      return { ok: false as const, reason: "Preferred window must be at least 15 minutes." };
    }
    return { ok: true as const, start: s, end: e };
  }, [usePreferred, startStr, endStr, shiftStart, shiftEnd]);

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <p className="text-sm text-muted-foreground">
        Your booking request goes to an admin for approval. The admin is emailed (when configured) with
        your preferred window and note.
      </p>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={usePreferred}
            onChange={(e) => setUsePreferred(e.target.checked)}
          />
          <span>Request a specific sub-window</span>
        </label>
        {usePreferred && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="prefStart" className="text-xs">
                Start
              </Label>
              <Input
                id="prefStart"
                type="time"
                value={startStr}
                onChange={(e) => setStartStr(e.target.value)}
                min={toTimeInputValue(shiftStart)}
                max={toTimeInputValue(shiftEnd)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="prefEnd" className="text-xs">
                End
              </Label>
              <Input
                id="prefEnd"
                type="time"
                value={endStr}
                onChange={(e) => setEndStr(e.target.value)}
                min={toTimeInputValue(shiftStart)}
                max={toTimeInputValue(shiftEnd)}
              />
            </div>
          </div>
        )}
        {usePreferred && parsed.ok === false && (
          <p className="text-xs text-destructive">{parsed.reason}</p>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="bookNote" className="text-xs">
          Note to admin (optional)
        </Label>
        <textarea
          id="bookNote"
          className="min-h-[64px] w-full rounded-md border border-border bg-background p-2 text-sm"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything the admin should know about this pickup."
        />
      </div>

      <Button
        type="button"
        className="w-full sm:w-auto"
        disabled={disabled || (usePreferred && parsed.ok === false)}
        onClick={() => {
          const payload: {
            shiftId: string;
            preferredStartsAt?: Date;
            preferredEndsAt?: Date;
            note?: string;
          } = { shiftId: shift.id };
          const start = usePreferred && parsed.ok ? (parsed as { start?: Date }).start : undefined;
          const end = usePreferred && parsed.ok ? (parsed as { end?: Date }).end : undefined;
          if (start && end) {
            payload.preferredStartsAt = start;
            payload.preferredEndsAt = end;
          }
          const trimmed = note.trim();
          if (trimmed) payload.note = trimmed;
          onSubmit(payload);
        }}
      >
        {busy ? "Submitting…" : "Book shift"}
      </Button>
    </div>
  );
}

/**
 * Generic "send a note to admin about this shift" form. Reuses `shift.addComment` so the
 * message lands in the shift's comment thread (visible in `ShiftDetailPanel`) AND fires
 * the admin notification (webhook + log; email when SHIFTHUB_NOTIFY_WEBHOOK is wired to
 * a mail relay).
 *
 * Optionally lets the user select a sub-slot inside the shift and prepends it to the note,
 * so admin sees both the time and the message in one notification.
 */
function ContactAdminForm({
  shiftId,
  initialSlot,
  shiftStart,
  shiftEnd,
}: {
  shiftId: string;
  initialSlot: SlotPick;
  shiftStart: Date;
  shiftEnd: Date;
}) {
  const notifyAdmin = trpc.shift.notifyAdmin.useMutation();

  const [includeSlot, setIncludeSlot] = useState(true);
  const [startStr, setStartStr] = useState(() => toTimeInputValue(initialSlot.slotStart));
  const [endStr, setEndStr] = useState(() => toTimeInputValue(initialSlot.slotEnd));
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);

  const parsed = useMemo(() => {
    if (!includeSlot) return { ok: true as const };
    const s = combineDateAndTime(shiftStart, startStr);
    const e = combineDateAndTime(shiftStart, endStr);
    if (!s || !e) return { ok: false as const, reason: "Pick valid start and end times." };
    if (s < shiftStart || e > shiftEnd) {
      return { ok: false as const, reason: "Window must stay inside the shift." };
    }
    if (e.getTime() - s.getTime() < 15 * 60_000) {
      return { ok: false as const, reason: "Window must be at least 15 minutes." };
    }
    return { ok: true as const, start: s, end: e };
  }, [includeSlot, startStr, endStr, shiftStart, shiftEnd]);

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Send a note to admin</span>
        {sent && <span className="text-xs text-emerald-700 dark:text-emerald-300">Sent</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Sends a private message to the admin team (email when configured). It is not added to the
        admin comment thread above.
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={includeSlot}
          onChange={(e) => setIncludeSlot(e.target.checked)}
        />
        <span>Reference a specific window</span>
      </label>
      {includeSlot && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="contactStart" className="text-xs">
              Start
            </Label>
            <Input
              id="contactStart"
              type="time"
              value={startStr}
              onChange={(e) => setStartStr(e.target.value)}
              min={toTimeInputValue(shiftStart)}
              max={toTimeInputValue(shiftEnd)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="contactEnd" className="text-xs">
              End
            </Label>
            <Input
              id="contactEnd"
              type="time"
              value={endStr}
              onChange={(e) => setEndStr(e.target.value)}
              min={toTimeInputValue(shiftStart)}
              max={toTimeInputValue(shiftEnd)}
            />
          </div>
        </div>
      )}
      {includeSlot && parsed.ok === false && (
        <p className="text-xs text-destructive">{parsed.reason}</p>
      )}
      <textarea
        className="min-h-[72px] w-full rounded-md border border-border bg-background p-2 text-sm"
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          if (sent) setSent(false);
        }}
        placeholder="Message to the admin team about this shift."
      />
      <Button
        type="button"
        size="sm"
        disabled={
          !note.trim() || notifyAdmin.isPending || (includeSlot && parsed.ok === false)
        }
        onClick={() => {
          const body = note.trim();
          const start = includeSlot && parsed.ok ? (parsed as { start?: Date }).start : undefined;
          const end = includeSlot && parsed.ok ? (parsed as { end?: Date }).end : undefined;
          notifyAdmin.mutate(
            {
              shiftId,
              body,
              preferredStartsAt: start,
              preferredEndsAt: end,
            },
            {
              onSuccess: () => {
                setNote("");
                setSent(true);
              },
            },
          );
        }}
      >
        {notifyAdmin.isPending ? "Sending…" : "Send note to admin"}
      </Button>
    </div>
  );
}
