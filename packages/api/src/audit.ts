import type { Prisma, PrismaClient } from "@shifthub/db";

export async function logAudit(
  prisma: PrismaClient,
  input: {
    actorId: string;
    shiftId?: string | null;
    action: string;
    payload: Prisma.InputJsonValue;
  },
) {
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      shiftId: input.shiftId,
      action: input.action,
      payload: input.payload,
    },
  });
}
