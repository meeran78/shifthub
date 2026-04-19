"use client";

import Link from "next/link";
import { trpc } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useMemo, useState } from "react";
import { formatShiftTimeRange } from "@/components/week-timeline";

type ScheduleScope = "day" | "week" | "month" | "year";

type AISuggestion = {
  siteId: string;
  siteName: string;
  startsAt: Date;
  endsAt: Date;
  suggestedAssigneeId: string | null;
  suggestedAssigneeName: string | null;
  reasons: string[];
};

function parseTime(t: string): { h: number; m: number } {
  const [h, m] = t.split(":").map(Number);
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
}

/** Monday 00:00 local */
function startOfWeekMonday(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day + 6) % 7;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function buildShiftRange(
  scope: ScheduleScope,
  opts: {
    dayDate: string;
    monthValue: string;
    yearValue: number;
    startTime: string;
    endTime: string;
  },
): { startsAt: Date; endsAt: Date } | { error: string } {
  const { h: sh, m: sm } = parseTime(opts.startTime);
  const { h: eh, m: em } = parseTime(opts.endTime);

  if (scope === "day") {
    const [y, mo, d] = opts.dayDate.split("-").map(Number);
    if (!y || !mo || !d) return { error: "Pick a date." };
    const startsAt = new Date(y, mo - 1, d, sh, sm, 0, 0);
    const endsAt = new Date(y, mo - 1, d, eh, em, 0, 0);
    if (endsAt.getTime() <= startsAt.getTime()) return { error: "End time must be after start time." };
    return { startsAt, endsAt };
  }

  if (scope === "week") {
    const [y, mo, d] = opts.dayDate.split("-").map(Number);
    if (!y || !mo || !d) return { error: "Pick a date in the week." };
    const anchor = new Date(y, mo - 1, d);
    const mon = startOfWeekMonday(anchor);
    const sun = new Date(mon);
    sun.setDate(sun.getDate() + 6);
    const startsAt = new Date(mon);
    startsAt.setHours(sh, sm, 0, 0);
    const endsAt = new Date(sun);
    endsAt.setHours(eh, em, 0, 0);
    if (endsAt.getTime() <= startsAt.getTime()) return { error: "End time must be after start time (same week)." };
    return { startsAt, endsAt };
  }

  if (scope === "month") {
    const parts = opts.monthValue.split("-").map(Number);
    const y = parts[0];
    const mo = parts[1];
    if (!y || !mo) return { error: "Pick a month." };
    const first = new Date(y, mo - 1, 1);
    const last = new Date(y, mo, 0);
    const startsAt = new Date(first);
    startsAt.setHours(sh, sm, 0, 0);
    const endsAt = new Date(last);
    endsAt.setHours(eh, em, 0, 0);
    if (endsAt.getTime() <= startsAt.getTime()) return { error: "End time must be after start time in that month." };
    return { startsAt, endsAt };
  }

  const y = opts.yearValue;
  if (!Number.isFinite(y) || y < 2000 || y > 2100) return { error: "Enter a valid year (2000–2100)." };
  const first = new Date(y, 0, 1);
  const last = new Date(y, 11, 31);
  const startsAt = new Date(first);
  startsAt.setHours(sh, sm, 0, 0);
  const endsAt = new Date(last);
  endsAt.setHours(eh, em, 0, 0);
  if (endsAt.getTime() <= startsAt.getTime()) return { error: "End time must be after start time in that year." };
  return { startsAt, endsAt };
}

