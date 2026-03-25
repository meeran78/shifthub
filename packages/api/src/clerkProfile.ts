import { createClerkClient } from "@clerk/backend";
import type { User } from "@clerk/backend";
import { TRPCError } from "@trpc/server";

let clerk: ReturnType<typeof createClerkClient> | null = null;

export type ClerkSyncClientHints = {
  email?: string | null;
  name?: string | null;
  phone?: string | null;
};

function getClerk() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "CLERK_SECRET_KEY is not set (required to sync users to the database).",
    });
  }
  clerk ??= createClerkClient({ secretKey });
  return clerk;
}

function pickEmailFromClerkUser(user: User): string | undefined {
  const primary = user.primaryEmailAddress?.emailAddress?.trim();
  if (primary) return primary;
  for (const a of user.emailAddresses ?? []) {
    const e = a.emailAddress?.trim();
    if (e) return e;
  }
  for (const ex of user.externalAccounts ?? []) {
    const e = ex.emailAddress?.trim();
    if (e) return e;
  }
  return undefined;
}

function placeholderEmail(clerkUserId: string): string {
  const safe = clerkUserId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safe}@users.placeholder.shifthub`;
}

function isClerkResourceNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errors = (err as { errors?: Array<{ code?: string }> }).errors;
  if (Array.isArray(errors) && errors.some((e) => e.code === "resource_not_found")) return true;
  const status = (err as { status?: number }).status;
  if (status === 404) return true;
  return false;
}

function profileFromHints(
  clerkUserId: string,
  hints: ClerkSyncClientHints | null | undefined,
): { email: string; name: string; phone: string | undefined } {
  const email =
    hints?.email?.trim() ||
    placeholderEmail(clerkUserId);
  const name = hints?.name?.trim() || "User";
  const phone = hints?.phone?.trim() || undefined;
  return { email, name, phone };
}

/**
 * Load identity from Clerk (server-side), with client hints when the Backend API cannot
 * resolve the user (e.g. `resource_not_found` when publishable + secret keys are from
 * different Clerk applications, or the user was deleted server-side).
 */
export async function getClerkProfileForSync(
  clerkUserId: string,
  hints?: ClerkSyncClientHints | null,
): Promise<{
  email: string;
  name: string;
  phone: string | undefined;
}> {
  try {
    const user = await getClerk().users.getUser(clerkUserId);
    let email =
      pickEmailFromClerkUser(user) ??
      (hints?.email?.trim() && hints.email.includes("@") ? hints.email.trim() : undefined);

    if (!email) {
      email = placeholderEmail(clerkUserId);
    }

    const name =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
      user.username ||
      hints?.name?.trim() ||
      "User";
    const phone = user.phoneNumbers[0]?.phoneNumber ?? hints?.phone?.trim() ?? undefined;
    return { email, name, phone };
  } catch (err) {
    if (isClerkResourceNotFound(err)) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "[clerk] users.getUser resource_not_found — using client hints. " +
            "If this persists, confirm NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are from the same Clerk application.",
        );
      }
      return profileFromHints(clerkUserId, hints);
    }
    const message = err instanceof Error ? err.message : "Clerk Backend API error.";
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message,
      cause: err,
    });
  }
}
