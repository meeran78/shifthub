import type { Role } from "@shifthub/db";
import { prisma } from "@shifthub/db";

export type ApiContext = {
  prisma: typeof prisma;
  userId: string | null;
  role: Role | null;
  clerkId: string | null;
};

export async function createContext(opts: {
  clerkId: string | null;
}): Promise<ApiContext> {
  const { clerkId } = opts;
  if (!clerkId) {
    return { prisma, userId: null, role: null, clerkId: null };
  }
  const user = await prisma.user.findUnique({ where: { clerkId } });
  return {
    prisma,
    userId: user?.id ?? null,
    role: user?.role ?? null,
    clerkId,
  };
}
