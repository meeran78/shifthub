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
  type SlotPick,
  type SlotStepMinutes,
  type TimelineShift,
} from "@/components/week-timeline";

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

  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeekMonday(new Date()));
  const [slotStepMinutes, setSlotStepMinutes] = useState<SlotStepMinutes>(15);
  /** Visible calendar window (hours). Shifts are clipped to this range instead of stretching the grid. */
  const [visibleStartHour, setVisibleStartHour] = useState(6);
  const [visibleEndHour, setVisibleEndHour] = useState(20);
  const [selected, setSelected] = useState<{ shift: TimelineShift; slot: SlotPick } | null>(null);
  const [swapTargetId, setSwapTargetId] = useState("");

  const range = useMemo(() => {
    const from = weekAnchor;
    const to = addDays(weekAnchor, 7);
    return { from, to };
  }, [weekAnchor]);

  const utils = trpc.useUtils();
  const versions = trpc.schedule.listVersions.useQuery();
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
    { enabled: !!activeVersionId },
  );

  const shiftIds = useMemo(() => shifts.data?.map((s) => s.id) ?? [], [shifts.data]);

  const pendingPickups = trpc.workflow.pickupRequestsForShifts.useQuery(
    { shiftIds },
    { enabled: shiftIds.length > 0 },
  );

  const mySwaps = trpc.workflow.listMySwapRequests.useQuery(undefined, {
    enabled: Boolean(me.data?.user),
  });

  const myPickups = trpc.workflow.myPickupRequests.useQuery(undefined, {
    enabled: Boolean(me.data?.user),
  });

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
      setSelected(null);
      setSwapTargetId("");
    },
  });

  const acceptSwap = trpc.workflow.acceptSwapCounterparty.useMutation({
    onSuccess: async () => {
      await utils.workflow.listMySwapRequests.invalidate();
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

  const timelineShifts: TimelineShift[] | undefined = useMemo(() => {
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

  const uid = me.data?.user.id;

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-4">
        <div>
          <h1 className="text-2xl font-bold">My schedule</h1>
          <p className="text-sm text-muted-foreground">
            Week view · tap an open slot to book it, or your shift to request a swap
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
            <CardTitle>Week navigation</CardTitle>
            <CardDescription>Move one week at a time. Shifts load from the latest schedule version.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
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
              <Button type="button" variant="secondary" onClick={() => setWeekAnchor(startOfWeekMonday(new Date()))}>
                This week
              </Button>
              <Button type="button" variant="secondary" onClick={() => setWeekAnchor((w) => addDays(w, 7))}>
                Next week
              </Button>
            </div>
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
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="vh0">Day starts at (hour)</Label>
                <Input
                  id="vh0"
                  type="number"
                  min={0}
                  max={22}
                  className="w-32"
                  value={visibleStartHour}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isNaN(v)) return;
                    const s = Math.max(0, Math.min(22, v));
                    setVisibleStartHour(s);
                    if (visibleEndHour <= s) setVisibleEndHour(Math.min(24, s + 1));
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
                  value={visibleEndHour}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isNaN(v)) return;
                    const end = Math.max(1, Math.min(24, v));
                    setVisibleEndHour(end);
                    if (end <= visibleStartHour) setVisibleStartHour(Math.max(0, end - 1));
                  }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Each day is a full 0:00–24:00 column; times outside this window are shaded as blocked. Pickup tiles only
              appear in the open window; long shifts are clipped there while full times stay in details and requests.
            </p>
          </CardContent>
        </Card>

        {myPickups.data?.some((p) => p.status === "DENIED" && p.resolutionNote) && (
          <Card>
            <CardHeader>
              <CardTitle>Recent pickup decisions</CardTitle>
              <CardDescription>Rejected requests include the admin&apos;s note.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {myPickups.data
                ?.filter((p) => p.status === "DENIED" && p.resolutionNote)
                .slice(0, 5)
                .map((p) => (
                  <div key={p.id} className="rounded-md border border-border p-3">
                    <div className="font-medium">{p.shift.site.name}</div>
                    <div className="text-muted-foreground">
                      {formatShiftTimeRange(p.shift.startsAt, p.shift.endsAt)}
                    </div>
                    <div className="mt-1 text-destructive">Rejected: {p.resolutionNote}</div>
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
              <CardTitle>Nothing on this week</CardTitle>
              <CardDescription>
                Try another week, or ask an admin to publish shifts for this period.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {activeVersionId && timelineShifts && timelineShifts.length > 0 && (
          <WeekTimeline
            weekStart={weekAnchor}
            shifts={timelineShifts}
            currentUserId={uid}
            pendingPickups={pendingPickups.data ?? []}
            slotStepMinutes={slotStepMinutes}
            visibleStartHour={visibleStartHour}
            visibleEndHour={visibleEndHour}
            onSlotClick={(shift, slot) => setSelected({ shift, slot })}
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
                  : !selected.shift.assignee && selected.shift.status === "PUBLISHED"
                    ? "Book shift"
                    : "Slot"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {selected.shift.site.name} · {formatShiftTimeRange(selected.shift.startsAt, selected.shift.endsAt)}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Selected slot: {formatShiftTimeRange(selected.slot.slotStart, selected.slot.slotEnd)}
              </p>

              <div className="mt-5 space-y-4">
                {!selected.shift.assignee && selected.shift.status === "PUBLISHED" && (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Your booking request goes to an admin for approval. When approved, this shift appears on your
                      schedule. If this tile is 15–30 minutes, that window is included in the request.
                    </p>
                    <Button
                      type="button"
                      className="w-full sm:w-auto"
                      onClick={() => {
                        const durMin =
                          (selected.slot.slotEnd.getTime() - selected.slot.slotStart.getTime()) / 60000;
                        const payload: { shiftId: string; preferredStartsAt?: Date; preferredEndsAt?: Date } = {
                          shiftId: selected.shift.id,
                        };
                        if (durMin >= 15 && durMin <= 30) {
                          payload.preferredStartsAt = selected.slot.slotStart;
                          payload.preferredEndsAt = selected.slot.slotEnd;
                        }
                        requestPickup.mutate(payload);
                      }}
                      disabled={requestPickup.isPending || !uid}
                    >
                      {requestPickup.isPending ? "Submitting…" : "Book shift"}
                    </Button>
                    {!uid && (
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Finish signing in and profile sync before booking.
                      </p>
                    )}
                  </div>
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

                {uid && selected.shift.assignee && selected.shift.assignee.id !== uid && (
                  <p className="text-sm text-muted-foreground">This slot is assigned to someone else.</p>
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
