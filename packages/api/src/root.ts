import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createShiftInputSchema,
  draftYearInputSchema,
  pickupSuggestionInputSchema,
  shiftFilterSchema,
} from "@shifthub/validators";
import { getClerkProfileForSync } from "./clerkProfile";
import { logAudit } from "./audit";
import { sendNotification } from "./notify";
import {
  findShiftConflicts,
  hasConflicts,
  summarizeConflict,
  type ConflictReport,
} from "./conflicts";
import { resolveRoleForSync } from "./role";
import {
  adminProcedure,
  clerkProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from "./trpc";

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true as const })),

  user: router({
    sync: clerkProcedure
      .input(
        z
          .object({
            email: z.string().email().optional(),
            name: z.string().min(1).optional(),
            phone: z.string().optional(),
          })
          .optional(),
      )
      .mutation(async ({ ctx, input }) => {
        const { email, name, phone } = await getClerkProfileForSync(ctx.clerkId, input);
        const existing = await ctx.prisma.user.findUnique({
          where: { clerkId: ctx.clerkId },
          select: { role: true },
        });
        const role = resolveRoleForSync(email, existing?.role);
        const user = await ctx.prisma.user.upsert({
          where: { clerkId: ctx.clerkId },
          create: {
            clerkId: ctx.clerkId,
            email,
            name,
            phone,
            role,
          },
          update: {
            email,
            name,
            phone,
            role,
          },
        });
        return user;
      }),

    me: protectedProcedure.query(async ({ ctx }) => {
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: ctx.userId },
      });
      const org = await ctx.prisma.orgSettings.findUnique({
        where: { id: "default" },
      });
      return { user, org };
    }),

    setExternalTitlePreference: protectedProcedure
      .input(z.object({ show: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.user.update({
          where: { id: ctx.userId },
          data: { showOwnExternalTitles: input.show },
        });
      }),
  }),

  org: router({
    getSettings: protectedProcedure.query(async ({ ctx }) => {
      let settings = await ctx.prisma.orgSettings.findUnique({
        where: { id: "default" },
      });
      if (!settings) {
        settings = await ctx.prisma.orgSettings.create({
          data: { id: "default" },
        });
      }
      return settings;
    }),

    setContactDirectoryVisible: adminProcedure
      .input(z.object({ visible: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.orgSettings.upsert({
          where: { id: "default" },
          create: { id: "default", contactDirectoryVisible: input.visible },
          update: { contactDirectoryVisible: input.visible },
        });
      }),

    setAdminNotificationEmail: adminProcedure
      .input(z.object({ email: z.string().email().nullable() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.orgSettings.upsert({
          where: { id: "default" },
          create: { id: "default", adminNotificationEmail: input.email ?? undefined },
          update: { adminNotificationEmail: input.email },
        });
      }),
  }),

  site: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return ctx.prisma.site.findMany({ orderBy: { sortOrder: "asc" } });
    }),

    setVisibility: protectedProcedure
      .input(
        z.object({
          siteId: z.string(),
          hidden: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.userSiteVisibility.upsert({
          where: {
            userId_siteId: { userId: ctx.userId, siteId: input.siteId },
          },
          create: {
            userId: ctx.userId,
            siteId: input.siteId,
            hidden: input.hidden,
          },
          update: { hidden: input.hidden },
        });
      }),
  }),

  schedule: router({
    listVersions: protectedProcedure.query(async ({ ctx }) => {
      return ctx.prisma.scheduleVersion.findMany({
        orderBy: { year: "desc" },
        include: { _count: { select: { shifts: true } } },
      });
    }),

    createVersion: adminProcedure
      .input(
        z.object({
          label: z.string(),
          year: z.number().int(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.scheduleVersion.create({
          data: {
            label: input.label,
            year: input.year,
            status: "DRAFT",
          },
        });
      }),

    publishVersion: adminProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const version = await ctx.prisma.scheduleVersion.update({
          where: { id: input.id },
          data: { status: "PUBLISHED" },
        });
        await ctx.prisma.shift.updateMany({
          where: { scheduleVersionId: input.id },
          data: { status: "PUBLISHED" },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          action: "SCHEDULE_PUBLISHED",
          payload: { scheduleVersionId: input.id },
        });
        return version;
      }),
  }),

  shift: router({
    list: protectedProcedure.input(shiftFilterSchema).query(async ({ ctx, input }) => {
      const hiddenSites = await ctx.prisma.userSiteVisibility.findMany({
        where: { userId: ctx.userId, hidden: true },
      });
      const hiddenIds = new Set(hiddenSites.map((h) => h.siteId));

      const where: Record<string, unknown> = {
        startsAt: { gte: input.from, lte: input.to },
      };
      if (input.scheduleVersionId) {
        where.scheduleVersionId = input.scheduleVersionId;
      }
      if (input.siteIds?.length) {
        where.siteId = { in: input.siteIds };
      }

      const shifts = await ctx.prisma.shift.findMany({
        where: where as never,
        include: {
          site: true,
          assignee: true,
          scheduleVersion: true,
        },
        orderBy: { startsAt: "asc" },
      });

      let filtered = shifts.filter((s) => !hiddenIds.has(s.siteId));

      if (input.assigneeIds?.length) {
        filtered = filtered.filter(
          (s) => s.assigneeId && input.assigneeIds!.includes(s.assigneeId),
        );
      }
      if (input.physicianIds?.length) {
        filtered = filtered.filter(
          (s) =>
            s.assignee &&
            s.assignee.role === "PHYSICIAN" &&
            input.physicianIds!.includes(s.assignee.id),
        );
      }
      if (input.appIds?.length) {
        filtered = filtered.filter(
          (s) =>
            s.assignee && s.assignee.role === "APP" && input.appIds!.includes(s.assignee.id),
        );
      }

      return filtered;
    }),

    /**
     * Full detail for a single shift — used by the schedule page modal so any signed-in user
     * (physician, APP, or admin) can read the site, assignment, admin notes, and comment thread.
     */
    byId: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ ctx, input }) => {
        return ctx.prisma.shift.findUniqueOrThrow({
          where: { id: input.id },
          include: {
            site: true,
            assignee: { select: { id: true, name: true, role: true, email: true } },
            scheduleVersion: { select: { id: true, label: true, year: true, status: true } },
            comments: {
              include: { author: { select: { id: true, name: true, role: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
        });
      }),

    /** Admins set the free-text note shown to everyone on the shift detail modal. */
    updateNotes: adminProcedure
      .input(z.object({ id: z.string(), adminNotes: z.string().nullable() }))
      .mutation(async ({ ctx, input }) => {
        const shift = await ctx.prisma.shift.update({
          where: { id: input.id },
          data: { adminNotes: input.adminNotes },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: shift.id,
          action: "SHIFT_NOTES_UPDATED",
          payload: { adminNotes: input.adminNotes },
        });
        return shift;
      }),

    /**
     * Anyone signed in can post a comment on a shift. When a non-admin posts, an
     * admin notification fires so the on-call admin sees the request even if they
     * aren't watching the modal. Visible to everyone in the shift detail modal.
     */
    /**
     * Admins post comments on a shift's thread. Physicians/APPs see the thread
     * read-only — they communicate with admin via `shift.notifyAdmin` (notification only,
     * not written into the admin thread).
     */
    addComment: adminProcedure
      .input(z.object({ shiftId: z.string(), body: z.string().trim().min(1).max(2_000) }))
      .mutation(async ({ ctx, input }) => {
        const comment = await ctx.prisma.shiftComment.create({
          data: { shiftId: input.shiftId, authorId: ctx.userId, body: input.body },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: input.shiftId,
          action: "SHIFT_COMMENT_ADDED",
          payload: { commentId: comment.id },
        });
        return comment;
      }),

    /**
     * Lets a signed-in user (typically a physician/APP) send a note to admin about a
     * shift WITHOUT writing into the admin-only comment thread. The note is preserved
     * as an audit-log entry and dispatched via `sendNotification` (webhook + log; email
     * when the webhook is wired to a mail relay).
     */
    notifyAdmin: protectedProcedure
      .input(
        z.object({
          shiftId: z.string(),
          body: z.string().trim().min(1).max(2_000),
          preferredStartsAt: z.coerce.date().optional(),
          preferredEndsAt: z.coerce.date().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const author = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: ctx.userId },
          select: { id: true, name: true, email: true, role: true },
        });
        const [shift, org] = await Promise.all([
          ctx.prisma.shift.findUniqueOrThrow({
            where: { id: input.shiftId },
            include: { site: { select: { name: true } } },
          }),
          ctx.prisma.orgSettings.findUnique({ where: { id: "default" } }),
        ]);
        if (input.preferredStartsAt && input.preferredEndsAt) {
          if (input.preferredStartsAt < shift.startsAt || input.preferredEndsAt > shift.endsAt) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Preferred window must stay inside the shift",
            });
          }
          if (input.preferredEndsAt.getTime() <= input.preferredStartsAt.getTime()) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid preferred window" });
          }
        }
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: input.shiftId,
          action: "SHIFT_NOTE_TO_ADMIN",
          payload: {
            body: input.body,
            preferredStartsAt: input.preferredStartsAt?.toISOString(),
            preferredEndsAt: input.preferredEndsAt?.toISOString(),
            authorRole: author.role,
          },
        });
        await sendNotification({
          event: "SHIFT_COMMENT_POSTED",
          summary:
            `${author.name} (${author.role.toLowerCase()}) sent a note about ${
              shift.site.name
            } ${shift.id}: ${input.body.slice(0, 140)}`,
          adminEmail: org?.adminNotificationEmail ?? null,
          recipients: org?.adminNotificationEmail ? [org.adminNotificationEmail] : undefined,
          details: {
            shiftId: input.shiftId,
            authorId: ctx.userId,
            authorName: author.name,
            authorEmail: author.email,
            authorRole: author.role,
            body: input.body,
            preferredStartsAt: input.preferredStartsAt?.toISOString(),
            preferredEndsAt: input.preferredEndsAt?.toISOString(),
          },
        });
        return { ok: true as const };
      }),

    /** Authors (or admins) can delete their own comment. */
    deleteComment: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const comment = await ctx.prisma.shiftComment.findUniqueOrThrow({
          where: { id: input.id },
        });
        const me = await ctx.prisma.user.findUniqueOrThrow({
          where: { id: ctx.userId },
          select: { role: true },
        });
        if (comment.authorId !== ctx.userId && me.role !== "ADMIN") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed to delete this comment." });
        }
        await ctx.prisma.shiftComment.delete({ where: { id: input.id } });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: comment.shiftId,
          action: "SHIFT_COMMENT_DELETED",
          payload: { commentId: input.id },
        });
        return { ok: true };
      }),

    /** Detect shifts that overlap a candidate window (used by admin UI + AI suggestions). */
    findConflicts: adminProcedure
      .input(
        z.object({
          startsAt: z.coerce.date(),
          endsAt: z.coerce.date(),
          siteId: z.string().optional(),
          assigneeId: z.string().nullable().optional(),
          excludeShiftId: z.string().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const report = await findShiftConflicts(ctx.prisma, input);
        return { ...report, summary: summarizeConflict(report) };
      }),

    create: adminProcedure
      .input(createShiftInputSchema.extend({ force: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        const conflicts = await findShiftConflicts(ctx.prisma, {
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          siteId: input.siteId,
          assigneeId: input.assigneeId ?? null,
        });
        if (!input.force && hasConflicts(conflicts)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Shift conflicts with existing schedule (${summarizeConflict(conflicts)}). Pass force=true to override.`,
            cause: conflicts,
          });
        }
        const shift = await ctx.prisma.shift.create({
          data: {
            scheduleVersionId: input.scheduleVersionId,
            siteId: input.siteId,
            coverageCategory: input.coverageCategory,
            inpatientSplit: input.inpatientSplit,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            assigneeId: input.assigneeId ?? undefined,
            status: input.status ?? "DRAFT",
          },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: shift.id,
          action: "SHIFT_CREATED",
          payload: {
            shiftId: shift.id,
            forced: Boolean(input.force) && hasConflicts(conflicts),
            conflictSummary: hasConflicts(conflicts) ? summarizeConflict(conflicts) : undefined,
          },
        });
        return shift;
      }),

    update: adminProcedure
      .input(
        z.object({
          id: z.string(),
          siteId: z.string().optional(),
          startsAt: z.coerce.date().optional(),
          endsAt: z.coerce.date().optional(),
          assigneeId: z.string().nullable().optional(),
          force: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { id, force, ...data } = input;
        const prev = await ctx.prisma.shift.findUniqueOrThrow({ where: { id } });
        const conflicts = await findShiftConflicts(ctx.prisma, {
          startsAt: data.startsAt ?? prev.startsAt,
          endsAt: data.endsAt ?? prev.endsAt,
          siteId: data.siteId ?? prev.siteId,
          assigneeId: data.assigneeId === undefined ? prev.assigneeId : data.assigneeId,
          excludeShiftId: id,
        });
        if (!force && hasConflicts(conflicts)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Update conflicts with existing schedule (${summarizeConflict(conflicts)}). Pass force=true to override.`,
            cause: conflicts,
          });
        }
        const shift = await ctx.prisma.shift.update({
          where: { id },
          data,
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: shift.id,
          action: "SHIFT_UPDATED",
          payload: {
            before: prev,
            after: shift,
            forced: Boolean(force) && hasConflicts(conflicts),
            conflictSummary: hasConflicts(conflicts) ? summarizeConflict(conflicts) : undefined,
          },
        });
        return shift;
      }),
  }),

  directory: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const org = await ctx.prisma.orgSettings.findUnique({
        where: { id: "default" },
      });
      if (!org?.contactDirectoryVisible && ctx.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Directory hidden" });
      }
      return ctx.prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
        },
        orderBy: { name: "asc" },
      });
    }),
  }),

  workflow: router({
    requestGiveUp: protectedProcedure
      .input(z.object({ shiftId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const shift = await ctx.prisma.shift.findUniqueOrThrow({
          where: { id: input.shiftId },
        });
        if (shift.assigneeId !== ctx.userId) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        const req = await ctx.prisma.giveUpRequest.create({
          data: {
            shiftId: input.shiftId,
            requesterId: ctx.userId,
            status: "PENDING",
          },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: shift.id,
          action: "GIVE_UP_REQUESTED",
          payload: { requestId: req.id },
        });
        const orgGiveUp = await ctx.prisma.orgSettings.findUnique({ where: { id: "default" } });
        await sendNotification({
          event: "GIVE_UP_REQUESTED",
          summary: `Give-up requested for shift ${shift.id}`,
          adminEmail: orgGiveUp?.adminNotificationEmail ?? null,
          details: { requestId: req.id, shiftId: shift.id, requesterId: ctx.userId },
        });
        return req;
      }),

    approveGiveUpOpenSlot: adminProcedure
      .input(z.object({ requestId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const g = await ctx.prisma.giveUpRequest.update({
          where: { id: input.requestId },
          data: { status: "APPROVED", openedToGroup: true, resolvedAt: new Date() },
        });
        await ctx.prisma.shift.update({
          where: { id: g.shiftId },
          data: { assigneeId: null },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: g.shiftId,
          action: "GIVE_UP_APPROVED_SLOT_OPEN",
          payload: { requestId: g.id },
        });
        await sendNotification({
          event: "GIVE_UP_APPROVED",
          summary: `Give-up approved; shift ${g.shiftId} reopened`,
          details: { requestId: g.id, shiftId: g.shiftId, approverId: ctx.userId },
        });
        return g;
      }),

    requestPickup: protectedProcedure
      .input(
        z.object({
          shiftId: z.string(),
          /** Optional sub-window inside the shift; min 15 min, max the full shift length. */
          preferredStartsAt: z.coerce.date().optional(),
          preferredEndsAt: z.coerce.date().optional(),
          /** Free-text note delivered to the admin reviewing this pickup. */
          note: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const shift = await ctx.prisma.shift.findUniqueOrThrow({
          where: { id: input.shiftId },
        });
        if (shift.status !== "PUBLISHED") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Only published shifts can be picked up",
          });
        }
        if (shift.assigneeId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Shift not open" });
        }
        let preferredStartsAt: Date | undefined;
        let preferredEndsAt: Date | undefined;
        if (input.preferredStartsAt && input.preferredEndsAt) {
          preferredStartsAt = input.preferredStartsAt;
          preferredEndsAt = input.preferredEndsAt;
          if (preferredStartsAt < shift.startsAt || preferredEndsAt > shift.endsAt) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Preferred times must fall within the shift",
            });
          }
          if (preferredEndsAt.getTime() <= preferredStartsAt.getTime()) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid preferred time range" });
          }
          const durMin = (preferredEndsAt.getTime() - preferredStartsAt.getTime()) / 60000;
          if (durMin < 15) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Preferred slot must be at least 15 minutes",
            });
          }
        } else if (input.preferredStartsAt ?? input.preferredEndsAt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Provide both preferred start and end, or neither",
          });
        }
        const existingLock = await ctx.prisma.pickupRequest.findFirst({
          where: {
            shiftId: input.shiftId,
            status: "PENDING",
            locksSlot: true,
          },
        });
        if (existingLock && existingLock.requesterId !== ctx.userId) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Another pickup is pending review for this slot",
          });
        }
        const note = input.note?.trim() || null;
        const pickup = await ctx.prisma.pickupRequest.create({
          data: {
            shiftId: input.shiftId,
            requesterId: ctx.userId,
            status: "PENDING",
            locksSlot: true,
            preferredStartsAt,
            preferredEndsAt,
            requesterNote: note,
          },
        });
        const requester = await ctx.prisma.user.findUnique({
          where: { id: ctx.userId },
          select: { name: true, email: true },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: shift.id,
          action: "PICKUP_REQUESTED",
          payload: { requestId: pickup.id, locked: true, hasNote: Boolean(note) },
        });
        const org = await ctx.prisma.orgSettings.findUnique({ where: { id: "default" } });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: shift.id,
          action: "ADMIN_REVIEW_QUEUED",
          payload: {
            kind: "pickup",
            pickupRequestId: pickup.id,
            adminNotificationEmailConfigured: Boolean(org?.adminNotificationEmail),
          },
        });
        await sendNotification({
          event: "PICKUP_REQUESTED",
          summary:
            `Pickup requested by ${requester?.name ?? "physician"} for shift ${shift.id}` +
            (note ? ` — note: ${note}` : ""),
          adminEmail: org?.adminNotificationEmail ?? null,
          recipients: org?.adminNotificationEmail ? [org.adminNotificationEmail] : undefined,
          details: {
            pickupRequestId: pickup.id,
            shiftId: shift.id,
            requesterId: ctx.userId,
            requesterName: requester?.name,
            requesterEmail: requester?.email,
            preferredStartsAt: preferredStartsAt?.toISOString(),
            preferredEndsAt: preferredEndsAt?.toISOString(),
            note,
          },
        });
        return pickup;
      }),

    approvePickup: adminProcedure
      .input(
        z.object({
          requestId: z.string(),
          /** Shown to the physician in email/webhook when set. */
          adminNote: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const p = await ctx.prisma.pickupRequest.findUniqueOrThrow({
          where: { id: input.requestId },
        });
        if (p.status !== "PENDING") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pickup request is not pending" });
        }
        const adminNote = input.adminNote?.trim() || null;
        await ctx.prisma.shift.update({
          where: { id: p.shiftId },
          data: { assigneeId: p.requesterId },
        });
        const updated = await ctx.prisma.pickupRequest.update({
          where: { id: input.requestId },
          data: {
            status: "APPROVED",
            resolvedAt: new Date(),
            adminApprovalNote: adminNote,
          },
        });
        await ctx.prisma.pickupRequest.updateMany({
          where: {
            shiftId: p.shiftId,
            id: { not: p.id },
            status: "PENDING",
          },
          data: { status: "DENIED", resolvedAt: new Date(), locksSlot: false },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: p.shiftId,
          action: "PICKUP_APPROVED",
          payload: { requestId: p.id, hasAdminNote: Boolean(adminNote) },
        });
        const requester = await ctx.prisma.user.findUnique({
          where: { id: p.requesterId },
          select: { email: true, name: true },
        });
        await sendNotification({
          event: "PICKUP_APPROVED",
          summary:
            `Pickup approved for shift ${p.shiftId}` + (adminNote ? ` — note: ${adminNote}` : ""),
          recipients: requester?.email ? [requester.email] : undefined,
          details: {
            requestId: p.id,
            shiftId: p.shiftId,
            requesterId: p.requesterId,
            adminNote,
          },
        });
        return updated;
      }),

    denyPickup: adminProcedure
      .input(z.object({ requestId: z.string(), note: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const p = await ctx.prisma.pickupRequest.findUniqueOrThrow({
          where: { id: input.requestId },
        });
        if (p.status !== "PENDING") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Pickup request is not pending" });
        }
        const updated = await ctx.prisma.pickupRequest.update({
          where: { id: input.requestId },
          data: {
            status: "DENIED",
            resolvedAt: new Date(),
            resolutionNote: input.note,
            locksSlot: false,
          },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: p.shiftId,
          action: "PICKUP_DENIED",
          payload: { requestId: p.id, note: input.note },
        });
        const deniedRequester = await ctx.prisma.user.findUnique({
          where: { id: p.requesterId },
          select: { email: true, name: true },
        });
        await sendNotification({
          event: "PICKUP_DENIED",
          summary: `Pickup denied for shift ${p.shiftId}`,
          recipients: deniedRequester?.email ? [deniedRequester.email] : undefined,
          details: {
            requestId: p.id,
            shiftId: p.shiftId,
            requesterId: p.requesterId,
            note: input.note,
          },
        });
        return updated;
      }),

    listPendingPickups: adminProcedure.query(async ({ ctx }) => {
      const items = await ctx.prisma.pickupRequest.findMany({
        where: { status: "PENDING" },
        include: {
          shift: { include: { site: true } },
          requester: { select: { id: true, name: true, email: true, role: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      // Annotate each with the count of competing pending pickups on the same shift.
      const competingByShift = new Map<string, number>();
      for (const it of items) {
        competingByShift.set(it.shiftId, (competingByShift.get(it.shiftId) ?? 0) + 1);
      }
      return items.map((it) => ({
        ...it,
        competingPickupCount: Math.max(0, (competingByShift.get(it.shiftId) ?? 1) - 1),
      }));
    }),

    /** Recent approved/denied slot pickups (audit trail with physician + admin comments). */
    listRecentPickupDecisions: adminProcedure.query(async ({ ctx }) => {
      return ctx.prisma.pickupRequest.findMany({
        where: { status: { in: ["APPROVED", "DENIED"] }, resolvedAt: { not: null } },
        orderBy: { resolvedAt: "desc" },
        take: 25,
        include: {
          shift: { include: { site: true } },
          requester: { select: { id: true, name: true, email: true, role: true } },
        },
      });
    }),

    /** Conflict preview before approving a pickup (assignee gets the shift on success). */
    checkPickupConflict: adminProcedure
      .input(z.object({ requestId: z.string() }))
      .query(async ({ ctx, input }) => {
        const p = await ctx.prisma.pickupRequest.findUniqueOrThrow({
          where: { id: input.requestId },
          include: { shift: true },
        });
        const report: ConflictReport = await findShiftConflicts(ctx.prisma, {
          startsAt: p.shift.startsAt,
          endsAt: p.shift.endsAt,
          assigneeId: p.requesterId,
          excludeShiftId: p.shiftId,
        });
        return { ...report, summary: summarizeConflict(report) };
      }),

    pickupRequestsForShifts: protectedProcedure
      .input(z.object({ shiftIds: z.array(z.string()) }))
      .query(async ({ ctx, input }) => {
        if (input.shiftIds.length === 0) return [];
        return ctx.prisma.pickupRequest.findMany({
          where: {
            shiftId: { in: input.shiftIds },
            status: "PENDING",
          },
          select: {
            id: true,
            shiftId: true,
            requesterId: true,
            requester: { select: { name: true } },
          },
        });
      }),

    myPickupRequests: protectedProcedure.query(async ({ ctx }) => {
      return ctx.prisma.pickupRequest.findMany({
        where: { requesterId: ctx.userId },
        orderBy: { createdAt: "desc" },
        take: 15,
        include: { shift: { include: { site: true } } },
      });
    }),

    listMySwapRequests: protectedProcedure.query(async ({ ctx }) => {
      return ctx.prisma.swapRequest.findMany({
        where: {
          OR: [{ userAId: ctx.userId }, { userBId: ctx.userId }],
          status: { in: ["PENDING_COUNTERPARTY", "PENDING_ADMIN", "DENIED"] },
        },
        include: {
          shiftA: { include: { site: true } },
          shiftB: { include: { site: true } },
          userA: { select: { id: true, name: true, email: true } },
          userB: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }),

    requestSwap: protectedProcedure
      .input(
        z.object({
          myShiftId: z.string(),
          theirShiftId: z.string(),
          counterpartyId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const a = await ctx.prisma.shift.findUniqueOrThrow({
          where: { id: input.myShiftId },
        });
        const b = await ctx.prisma.shift.findUniqueOrThrow({
          where: { id: input.theirShiftId },
        });
        if (a.assigneeId !== ctx.userId) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        if (b.assigneeId !== input.counterpartyId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Counterparty mismatch" });
        }
        const swap = await ctx.prisma.swapRequest.create({
          data: {
            shiftAId: input.myShiftId,
            shiftBId: input.theirShiftId,
            userAId: ctx.userId,
            userBId: input.counterpartyId,
            status: "PENDING_COUNTERPARTY",
          },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: a.id,
          action: "SWAP_REQUESTED",
          payload: { swapId: swap.id },
        });
        const [counterparty, requester, org] = await Promise.all([
          ctx.prisma.user.findUnique({
            where: { id: input.counterpartyId },
            select: { email: true, name: true },
          }),
          ctx.prisma.user.findUnique({
            where: { id: ctx.userId },
            select: { email: true, name: true },
          }),
          ctx.prisma.orgSettings.findUnique({ where: { id: "default" } }),
        ]);
        const recipientSet = new Set<string>();
        if (counterparty?.email) recipientSet.add(counterparty.email);
        if (org?.adminNotificationEmail?.trim()) recipientSet.add(org.adminNotificationEmail.trim());
        const recipients = [...recipientSet];
        await sendNotification({
          event: "SWAP_REQUESTED",
          summary: `${requester?.name ?? "Physician"} requested a swap with ${counterparty?.name ?? "colleague"} (shifts ${a.id} ↔ ${b.id})`,
          adminEmail: org?.adminNotificationEmail ?? null,
          recipients: recipients.length > 0 ? recipients : undefined,
          details: {
            swapId: swap.id,
            shiftAId: a.id,
            shiftBId: b.id,
            requesterId: ctx.userId,
            requesterName: requester?.name,
            counterpartyId: input.counterpartyId,
            counterpartyName: counterparty?.name,
          },
        });
        return swap;
      }),

    acceptSwapCounterparty: protectedProcedure
      .input(z.object({ swapId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const s = await ctx.prisma.swapRequest.findUniqueOrThrow({
          where: { id: input.swapId },
        });
        if (s.userBId !== ctx.userId) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        const updated = await ctx.prisma.swapRequest.update({
          where: { id: input.swapId },
          data: {
            status: "PENDING_ADMIN",
            counterpartAcceptedAt: new Date(),
          },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: s.shiftAId,
          action: "SWAP_COUNTERPARTY_ACCEPTED",
          payload: { swapId: s.id },
        });
        const org = await ctx.prisma.orgSettings.findUnique({ where: { id: "default" } });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: s.shiftAId,
          action: "ADMIN_REVIEW_QUEUED",
          payload: {
            kind: "swap",
            swapId: s.id,
            adminNotificationEmailConfigured: Boolean(org?.adminNotificationEmail),
          },
        });
        const adminRecipients =
          org?.adminNotificationEmail?.trim() ? [org.adminNotificationEmail.trim()] : undefined;
        await sendNotification({
          event: "SWAP_COUNTERPARTY_ACCEPTED",
          summary: `Swap ${s.id} awaiting admin approval`,
          adminEmail: org?.adminNotificationEmail ?? null,
          recipients: adminRecipients,
          details: { swapId: s.id, shiftAId: s.shiftAId, shiftBId: s.shiftBId },
        });
        return updated;
      }),

    approveSwapAdmin: adminProcedure
      .input(z.object({ swapId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const s = await ctx.prisma.swapRequest.findUniqueOrThrow({
          where: { id: input.swapId },
          include: { shiftA: true, shiftB: true },
        });
        if (s.status !== "PENDING_ADMIN") {
          throw new TRPCError({ code: "BAD_REQUEST" });
        }
        await ctx.prisma.shift.update({
          where: { id: s.shiftAId },
          data: { assigneeId: s.userBId },
        });
        await ctx.prisma.shift.update({
          where: { id: s.shiftBId },
          data: { assigneeId: s.userAId },
        });
        const updated = await ctx.prisma.swapRequest.update({
          where: { id: input.swapId },
          data: { status: "APPROVED", resolvedAt: new Date() },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: s.shiftAId,
          action: "SWAP_APPROVED",
          payload: { swapId: s.id },
        });
        const swapParties = await ctx.prisma.user.findMany({
          where: { id: { in: [s.userAId, s.userBId] } },
          select: { email: true, name: true },
        });
        const swapEmails = swapParties.map((u) => u.email).filter((e): e is string => Boolean(e));
        await sendNotification({
          event: "SWAP_APPROVED",
          summary: `Swap ${s.id} approved`,
          recipients: swapEmails.length > 0 ? swapEmails : undefined,
          details: { swapId: s.id, shiftAId: s.shiftAId, shiftBId: s.shiftBId },
        });
        return updated;
      }),

    denySwapAdmin: adminProcedure
      .input(z.object({ swapId: z.string(), note: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const s = await ctx.prisma.swapRequest.findUniqueOrThrow({
          where: { id: input.swapId },
        });
        if (s.status !== "PENDING_ADMIN") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Swap is not awaiting admin approval" });
        }
        const updated = await ctx.prisma.swapRequest.update({
          where: { id: input.swapId },
          data: {
            status: "DENIED",
            resolvedAt: new Date(),
            resolutionNote: input.note,
          },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: s.shiftAId,
          action: "SWAP_DENIED",
          payload: { swapId: s.id, note: input.note },
        });
        const deniedParties = await ctx.prisma.user.findMany({
          where: { id: { in: [s.userAId, s.userBId] } },
          select: { email: true, name: true },
        });
        const deniedEmails = deniedParties
          .map((u) => u.email)
          .filter((e): e is string => Boolean(e));
        await sendNotification({
          event: "SWAP_DENIED",
          summary: `Swap ${s.id} denied`,
          recipients: deniedEmails.length > 0 ? deniedEmails : undefined,
          details: { swapId: s.id, note: input.note },
        });
        return updated;
      }),

    listPendingSwaps: adminProcedure.query(async ({ ctx }) => {
      return ctx.prisma.swapRequest.findMany({
        where: { status: { in: ["PENDING_COUNTERPARTY", "PENDING_ADMIN"] } },
        include: {
          shiftA: { include: { site: true } },
          shiftB: { include: { site: true } },
          userA: { select: { id: true, name: true, email: true } },
          userB: { select: { id: true, name: true, email: true } },
        },
        /** Enum order puts PENDING_ADMIN after PENDING_COUNTERPARTY; use desc so admin-ready rows appear first. */
        orderBy: [{ status: "desc" }, { createdAt: "asc" }],
      });
    }),

    /** Conflict preview before approving a swap (each user takes the other's shift). */
    checkSwapConflict: adminProcedure
      .input(z.object({ swapId: z.string() }))
      .query(async ({ ctx, input }) => {
        const s = await ctx.prisma.swapRequest.findUniqueOrThrow({
          where: { id: input.swapId },
          include: { shiftA: true, shiftB: true },
        });
        const [forUserB, forUserA] = await Promise.all([
          findShiftConflicts(ctx.prisma, {
            startsAt: s.shiftA.startsAt,
            endsAt: s.shiftA.endsAt,
            assigneeId: s.userBId,
            excludeShiftId: s.shiftBId,
          }),
          findShiftConflicts(ctx.prisma, {
            startsAt: s.shiftB.startsAt,
            endsAt: s.shiftB.endsAt,
            assigneeId: s.userAId,
            excludeShiftId: s.shiftAId,
          }),
        ]);
        return {
          forUserB: { ...forUserB, summary: summarizeConflict(forUserB) },
          forUserA: { ...forUserA, summary: summarizeConflict(forUserA) },
          anyConflict: hasConflicts(forUserA) || hasConflicts(forUserB),
        };
      }),

    createChangeRequest: protectedProcedure
      .input(
        z.object({
          title: z.string(),
          body: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const cr = await ctx.prisma.changeRequest.create({
          data: {
            userId: ctx.userId,
            title: input.title,
            body: input.body,
          },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          action: "CHANGE_REQUEST_CREATED",
          payload: { changeRequestId: cr.id },
        });
        return cr;
      }),
  }),

  audit: router({
    forShift: protectedProcedure
      .input(z.object({ shiftId: z.string() }))
      .query(async ({ ctx, input }) => {
        return ctx.prisma.auditLog.findMany({
          where: { shiftId: input.shiftId },
          orderBy: { createdAt: "desc" },
          include: { actor: { select: { id: true, name: true } } },
        });
      }),
  }),

  integration: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      const accounts = await ctx.prisma.integrationAccount.findMany({
        where: { userId: ctx.userId },
        select: { provider: true, expiresAt: true },
      });
      return { connected: accounts };
    }),

    /** Placeholder: connect OAuth URL would be generated server-side per provider */
    connectOutlook: protectedProcedure.mutation(async () => {
      return {
        message: "Redirect user to Microsoft OAuth consent URL (implement with MSAL/Graph)",
        docs: "https://learn.microsoft.com/en-us/graph/auth-v2-user",
      };
    }),

    syncExternalBusy: protectedProcedure.mutation(async ({ ctx }) => {
      const blocks = await ctx.prisma.externalBusyBlock.findMany({
        where: { userId: ctx.userId },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          showTitleToUser: true,
          titleEncrypted: true,
        },
      });
      return { blocks, note: "Populate via Outlook/Qgenda sync jobs" };
    }),
  }),

  ai: router({
    pickupSuggestions: protectedProcedure
      .input(pickupSuggestionInputSchema)
      .mutation(async ({ ctx, input }) => {
        const shift = await ctx.prisma.shift.findUniqueOrThrow({
          where: { id: input.shiftId },
          include: { site: true },
        });
        const candidates = await ctx.prisma.user.findMany({
          where: {
            role: { in: ["PHYSICIAN", "APP"] },
            ...(shift.assigneeId ? { id: { not: shift.assigneeId } } : {}),
          },
          select: { id: true, name: true, role: true },
        });
        const timeOff = await ctx.prisma.timeOffEntry.findMany({
          where: {
            userId: { in: candidates.map((c) => c.id) },
            OR: [
              { startsAt: { lte: shift.endsAt }, endsAt: { gte: shift.startsAt } },
            ],
          },
        });
        const busyUserIds = new Set(timeOff.map((t) => t.userId));
        const ranked = candidates
          .filter((c) => !busyUserIds.has(c.id))
          .map((c, i) => ({
            userId: c.id,
            name: c.name,
            role: c.role,
            score: 100 - i,
            reasons: ["No overlapping time off in ShiftHub"],
          }));
        return {
          shiftId: shift.id,
          model: process.env.AI_MODEL ?? "gpt-5.2",
          suggestions: ranked.slice(0, 8),
        };
      }),

    draftNextYear: adminProcedure.input(draftYearInputSchema).mutation(async ({ ctx, input }) => {
      const source = await ctx.prisma.scheduleVersion.findUniqueOrThrow({
        where: { id: input.sourceScheduleVersionId },
        include: {
          shifts: { include: { site: true } },
        },
      });
      const draft = await ctx.prisma.scheduleVersion.create({
        data: {
          label: `AI draft ${input.targetYear}`,
          year: input.targetYear,
          status: "DRAFT",
        },
      });
      const yearDelta = input.targetYear - source.year;
      for (const s of source.shifts) {
        const starts = new Date(s.startsAt);
        const ends = new Date(s.endsAt);
        starts.setFullYear(starts.getFullYear() + yearDelta);
        ends.setFullYear(ends.getFullYear() + yearDelta);
        await ctx.prisma.shift.create({
          data: {
            scheduleVersionId: draft.id,
            siteId: s.siteId,
            coverageCategory: s.coverageCategory,
            inpatientSplit: s.inpatientSplit,
            startsAt: starts,
            endsAt: ends,
            assigneeId: s.assigneeId,
            status: "DRAFT",
          },
        });
      }
      await logAudit(ctx.prisma, {
        actorId: ctx.userId,
        action: "AI_DRAFT_SCHEDULE_CREATED",
        payload: {
          sourceId: source.id,
          draftId: draft.id,
          note: input.constraintsNote,
          model: process.env.AI_MODEL ?? "gpt-5.2",
        },
      });
      return {
        draftScheduleVersionId: draft.id,
        shiftsCopied: source.shifts.length,
        message:
          "Draft created by rolling prior-year shifts; replace with LLM-generated plan when API configured.",
      };
    }),

    /**
     * Generate conflict-free shift suggestions across one or more sites for a date range.
     *
     * Heuristic (no external LLM required):
     * - For each day in [from, to] matching `daysOfWeek`, for each `siteIds`, propose a window
     *   `[startHour, startHour + durationMinutes/60)` that fits inside `[startHour, endHour)`.
     * - Skip slots that already have a shift at the same site (uses cross-site conflict helper).
     * - Pick the lightest-loaded eligible candidate (PHYSICIAN/APP, no overlapping time off,
     *   no overlapping shift assignment across any site).
     * - Returns suggestions only — admin clicks "Create selected" to persist via shift.create.
     */
    suggestSchedule: adminProcedure
      .input(
        z.object({
          scheduleVersionId: z.string(),
          siteIds: z.array(z.string()).min(1),
          from: z.coerce.date(),
          to: z.coerce.date(),
          startHour: z.number().int().min(0).max(23).default(7),
          endHour: z.number().int().min(1).max(24).default(17),
          durationMinutes: z.number().int().min(30).max(24 * 60).default(8 * 60),
          /** JS getDay(): 0 = Sun, 1 = Mon, … 6 = Sat. Empty/undefined = every day. */
          daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
          preferRoles: z.array(z.enum(["PHYSICIAN", "APP"])).optional(),
          maxSuggestions: z.number().int().min(1).max(500).default(120),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.endHour <= input.startHour) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "endHour must be greater than startHour" });
        }
        if (input.to.getTime() <= input.from.getTime()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "`to` must be after `from`" });
        }

        const sites = await ctx.prisma.site.findMany({
          where: { id: { in: input.siteIds } },
        });
        const siteById = new Map(sites.map((s) => [s.id, s]));

        const candidates = await ctx.prisma.user.findMany({
          where: { role: { in: input.preferRoles ?? ["PHYSICIAN", "APP"] } },
          select: { id: true, name: true, role: true },
        });

        // Workload map (counts existing assigned shifts in this version) for lightest-loaded ranking.
        const existingForVersion = await ctx.prisma.shift.findMany({
          where: { scheduleVersionId: input.scheduleVersionId, assigneeId: { not: null } },
          select: { assigneeId: true },
        });
        const workload = new Map<string, number>();
        for (const s of existingForVersion) {
          if (!s.assigneeId) continue;
          workload.set(s.assigneeId, (workload.get(s.assigneeId) ?? 0) + 1);
        }

        const suggestions: Array<{
          siteId: string;
          siteName: string;
          startsAt: Date;
          endsAt: Date;
          suggestedAssigneeId: string | null;
          suggestedAssigneeName: string | null;
          reasons: string[];
        }> = [];

        const dayCursor = new Date(input.from);
        dayCursor.setHours(0, 0, 0, 0);
        const lastDay = new Date(input.to);
        lastDay.setHours(0, 0, 0, 0);

        outer: while (dayCursor.getTime() <= lastDay.getTime()) {
          const dow = dayCursor.getDay();
          if (!input.daysOfWeek || input.daysOfWeek.length === 0 || input.daysOfWeek.includes(dow)) {
            for (const siteId of input.siteIds) {
              if (suggestions.length >= input.maxSuggestions) break outer;
              const site = siteById.get(siteId);
              if (!site) continue;
              const startsAt = new Date(dayCursor);
              startsAt.setHours(input.startHour, 0, 0, 0);
              const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
              const dayEnd = new Date(dayCursor);
              dayEnd.setHours(input.endHour, 0, 0, 0);
              if (endsAt.getTime() > dayEnd.getTime()) continue;

              // Skip if site already has a shift overlapping this window.
              const conflicts = await findShiftConflicts(ctx.prisma, {
                startsAt,
                endsAt,
                siteId,
              });
              if (conflicts.siteConflicts.length > 0) continue;

              // Find best candidate: lightest workload, no time-off overlap, no cross-site assignment overlap.
              const candidateChecks = await Promise.all(
                candidates.map(async (c) => {
                  const [busy, mineConflicts] = await Promise.all([
                    ctx.prisma.timeOffEntry.findFirst({
                      where: {
                        userId: c.id,
                        startsAt: { lt: endsAt },
                        endsAt: { gt: startsAt },
                      },
                      select: { id: true },
                    }),
                    findShiftConflicts(ctx.prisma, {
                      startsAt,
                      endsAt,
                      assigneeId: c.id,
                    }),
                  ]);
                  return {
                    user: c,
                    eligible: !busy && mineConflicts.assigneeConflicts.length === 0,
                  };
                }),
              );

              const eligible = candidateChecks
                .filter((x) => x.eligible)
                .map((x) => x.user)
                .sort((a, b) => (workload.get(a.id) ?? 0) - (workload.get(b.id) ?? 0));
              const pick = eligible[0] ?? null;

              const reasons: string[] = ["Site free in window"];
              if (pick) {
                reasons.push("No time-off overlap", "No cross-site conflict");
                const w = workload.get(pick.id) ?? 0;
                reasons.push(`Lightest workload in version (${w} shifts)`);
                workload.set(pick.id, w + 1);
              } else {
                reasons.push("No eligible assignee — created as Open");
              }

              suggestions.push({
                siteId,
                siteName: site.name,
                startsAt,
                endsAt,
                suggestedAssigneeId: pick?.id ?? null,
                suggestedAssigneeName: pick?.name ?? null,
                reasons,
              });
            }
          }
          dayCursor.setDate(dayCursor.getDate() + 1);
        }

        return {
          model: process.env.AI_MODEL ?? "heuristic-balanced",
          generatedAt: new Date(),
          suggestions,
          truncated: suggestions.length >= input.maxSuggestions,
        };
      }),
  }),
});

export type AppRouter = typeof appRouter;
