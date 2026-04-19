import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@shifthub/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format Date as ICS UTC timestamp (YYYYMMDDTHHmmssZ). */
function toIcsUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

/** ICS text fields must escape commas, semicolons, backslashes, and newlines (RFC 5545 §3.3.11). */
function icsEscape(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Hard-fold lines at 75 octets per RFC 5545 §3.1 (simple char-based; sufficient for ASCII). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i === 0 ? 75 : i + 74);
    out.push(i === 0 ? chunk : ` ${chunk}`);
    i += i === 0 ? 75 : 74;
  }
  return out.join("\r\n");
}

function buildIcs(opts: {
  calendarName: string;
  events: Array<{
    uid: string;
    title: string;
    description?: string;
    location?: string;
    startsAt: Date;
    endsAt: Date;
    createdAt?: Date;
    updatedAt?: Date;
  }>;
}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ShiftHub//Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(opts.calendarName)}`,
  ];
  const stamp = toIcsUtc(new Date());
  for (const ev of opts.events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(ev.uid)}@shifthub`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${toIcsUtc(ev.startsAt)}`);
    lines.push(`DTEND:${toIcsUtc(ev.endsAt)}`);
    lines.push(`SUMMARY:${icsEscape(ev.title)}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    if (ev.createdAt) lines.push(`CREATED:${toIcsUtc(ev.createdAt)}`);
    if (ev.updatedAt) lines.push(`LAST-MODIFIED:${toIcsUtc(ev.updatedAt)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n");
}

function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(req: Request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const me = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true, name: true, role: true },
  });
  if (!me) {
    return NextResponse.json({ error: "no_profile" }, { status: 403 });
  }

  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "mine").toLowerCase();
  const from = parseDateParam(url.searchParams.get("from"));
  const to = parseDateParam(url.searchParams.get("to"));
  const siteId = url.searchParams.get("siteId");

  // Default window: 4 weeks back, 12 weeks forward — generous enough for subscriptions.
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 28);
  defaultFrom.setHours(0, 0, 0, 0);
  const defaultTo = new Date();
  defaultTo.setDate(defaultTo.getDate() + 84);
  defaultTo.setHours(23, 59, 59, 999);

  const startsAt = { gte: from ?? defaultFrom, lte: to ?? defaultTo };

  const where: Record<string, unknown> = { startsAt };
  if (siteId) where.siteId = siteId;
  if (scope === "mine") {
    where.assigneeId = me.id;
  } else if (scope === "open") {
    where.assigneeId = null;
    where.status = "PUBLISHED";
  }

  const shifts = await prisma.shift.findMany({
    where: where as never,
    include: { site: true, assignee: { select: { name: true, email: true } } },
    orderBy: { startsAt: "asc" },
  });

  const calendarName =
    scope === "mine"
      ? `ShiftHub — ${me.name ?? "My"} schedule`
      : scope === "open"
        ? "ShiftHub — Open shifts"
        : "ShiftHub — All shifts";

  const ics = buildIcs({
    calendarName,
    events: shifts.map((s) => ({
      uid: s.id,
      title:
        scope === "mine"
          ? s.site.name
          : `${s.site.name}${s.assignee?.name ? ` — ${s.assignee.name}` : " — Open"}`,
      description: [
        `Status: ${s.status}`,
        s.assignee?.name ? `Assigned: ${s.assignee.name}` : "Assigned: (open)",
        `Coverage: ${s.coverageCategory}`,
        s.inpatientSplit ? `Split: ${s.inpatientSplit}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      location: s.site.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      createdAt: s.startsAt,
    })),
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="shifthub-${scope}.ics"`,
      "cache-control": "no-store",
    },
  });
}
