"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { trpc } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WeekTimeline } from "@/components/week-timeline";

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
  const me = trpc.user.me.useQuery(undefined, { enabled: false });
  const syncedRef = useRef(false);

  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeekMonday(new Date()));

  const range = useMemo(() => {
    const from = weekAnchor;
    const to = addDays(weekAnchor, 7);
    return { from, to };
  }, [weekAnchor]);

  const versions = trpc.schedule.listVersions.useQuery();
  const activeVersionId = versions.data?.[0]?.id;

  const shifts = trpc.shift.list.useQuery(
    {
      scheduleVersionId: activeVersionId,
      from: range.from,
      to: range.to,
    },
    { enabled: !!activeVersionId },
  );

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

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-4">
        <div>
          <h1 className="text-2xl font-bold">My schedule</h1>
          <p className="text-sm text-muted-foreground">Week view · color-coded by site</p>
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
          </CardContent>
        </Card>

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

        {activeVersionId && shifts.data && shifts.data.length > 0 && (
          <WeekTimeline weekStart={weekAnchor} shifts={shifts.data} />
        )}

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
