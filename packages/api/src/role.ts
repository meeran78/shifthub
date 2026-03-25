import type { Role } from "@shifthub/db";

/**
 * Roles and profiles are stored only in Postgres (Neon). Clerk is used for authentication only.
 *
 * - New users: default PHYSICIAN, unless email is in ADMIN_EMAILS (local dev / bootstrap).
 * - Existing users: role is preserved from the database; only ADMIN_EMAILS can force ADMIN.
 */
export function resolveRoleForSync(email: string, existingRole: Role | undefined): Role {
  const normalized = email.trim().toLowerCase();
  const allowlist =
    process.env.ADMIN_EMAILS?.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean) ?? [];
  if (allowlist.includes(normalized)) {
    return "ADMIN";
  }
  if (existingRole) {
    return existingRole;
  }
  return "PHYSICIAN";
}
