import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { ApiContext } from "./context";

const t = initTRPC.context<ApiContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        code: error.code,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

const enforceClerk = t.middleware(({ ctx, next }) => {
  if (!ctx.clerkId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      clerkId: ctx.clerkId,
    },
  });
});

export const clerkProcedure = t.procedure.use(enforceClerk);

const enforceUser = t.middleware(({ ctx, next }) => {
  if (!ctx.userId || !ctx.role || !ctx.clerkId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      userId: ctx.userId,
      role: ctx.role,
      clerkId: ctx.clerkId,
    },
  });
});

export const protectedProcedure = t.procedure.use(enforceUser);

const enforceAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.userId || ctx.role !== "ADMIN") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({
    ctx: {
      ...ctx,
      userId: ctx.userId,
      role: ctx.role,
    },
  });
});

export const adminProcedure = t.procedure.use(enforceUser).use(enforceAdmin);