export default function AdminPage() {
  const utils = trpc.useUtils();
  const me = trpc.user.me.useQuery();
  const versions = trpc.schedule.listVersions.useQuery();
  const sites = trpc.site.list.useQuery();
  const createVersion = trpc.schedule.createVersion.useMutation();
  const publishVersion = trpc.schedule.publishVersion.useMutation();
  const createShift = trpc.shift.create.useMutation();

  const isAdmin = me.data?.user.role === "ADMIN";
  const pendingPickups = trpc.workflow.listPendingPickups.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const recentPickupDecisions = trpc.workflow.listRecentPickupDecisions.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const pendingSwaps = trpc.workflow.listPendingSwaps.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const pendingPickupCount = pendingPickups.data?.length ?? 0;
  const pendingSwapCount = pendingSwaps.data?.length ?? 0;
  const pendingApprovalTotal = pendingPickupCount + pendingSwapCount;
  const approvePickup = trpc.workflow.approvePickup.useMutation({
    onSuccess: async () => {
      await pendingPickups.refetch();
      await recentPickupDecisions.refetch();
      await utils.shift.list.invalidate();
    },
  });
  const denyPickup = trpc.workflow.denyPickup.useMutation({
    onSuccess: async () => {
      await pendingPickups.refetch();
      await recentPickupDecisions.refetch();
    },
  });
  const approveSwap = trpc.workflow.approveSwapAdmin.useMutation({
    onSuccess: async () => {
      await pendingSwaps.refetch();
      await utils.shift.list.invalidate();
    },
  });
  const denySwap = trpc.workflow.denySwapAdmin.useMutation({
    onSuccess: async () => {
      await pendingSwaps.refetch();
    },
  });

  const [label, setLabel] = useState("FY Draft");
  const [year, setYear] = useState(new Date().getFullYear());
  /** Multi-site scheduling: shift form creates one shift per selected site. */
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([]);
  const [forceConflicts, setForceConflicts] = useState(false);
  const [versionId, setVersionId] = useState("");

  const [scheduleScope, setScheduleScope] = useState<ScheduleScope>("day");
  const [dayDate, setDayDate] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });
  const [monthValue, setMonthValue] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [yearValue, setYearValue] = useState(() => new Date().getFullYear());
  const [startTime, setStartTime] = useState("07:00");
  const [endTime, setEndTime] = useState("17:00");

  const rangePreview = useMemo(() => {
    return buildShiftRange(scheduleScope, {
      dayDate,
      monthValue,
      yearValue,
      startTime,
      endTime,
    });
  }, [scheduleScope, dayDate, monthValue, yearValue, startTime, endTime]);

  const [pickupDenyNotes, setPickupDenyNotes] = useState<Record<string, string>>({});
  const [pickupApproveNotes, setPickupApproveNotes] = useState<Record<string, string>>({});
  const [swapDenyNotes, setSwapDenyNotes] = useState<Record<string, string>>({});

  // AI-assisted scheduling state
  const [aiStartHour, setAiStartHour] = useState(7);
  const [aiEndHour, setAiEndHour] = useState(17);
  const [aiDurationHours, setAiDurationHours] = useState(8);
  const [aiDaysOfWeek, setAiDaysOfWeek] = useState<number[]>([1, 2, 3, 4, 5]);
  const [aiSuggestions, setAiSuggestions] = useState<AISuggestion[]>([]);
  const [aiSelected, setAiSelected] = useState<Set<number>>(new Set());
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const suggestSchedule = trpc.ai.suggestSchedule.useMutation();

  /** Default chip toggle: pre-select first site once they load (kept compatible with the old single-site flow). */
  useEffect(() => {
    if (selectedSiteIds.length === 0 && sites.data && sites.data.length > 0) {
      setSelectedSiteIds([sites.data[0]!.id]);
    }
  }, [sites.data, selectedSiteIds.length]);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold">Admin</h1>
            {isAdmin && pendingApprovalTotal > 0 && (
              <span
                className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary"
                title="Physician shift requests and swaps awaiting your action"
              >
                {pendingApprovalTotal} pending{" "}
                {pendingApprovalTotal === 1 ? "approval" : "approvals"}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">Create schedules and publish when ready</p>
        </div>
        <div className="flex items-center gap-3">
          <Button asChild variant="outline">
            <Link href="/schedule">Schedule</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 p-4">
        {!isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle>Admin access required</CardTitle>
              <CardDescription>
                Roles are stored only in the database (Neon), not in Clerk. Clerk is for sign-in only. Grant{" "}
                <strong>ADMIN</strong> using one of the options below, then open{" "}
                <Link href="/schedule" className="text-primary underline">
                  Schedule
                </Link>{" "}
                once so your profile sync runs again.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                <strong className="text-foreground">Option A — env allowlist (dev):</strong> In your repo{" "}
                <code className="rounded bg-muted px-1">.env.local</code>, set{" "}
                <code className="rounded bg-muted px-1">ADMIN_EMAILS=you@yourdomain.com</code> (comma-separated for
                multiple). Restart <code className="rounded bg-muted px-1">pnpm dev</code>, then visit{" "}
                <Link href="/schedule" className="text-primary underline">
                  Schedule
                </Link>
                .
              </p>
              <p>
                <strong className="text-foreground">Option B — database:</strong> Run{" "}
                <code className="rounded bg-muted px-1">pnpm db:studio</code> and set{" "}
                <code className="rounded bg-muted px-1">User.role</code> to{" "}
                <code className="rounded bg-muted px-1">ADMIN</code> for your row (or use a SQL migration in production).
              </p>
            </CardContent>
          </Card>
        )}

        {isAdmin && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Physician slot requests</CardTitle>
                <CardDescription>
                  Open-shift pickup requests from physicians. Each row shows their selected time window and any note
                  they left. You can approve with an optional message to the physician, or reject with a required
                  explanation. This list refreshes automatically. Set{" "}
                  <code className="rounded bg-muted px-1">OrgSettings.adminNotificationEmail</code> for email alerts.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {pendingPickups.isError && (
                  <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
                    <p className="font-medium">Could not load pickup requests</p>
                    <p className="mt-1 text-xs opacity-90">{pendingPickups.error.message}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      If this mentions a missing column (e.g. <code className="rounded bg-muted px-1">requesterNote</code>
                      ), run{" "}
                      <code className="rounded bg-muted px-1">
                        pnpm --filter @shifthub/db exec prisma migrate deploy
                      </code>{" "}
                      against your database.
                    </p>
                  </div>
                )}
                {!pendingPickups.isError && pendingPickups.isLoading && (
                  <p className="text-sm text-muted-foreground">Loading pickup requests…</p>
                )}
                {!pendingPickups.isError && !pendingPickups.isLoading && !pendingPickups.data?.length && (
                  <p className="text-sm text-muted-foreground">No pending pickup requests.</p>
                )}
                {!pendingPickups.isError && pendingPickups.data?.map((p) => (
                  <div
                    key={p.id}
                    className="space-y-2 rounded-md border border-border p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        Requested{" "}
                        {new Date(p.createdAt).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </span>
                      {p.competingPickupCount > 0 && (
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300">
                          {p.competingPickupCount} other pending on this shift
                        </span>
                      )}
                    </div>
                    <div className="font-medium">{p.requester.name}</div>
                    <div className="text-muted-foreground">
                      {p.requester.email} · {p.requester.role}
                    </div>
                    <div>{p.shift.site.name}</div>
                    <div className="text-muted-foreground">
                      Full shift: {formatShiftTimeRange(p.shift.startsAt, p.shift.endsAt)}
                    </div>
                    <div
                      className={
                        p.preferredStartsAt && p.preferredEndsAt
                          ? "rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-foreground"
                          : "text-xs italic text-muted-foreground"
                      }
                    >
                      {p.preferredStartsAt && p.preferredEndsAt ? (
                        <>
                          <span className="text-xs font-semibold uppercase tracking-wide text-primary">
                            Physician selected slot
                          </span>
                          <div className="font-medium">
                            {formatShiftTimeRange(p.preferredStartsAt, p.preferredEndsAt)}
                          </div>
                        </>
                      ) : (
                        <>Physician requested the full shift (no sub-window selected).</>
                      )}
                    </div>
                    <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Physician comment
                      </div>
                      {p.requesterNote ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{p.requesterNote}</p>
                      ) : (
                        <p className="mt-1 text-xs italic text-muted-foreground">No comment from physician.</p>
                      )}
                    </div>
                    <PickupConflictWarning requestId={p.id} />
                    <div className="space-y-2 border-t border-border pt-3">
                      <Label htmlFor={`approve-${p.id}`}>Optional message to physician (on approve)</Label>
                      <textarea
                        id={`approve-${p.id}`}
                        className="min-h-[72px] w-full rounded-md border border-border bg-background p-2 text-sm"
                        value={pickupApproveNotes[p.id] ?? ""}
                        onChange={(e) =>
                          setPickupApproveNotes((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        placeholder="E.g. coverage details, parking, or confirmation — sent with the approval notification."
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          approvePickup.mutate(
                            {
                              requestId: p.id,
                              adminNote: pickupApproveNotes[p.id]?.trim() || undefined,
                            },
                            {
                              onSuccess: () => {
                                setPickupApproveNotes((prev) => {
                                  const next = { ...prev };
                                  delete next[p.id];
                                  return next;
                                });
                              },
                            },
                          )
                        }
                        disabled={approvePickup.isPending}
                      >
                        {approvePickup.isPending ? "Approving…" : "Approve & assign shift"}
                      </Button>
                    </div>
                    <div className="space-y-2 border-t border-border pt-3">
                      <Label htmlFor={`reject-${p.id}`}>Rejection comment (required)</Label>
                      <textarea
                        id={`reject-${p.id}`}
                        className="min-h-[72px] w-full rounded-md border border-border bg-background p-2 text-sm"
                        value={pickupDenyNotes[p.id] ?? ""}
                        onChange={(e) =>
                          setPickupDenyNotes((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        placeholder="Explain why this pickup cannot be approved — the physician receives this message."
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-destructive text-destructive hover:bg-destructive/10"
                        disabled={denyPickup.isPending || !(pickupDenyNotes[p.id]?.trim())}
                        onClick={() => {
                          const note = pickupDenyNotes[p.id]?.trim();
                          if (!note) return;
                          denyPickup.mutate(
                            { requestId: p.id, note },
                            {
                              onSuccess: () => {
                                setPickupDenyNotes((prev) => {
                                  const next = { ...prev };
                                  delete next[p.id];
                                  return next;
                                });
                              },
                            },
                          );
                        }}
                      >
                        {denyPickup.isPending ? "Rejecting…" : "Reject request"}
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent slot request decisions</CardTitle>
                <CardDescription>
                  Last 25 approved or rejected pickup requests, including physician notes and your comments.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {recentPickupDecisions.isError && (
                  <p className="text-sm text-destructive">{recentPickupDecisions.error.message}</p>
                )}
                {!recentPickupDecisions.isError && recentPickupDecisions.isLoading && (
                  <p className="text-sm text-muted-foreground">Loading history…</p>
                )}
                {!recentPickupDecisions.isError &&
                  !recentPickupDecisions.isLoading &&
                  !recentPickupDecisions.data?.length && (
                    <p className="text-sm text-muted-foreground">No recent decisions yet.</p>
                  )}
                {!recentPickupDecisions.isError &&
                  recentPickupDecisions.data?.map((r) => (
                    <div
                      key={r.id}
                      className="space-y-2 rounded-md border border-border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={
                            r.status === "APPROVED"
                              ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:text-emerald-200"
                              : "rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
                          }
                        >
                          {r.status === "APPROVED" ? "Approved" : "Rejected"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {r.resolvedAt
                            ? new Date(r.resolvedAt).toLocaleString(undefined, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              })
                            : ""}
                        </span>
                      </div>
                      <div className="font-medium">{r.requester.name}</div>
                      <div className="text-muted-foreground">
                        {r.shift.site.name} · {formatShiftTimeRange(r.shift.startsAt, r.shift.endsAt)}
                      </div>
                      {r.preferredStartsAt && r.preferredEndsAt && (
                        <div className="text-xs text-muted-foreground">
                          Requested window:{" "}
                          <span className="font-medium text-foreground">
                            {formatShiftTimeRange(r.preferredStartsAt, r.preferredEndsAt)}
                          </span>
                        </div>
                      )}
                      <div className="rounded-md bg-muted/50 px-2 py-1.5 text-xs">
                        <span className="font-semibold text-muted-foreground">Physician: </span>
                        {r.requesterNote ? (
                          <span className="whitespace-pre-wrap text-foreground">{r.requesterNote}</span>
                        ) : (
                          <span className="italic text-muted-foreground">—</span>
                        )}
                      </div>
                      {r.status === "APPROVED" && r.adminApprovalNote && (
                        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5 text-xs">
                          <span className="font-semibold text-emerald-900 dark:text-emerald-200">
                            Admin (approve):{" "}
                          </span>
                          <span className="whitespace-pre-wrap">{r.adminApprovalNote}</span>
                        </div>
                      )}
                      {r.status === "DENIED" && r.resolutionNote && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs">
                          <span className="font-semibold text-destructive">Admin (reject): </span>
                          <span className="whitespace-pre-wrap">{r.resolutionNote}</span>
                        </div>
                      )}
                    </div>
                  ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Shift swap pipeline</CardTitle>
                <CardDescription>
                  Swaps awaiting the other physician appear first; after they accept, you can approve or reject (rejection
                  requires a note). New swap requests also notify the admin email when configured.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {pendingSwaps.isError && (
                  <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
                    <p className="font-medium">Could not load swap requests</p>
                    <p className="mt-1 text-xs opacity-90">{pendingSwaps.error.message}</p>
                  </div>
                )}
                {!pendingSwaps.isError && pendingSwaps.isLoading && (
                  <p className="text-sm text-muted-foreground">Loading swap requests…</p>
                )}
                {!pendingSwaps.isError && !pendingSwaps.isLoading && !pendingSwaps.data?.length && (
                  <p className="text-sm text-muted-foreground">No active swap requests.</p>
                )}
                {!pendingSwaps.isError && pendingSwaps.data?.map((s) => {
                  const awaitingCounterparty = s.status === "PENDING_COUNTERPARTY";
                  const awaitingAdmin = s.status === "PENDING_ADMIN";
                  return (
                    <div key={s.id} className="space-y-2 rounded-md border border-border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {s.userA.name} ↔ {s.userB.name}
                        </span>
                        {awaitingCounterparty && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                            Awaiting {s.userB.name} to accept
                          </span>
                        )}
                        {awaitingAdmin && (
                          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                            Ready for your approval
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Requester (offering shift A): {s.userA.name} · Counterparty (shift B): {s.userB.name}
                      </p>
                      <div className="text-muted-foreground">
                        A: {s.shiftA.site.name} · {formatShiftTimeRange(s.shiftA.startsAt, s.shiftA.endsAt)}
                      </div>
                      <div className="text-muted-foreground">
                        B: {s.shiftB.site.name} · {formatShiftTimeRange(s.shiftB.startsAt, s.shiftB.endsAt)}
                      </div>
                      {awaitingAdmin && (
                        <SwapConflictWarning swapId={s.id} userAName={s.userA.name} userBName={s.userB.name} />
                      )}
                      {awaitingAdmin && (
                        <>
                          <div className="flex flex-wrap gap-2 pt-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => approveSwap.mutate({ swapId: s.id })}
                              disabled={approveSwap.isPending}
                            >
                              Approve swap
                            </Button>
                          </div>
                          <div className="space-y-1 pt-2">
                            <Label htmlFor={`swap-reject-${s.id}`}>Rejection note (required to reject)</Label>
                            <Input
                              id={`swap-reject-${s.id}`}
                              value={swapDenyNotes[s.id] ?? ""}
                              onChange={(e) =>
                                setSwapDenyNotes((prev) => ({ ...prev, [s.id]: e.target.value }))
                              }
                              placeholder="Explain why this swap cannot be approved"
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="border-destructive text-destructive hover:bg-destructive/10"
                              disabled={denySwap.isPending || !(swapDenyNotes[s.id]?.trim())}
                              onClick={() => {
                                const note = swapDenyNotes[s.id]?.trim();
                                if (!note) return;
                                denySwap.mutate(
                                  { swapId: s.id, note },
                                  {
                                    onSuccess: () => {
                                      setSwapDenyNotes((prev) => {
                                        const next = { ...prev };
                                        delete next[s.id];
                                        return next;
                                      });
                                    },
                                  },
                                );
                              }}
                            >
                              Reject swap
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Schedule versions</CardTitle>
                <CardDescription>Create a draft year, add shifts, then publish for the group.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="lbl">Label</Label>
                    <Input id="lbl" value={label} onChange={(e) => setLabel(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="yr">Year</Label>
                    <Input
                      id="yr"
                      type="number"
                      value={year}
                      onChange={(e) => setYear(Number(e.target.value))}
                    />
                  </div>
                </div>
                <Button
                  type="button"
                  onClick={() =>
                    createVersion.mutate(
                      { label, year },
                      {
                        onSuccess: (v) => {
                          setVersionId(v.id);
                          void versions.refetch();
                        },
                      },
                    )
                  }
                >
                  Create draft version
                </Button>
                <div className="space-y-2">
                  <Label>Existing versions</Label>
                  <ul className="rounded-md border border-border divide-y">
                    {versions.data?.map((v) => {
                      const published = v.status === "PUBLISHED";
                      const shiftCount = v._count?.shifts ?? 0;
                      return (
                        <li key={v.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{v.label}</span>
                              <span
                                className={
                                  published
                                    ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-700 dark:text-emerald-300"
                                    : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground"
                                }
                              >
                                {published ? "Published" : "Draft"}
                              </span>
                              <span className="text-xs text-muted-foreground">{v.year}</span>
                              <span className="text-xs text-muted-foreground">·</span>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {shiftCount} shift{shiftCount === 1 ? "" : "s"}
                              </span>
                            </div>
                            <div className="text-[10px] text-muted-foreground">id: {v.id}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setVersionId(v.id)}
                            >
                              Use in form
                            </Button>
                            {!published && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  publishVersion.mutate(
                                    { id: v.id },
                                    { onSuccess: () => versions.refetch() },
                                  )
                                }
                                disabled={publishVersion.isPending}
                              >
                                Publish
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Schedule a shift</CardTitle>
                <CardDescription>
                  Choose a scope—day, week, month, or year—then set start and end times. One shift
                  record is created spanning that period (same site and version).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="ver">Schedule version id</Label>
                  <Input
                    id="ver"
                    placeholder="Paste version id or create one above"
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Site(s) — multi-site</Label>
                  <div className="flex flex-wrap gap-1">
                    {(sites.data ?? []).map((s) => {
                      const active = selectedSiteIds.includes(s.id);
                      return (
                        <Button
                          key={s.id}
                          type="button"
                          size="sm"
                          variant={active ? "default" : "outline"}
                          onClick={() =>
                            setSelectedSiteIds((prev) =>
                              prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id],
                            )
                          }
                          style={
                            active
                              ? { borderColor: s.colorHex, backgroundColor: `${s.colorHex}33` }
                              : undefined
                          }
                        >
                          <span
                            className="mr-1 inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: s.colorHex }}
                          />
                          {s.name}
                        </Button>
                      );
                    })}
                    {selectedSiteIds.length > 0 && (
                      <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedSiteIds([])}>
                        Clear
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Pick one or more sites. One shift will be created per selected site for the same time window.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="scope">Scope</Label>
                  <select
                    id="scope"
                    className="flex h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                    value={scheduleScope}
                    onChange={(e) => setScheduleScope(e.target.value as ScheduleScope)}
                  >
                    <option value="day">Day — single calendar day</option>
                    <option value="week">Week — Mon–Sun week containing the date</option>
                    <option value="month">Month — first through last day of month</option>
                    <option value="year">Year — Jan 1 through Dec 31</option>
                  </select>
                </div>

                {scheduleScope === "day" && (
                  <div className="space-y-2">
                    <Label htmlFor="dayDate">Date</Label>
                    <Input id="dayDate" type="date" value={dayDate} onChange={(e) => setDayDate(e.target.value)} />
                  </div>
                )}

                {scheduleScope === "week" && (
                  <div className="space-y-2">
                    <Label htmlFor="weekDate">Week containing</Label>
                    <Input id="weekDate" type="date" value={dayDate} onChange={(e) => setDayDate(e.target.value)} />
                    <p className="text-xs text-muted-foreground">Uses Monday–Sunday in your local timezone.</p>
                  </div>
                )}

                {scheduleScope === "month" && (
                  <div className="space-y-2">
                    <Label htmlFor="month">Month</Label>
                    <Input
                      id="month"
                      type="month"
                      value={monthValue}
                      onChange={(e) => setMonthValue(e.target.value)}
                    />
                  </div>
                )}

                {scheduleScope === "year" && (
                  <div className="space-y-2">
                    <Label htmlFor="yrOnly">Year</Label>
                    <Input
                      id="yrOnly"
                      type="number"
                      min={2000}
                      max={2100}
                      value={yearValue}
                      onChange={(e) => setYearValue(Number(e.target.value))}
                    />
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="t0">Start time</Label>
                    <Input id="t0" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="t1">End time</Label>
                    <Input id="t1" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                  </div>
                </div>

                {"error" in rangePreview ? (
                  <p className="text-sm text-destructive">{rangePreview.error}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Preview:{" "}
                    <span className="font-medium text-foreground">
                      {rangePreview.startsAt.toLocaleString()} → {rangePreview.endsAt.toLocaleString()}
                    </span>
                  </p>
                )}

                {!("error" in rangePreview) && selectedSiteIds.length > 0 && (
                  <ConflictPreview
                    startsAt={rangePreview.startsAt}
                    endsAt={rangePreview.endsAt}
                    siteIds={selectedSiteIds}
                    sites={sites.data ?? []}
                  />
                )}

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={forceConflicts}
                    onChange={(e) => setForceConflicts(e.target.checked)}
                  />
                  <span>Override conflicts (create anyway)</span>
                </label>

                <Button
                  type="button"
                  disabled={
                    !versionId ||
                    selectedSiteIds.length === 0 ||
                    "error" in rangePreview ||
                    createShift.isPending
                  }
                  onClick={async () => {
                    const r = buildShiftRange(scheduleScope, {
                      dayDate,
                      monthValue,
                      yearValue,
                      startTime,
                      endTime,
                    });
                    if ("error" in r) return;
                    let created = 0;
                    let blocked = 0;
                    let failed = 0;
                    for (const sid of selectedSiteIds) {
                      try {
                        await createShift.mutateAsync({
                          scheduleVersionId: versionId,
                          siteId: sid,
                          coverageCategory: "INPATIENT_HOSPITAL",
                          inpatientSplit: "DAY",
                          startsAt: r.startsAt,
                          endsAt: r.endsAt,
                          assigneeId: null,
                          status: "DRAFT",
                          force: forceConflicts,
                        });
                        created += 1;
                      } catch (err) {
                        const code = (err as { data?: { code?: string } })?.data?.code;
                        if (code === "CONFLICT") blocked += 1;
                        else failed += 1;
                      }
                    }
                    await utils.shift.list.invalidate();
                    alert(
                      `Created ${created} of ${selectedSiteIds.length} shift(s)` +
                        (blocked > 0 ? ` · ${blocked} blocked by conflict (toggle Override to force)` : "") +
                        (failed > 0 ? ` · ${failed} failed` : ""),
                    );
                  }}
                >
                  {createShift.isPending
                    ? "Creating…"
                    : `Create ${selectedSiteIds.length || ""} shift${selectedSiteIds.length === 1 ? "" : "s"}`.trim()}
                </Button>

                <div className="space-y-3 rounded-md border border-dashed border-border p-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">AI-assisted scheduling</Label>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      heuristic · time-off + conflict aware
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Generates conflict-free draft shifts across the picked sites within the date/scope above. Each
                    suggestion is balanced toward the lightest-loaded eligible person; uncovered slots come back as Open.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="ai-start">Day starts at (hour)</Label>
                      <Input
                        id="ai-start"
                        type="number"
                        min={0}
                        max={22}
                        value={aiStartHour}
                        onChange={(e) => setAiStartHour(Number(e.target.value))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="ai-end">Day ends at (hour)</Label>
                      <Input
                        id="ai-end"
                        type="number"
                        min={1}
                        max={24}
                        value={aiEndHour}
                        onChange={(e) => setAiEndHour(Number(e.target.value))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="ai-dur">Shift hours</Label>
                      <Input
                        id="ai-dur"
                        type="number"
                        min={1}
                        max={24}
                        value={aiDurationHours}
                        onChange={(e) => setAiDurationHours(Number(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-muted-foreground">Days:</span>
                    {[
                      { d: 1, l: "Mon" },
                      { d: 2, l: "Tue" },
                      { d: 3, l: "Wed" },
                      { d: 4, l: "Thu" },
                      { d: 5, l: "Fri" },
                      { d: 6, l: "Sat" },
                      { d: 0, l: "Sun" },
                    ].map(({ d, l }) => {
                      const active = aiDaysOfWeek.includes(d);
                      return (
                        <Button
                          key={d}
                          type="button"
                          size="sm"
                          variant={active ? "default" : "outline"}
                          onClick={() =>
                            setAiDaysOfWeek((prev) =>
                              prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
                            )
                          }
                        >
                          {l}
                        </Button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        !versionId ||
                        selectedSiteIds.length === 0 ||
                        "error" in rangePreview ||
                        aiBusy ||
                        suggestSchedule.isPending
                      }
                      onClick={async () => {
                        const r = buildShiftRange(scheduleScope, {
                          dayDate,
                          monthValue,
                          yearValue,
                          startTime,
                          endTime,
                        });
                        if ("error" in r) return;
                        setAiBusy(true);
                        setAiError(null);
                        setAiSuggestions([]);
                        setAiSelected(new Set());
                        try {
                          const result = await suggestSchedule.mutateAsync({
                            scheduleVersionId: versionId,
                            siteIds: selectedSiteIds,
                            from: r.startsAt,
                            to: r.endsAt,
                            startHour: Math.max(0, Math.min(23, aiStartHour)),
                            endHour: Math.max(1, Math.min(24, aiEndHour)),
                            durationMinutes: Math.max(30, aiDurationHours * 60),
                            daysOfWeek: aiDaysOfWeek.length === 0 ? undefined : aiDaysOfWeek,
                          });
                          const items = result.suggestions.map((s) => ({
                            ...s,
                            startsAt: new Date(s.startsAt),
                            endsAt: new Date(s.endsAt),
                          }));
                          setAiSuggestions(items);
                          setAiSelected(new Set(items.map((_, i) => i)));
                        } catch (err) {
                          setAiError((err as Error).message ?? "Failed to suggest");
                        } finally {
                          setAiBusy(false);
                        }
                      }}
                    >
                      {aiBusy || suggestSchedule.isPending ? "Suggesting…" : "Suggest shifts"}
                    </Button>
                    {aiSuggestions.length > 0 && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setAiSelected(
                              aiSelected.size === aiSuggestions.length
                                ? new Set()
                                : new Set(aiSuggestions.map((_, i) => i)),
                            )
                          }
                        >
                          {aiSelected.size === aiSuggestions.length ? "Deselect all" : "Select all"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={aiSelected.size === 0 || createShift.isPending}
                          onClick={async () => {
                            let created = 0;
                            let blocked = 0;
                            let failed = 0;
                            for (const idx of Array.from(aiSelected).sort()) {
                              const s = aiSuggestions[idx];
                              if (!s) continue;
                              try {
                                await createShift.mutateAsync({
                                  scheduleVersionId: versionId,
                                  siteId: s.siteId,
                                  coverageCategory: "INPATIENT_HOSPITAL",
                                  inpatientSplit: "DAY",
                                  startsAt: s.startsAt,
                                  endsAt: s.endsAt,
                                  assigneeId: s.suggestedAssigneeId ?? null,
                                  status: "DRAFT",
                                  // AI suggestions are pre-filtered for site/assignee conflicts, but pass force only when
                                  // admin explicitly toggled the override (so unexpected conflicts still surface).
                                  force: forceConflicts,
                                });
                                created += 1;
                              } catch (err) {
                                const code = (err as { data?: { code?: string } })?.data?.code;
                                if (code === "CONFLICT") blocked += 1;
                                else failed += 1;
                              }
                            }
                            await utils.shift.list.invalidate();
                            setAiSuggestions([]);
                            setAiSelected(new Set());
                            alert(
                              `AI: created ${created}` +
                                (blocked > 0 ? ` · ${blocked} blocked by conflict` : "") +
                                (failed > 0 ? ` · ${failed} failed` : ""),
                            );
                          }}
                        >
                          Create selected ({aiSelected.size})
                        </Button>
                      </>
                    )}
                  </div>
                  {aiError && <p className="text-xs text-destructive">{aiError}</p>}
                  {aiSuggestions.length > 0 && (
                    <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                      <ul className="divide-y text-xs">
                        {aiSuggestions.map((s, i) => {
                          const active = aiSelected.has(i);
                          return (
                            <li key={`${s.siteId}-${s.startsAt.toISOString()}-${i}`} className="flex items-start gap-2 p-2">
                              <input
                                type="checkbox"
                                className="mt-1 h-4 w-4"
                                checked={active}
                                onChange={() =>
                                  setAiSelected((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(i)) next.delete(i);
                                    else next.add(i);
                                    return next;
                                  })
                                }
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium">{s.siteName}</span>
                                  <span className="text-muted-foreground">
                                    {formatShiftTimeRange(s.startsAt, s.endsAt)}
                                  </span>
                                  <span
                                    className={
                                      s.suggestedAssigneeName
                                        ? "rounded bg-primary/10 px-1.5 py-0.5 text-primary"
                                        : "rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                                    }
                                  >
                                    {s.suggestedAssigneeName ?? "Open"}
                                  </span>
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {s.reasons.join(" · ")}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

/** Inline conflict preview shown under the "Schedule a shift" form. */
function ConflictPreview({
  startsAt,
  endsAt,
  siteIds,
  sites,
}: {
  startsAt: Date;
  endsAt: Date;
  siteIds: string[];
  sites: Array<{ id: string; name: string; colorHex: string }>;
}) {
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/30 p-2 text-xs">
      <div className="font-medium text-foreground">Cross-site conflict check</div>
      {siteIds.map((sid) => {
        const site = sites.find((x) => x.id === sid);
        return (
          <PerSiteConflictRow
            key={sid}
            siteId={sid}
            siteName={site?.name ?? sid}
            colorHex={site?.colorHex ?? "#888"}
            startsAt={startsAt}
            endsAt={endsAt}
          />
        );
      })}
    </div>
  );
}

function PerSiteConflictRow({
  siteId,
  siteName,
  colorHex,
  startsAt,
  endsAt,
}: {
  siteId: string;
  siteName: string;
  colorHex: string;
  startsAt: Date;
  endsAt: Date;
}) {
  const q = trpc.shift.findConflicts.useQuery(
    { siteId, startsAt, endsAt },
    { staleTime: 5_000 },
  );
  const data = q.data;
  return (
    <div className="flex items-start gap-2">
      <span
        className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full"
        style={{ backgroundColor: colorHex }}
      />
      <div className="flex-1">
        <span className="font-medium">{siteName}:</span>{" "}
        {q.isLoading ? (
          <span className="text-muted-foreground">checking…</span>
        ) : !data || (data.siteConflicts.length === 0 && data.assigneeConflicts.length === 0) ? (
          <span className="text-emerald-700 dark:text-emerald-300">no conflicts</span>
        ) : (
          <span className="text-amber-700 dark:text-amber-300">{data.summary}</span>
        )}
        {data && data.siteConflicts.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-[10px] text-muted-foreground">
            {data.siteConflicts.slice(0, 3).map((c) => (
              <li key={c.id}>
                {formatShiftTimeRange(c.startsAt, c.endsAt)}{" "}
                {c.assignee?.name ? `· ${c.assignee.name}` : "· Open"}
              </li>
            ))}
            {data.siteConflicts.length > 3 && (
              <li>+{data.siteConflicts.length - 3} more…</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Shows assignee-conflict warning before approving a pickup (cross-site). */
function PickupConflictWarning({ requestId }: { requestId: string }) {
  const q = trpc.workflow.checkPickupConflict.useQuery(
    { requestId },
    { staleTime: 10_000 },
  );
  if (!q.data) return null;
  if (q.data.assigneeConflicts.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-400/60 bg-amber-400/10 p-2 text-xs">
      <div className="font-medium text-amber-800 dark:text-amber-200">
        Assignee already has {q.data.assigneeConflicts.length} overlapping shift
        {q.data.assigneeConflicts.length === 1 ? "" : "s"}
      </div>
      <ul className="mt-1 list-disc pl-4 text-amber-800/90 dark:text-amber-200/90">
        {q.data.assigneeConflicts.slice(0, 3).map((c) => (
          <li key={c.id}>
            {c.site.name} · {formatShiftTimeRange(c.startsAt, c.endsAt)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Shows post-swap conflict warning for both parties. */
function SwapConflictWarning({
  swapId,
  userAName,
  userBName,
}: {
  swapId: string;
  userAName: string;
  userBName: string;
}) {
  const q = trpc.workflow.checkSwapConflict.useQuery({ swapId }, { staleTime: 10_000 });
  if (!q.data || !q.data.anyConflict) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-400/60 bg-amber-400/10 p-2 text-xs">
      {q.data.forUserB.assigneeConflicts.length > 0 && (
        <div className="text-amber-800 dark:text-amber-200">
          <strong>{userBName}</strong> would clash with{" "}
          {q.data.forUserB.assigneeConflicts.length} other shift
          {q.data.forUserB.assigneeConflicts.length === 1 ? "" : "s"} after swap.
        </div>
      )}
      {q.data.forUserA.assigneeConflicts.length > 0 && (
        <div className="text-amber-800 dark:text-amber-200">
          <strong>{userAName}</strong> would clash with{" "}
          {q.data.forUserA.assigneeConflicts.length} other shift
          {q.data.forUserA.assigneeConflicts.length === 1 ? "" : "s"} after swap.
        </div>
      )}
    </div>
  );
}
