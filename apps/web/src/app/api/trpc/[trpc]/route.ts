import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@shifthub/api";
import { createTRPCContext } from "@/server/api";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: createTRPCContext,
  });

export { handler as GET, handler as POST };
