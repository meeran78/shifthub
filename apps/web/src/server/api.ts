import { auth } from "@clerk/nextjs/server";
import { createContext } from "@shifthub/api";

export async function createTRPCContext() {
  const { userId } = await auth();
  return createContext({ clerkId: userId ?? null });
}
