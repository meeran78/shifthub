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

    create: adminProcedure.input(createShiftInputSchema).mutation(async ({ ctx, input }) => {
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
        payload: { shiftId: shift.id },
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
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        const prev = await ctx.prisma.shift.findUniqueOrThrow({ where: { id } });
        const shift = await ctx.prisma.shift.update({
          where: { id },
          data,
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: shift.id,
          action: "SHIFT_UPDATED",
          payload: { before: prev, after: shift },
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
        return g;
      }),

    requestPickup: protectedProcedure
      .input(
        z.object({
          shiftId: z.string(),
          preferredStartsAt: z.coerce.date().optional(),
          preferredEndsAt: z.coerce.date().optional(),
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
          if (durMin < 15 || durMin > 30) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Preferred slot must be between 15 and 30 minutes",
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
        const pickup = await ctx.prisma.pickupRequest.create({
          data: {
            shiftId: input.shiftId,
            requesterId: ctx.userId,
            status: "PENDING",
            locksSlot: true,
            preferredStartsAt,
            preferredEndsAt,
          },
        });
        await logAudit(ctx.prisma, {
          actorId: ctx.userId,
          shiftId: shift.id,
          action: "PICKUP_REQUESTED",
          payload: { requestId: pickup.id, locked: true },
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
        return pickup;
      }),

    approvePickup: adminProcedure
      .input(z.object({ requestId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const p = await ctx.prisma.pickupRequest.findUniqueOrThrow({
          where: { id: input.requestId },
        });
        await ctx.prisma.shift.update({
          where: { id: p.shiftId },
          data: { assigneeId: p.requesterId },
        });
        const updated = await ctx.prisma.pickupRequest.update({
          where: { id: input.requestId },
          data: { status: "APPROVED", resolvedAt: new Date() },
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
          payload: { requestId: p.id },
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
        return updated;
      }),

    listPendingPickups: adminProcedure.query(async ({ ctx }) => {
      return ctx.prisma.pickupRequest.findMany({
        where: { status: "PENDING" },
        include: {
          shift: { include: { site: true } },
          requester: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
      });
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
          select: { id: true, shiftId: true, requesterId: true },
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
        return updated;
      }),

    listPendingSwaps: adminProcedure.query(async ({ ctx }) => {
      return ctx.prisma.swapRequest.findMany({
        where: { status: "PENDING_ADMIN" },
        include: {
          shiftA: { include: { site: true } },
          shiftB: { include: { site: true } },
          userA: { select: { id: true, name: true, email: true } },
          userB: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "asc" },
      });
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
  }),
});

export type AppRouter = typeof appRouter;
