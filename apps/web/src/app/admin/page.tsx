"use client";

import Link from "next/link";
import { trpc } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMemo, useState } from "react";
import { formatShiftTimeRange } from "@/components/week-timeline";

type ScheduleScope = "day" | "week" | "month" | "year";

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
  const pendingPickups = trpc.workflow.listPendingPickups.useQuery(undefined, { enabled: isAdmin });
  const pendingSwaps = trpc.workflow.listPendingSwaps.useQuery(undefined, { enabled: isAdmin });
  const approvePickup = trpc.workflow.approvePickup.useMutation({
    onSuccess: async () => {
      await pendingPickups.refetch();
      await utils.shift.list.invalidate();
    },
  });
  const denyPickup = trpc.workflow.denyPickup.useMutation({
    onSuccess: async () => {
      await pendingPickups.refetch();
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
  const [siteId, setSiteId] = useState("");
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
  const [swapDenyNotes, setSwapDenyNotes] = useState<Record<string, string>>({});

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-4">
        <div>
          <h1 className="text-2xl font-bold">Admin</h1>
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
                <CardTitle>Pending slot pickups</CardTitle>
                <CardDescription>
                  Approve to assign the physician, or reject with a reason. Set{" "}
                  <code className="rounded bg-muted px-1">OrgSettings.adminNotificationEmail</code> in the database for
                  email alerts (wire your provider in production).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!pendingPickups.data?.length && (
                  <p className="text-sm text-muted-foreground">No pending pickup requests.</p>
                )}
                {pendingPickups.data?.map((p) => (
                  <div
                    key={p.id}
                    className="space-y-2 rounded-md border border-border p-3 text-sm"
                  >
                    <div className="font-medium">{p.requester.name}</div>
                    <div className="text-muted-foreground">{p.requester.email}</div>
                    <div>{p.shift.site.name}</div>
                    <div className="text-muted-foreground">
                      {formatShiftTimeRange(p.shift.startsAt, p.shift.endsAt)}
                    </div>
                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => approvePickup.mutate({ requestId: p.id })}
                        disabled={approvePickup.isPending}
                      >
                        Approve
                      </Button>
                    </div>
                    <div className="space-y-1 pt-2">
                      <Label htmlFor={`reject-${p.id}`}>Rejection note (required to reject)</Label>
                      <Input
                        id={`reject-${p.id}`}
                        value={pickupDenyNotes[p.id] ?? ""}
                        onChange={(e) =>
                          setPickupDenyNotes((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        placeholder="Explain why this pickup cannot be approved"
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
                        Reject
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Pending shift swaps</CardTitle>
                <CardDescription>
                  Both parties accepted; approve or reject with a reason. Rejections require a note.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!pendingSwaps.data?.length && (
                  <p className="text-sm text-muted-foreground">No swaps awaiting admin.</p>
                )}
                {pendingSwaps.data?.map((s) => (
                  <div key={s.id} className="space-y-2 rounded-md border border-border p-3 text-sm">
                    <div>
                      {s.userA.name} ↔ {s.userB.name}
                    </div>
                    <div className="text-muted-foreground">
                      A: {s.shiftA.site.name} · {formatShiftTimeRange(s.shiftA.startsAt, s.shiftA.endsAt)}
                    </div>
                    <div className="text-muted-foreground">
                      B: {s.shiftB.site.name} · {formatShiftTimeRange(s.shiftB.startsAt, s.shiftB.endsAt)}
                    </div>
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
                  </div>
                ))}
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
                    {versions.data?.map((v) => (
                      <li key={v.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                        <div>
                          <div className="font-medium">{v.label}</div>
                          <div className="text-muted-foreground">
                            {v.year} · {v.status}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => publishVersion.mutate({ id: v.id }, { onSuccess: () => versions.refetch() })}
                        >
                          Publish
                        </Button>
                      </li>
                    ))}
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
                  <Label htmlFor="site">Site</Label>
                  <select
                    id="site"
                    className="flex h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                  >
                    <option value="">Select site</option>
                    {sites.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
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

                <Button
                  type="button"
                  disabled={!versionId || !siteId || "error" in rangePreview || createShift.isPending}
                  onClick={() => {
                    const r = buildShiftRange(scheduleScope, {
                      dayDate,
                      monthValue,
                      yearValue,
                      startTime,
                      endTime,
                    });
                    if ("error" in r) return;
                    createShift.mutate(
                      {
                        scheduleVersionId: versionId,
                        siteId,
                        coverageCategory: "INPATIENT_HOSPITAL",
                        inpatientSplit: "DAY",
                        startsAt: r.startsAt,
                        endsAt: r.endsAt,
                        assigneeId: null,
                        status: "DRAFT",
                      },
                      {
                        onSuccess: () => {
                          alert("Shift created");
                        },
                      },
                    );
                  }}
                >
                  {createShift.isPending ? "Creating…" : "Create shift"}
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
