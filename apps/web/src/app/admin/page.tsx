"use client";

import Link from "next/link";
import { trpc } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

export default function AdminPage() {
  const me = trpc.user.me.useQuery();
  const versions = trpc.schedule.listVersions.useQuery();
  const sites = trpc.site.list.useQuery();
  const createVersion = trpc.schedule.createVersion.useMutation();
  const publishVersion = trpc.schedule.publishVersion.useMutation();
  const createShift = trpc.shift.create.useMutation();

  const [label, setLabel] = useState("FY Draft");
  const [year, setYear] = useState(new Date().getFullYear());
  const [siteId, setSiteId] = useState("");
  const [versionId, setVersionId] = useState("");

  const isAdmin = me.data?.user.role === "ADMIN";

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
                <CardTitle>Add sample shift</CardTitle>
                <CardDescription>
                  Pick a version and site. Creates a daytime block tomorrow for quick demos.
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
                <Button
                  type="button"
                  disabled={!versionId || !siteId}
                  onClick={() => {
                    const start = new Date();
                    start.setDate(start.getDate() + 1);
                    start.setHours(7, 0, 0, 0);
                    const end = new Date(start);
                    end.setHours(17, 0, 0, 0);
                    createShift.mutate(
                      {
                        scheduleVersionId: versionId,
                        siteId,
                        coverageCategory: "INPATIENT_HOSPITAL",
                        inpatientSplit: "DAY",
                        startsAt: start,
                        endsAt: end,
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
                  Add daytime shift (demo)
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
