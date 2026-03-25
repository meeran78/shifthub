"use client";

import Link from "next/link";
import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";
import { TRPCProvider } from "@/trpc/react";

const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ?? "";

export function Providers({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "development" && !publishableKey) {
    console.warn(
      "[Clerk] NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is empty. Set it in .env.local (repo root or apps/web) or use keyless mode, then restart `next dev` and delete `.next`.",
    );
  }

  return (
    <ClerkProvider
      {...(publishableKey ? { publishableKey } : {})}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
      appearance={{
        baseTheme: shadcn,
      }}
    >
      <TRPCProvider>
        <header className="sticky top-0 z-50 flex w-full items-center justify-between gap-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <Link href="/" className="text-lg font-semibold tracking-tight text-foreground">
            GSI ShiftHub
          </Link>
          <nav className="flex items-center gap-2">
            <Show when="signed-out">
              <SignInButton />
              <SignUpButton />
            </Show>
            <Show when="signed-in">
              <UserButton />
            </Show>
          </nav>
        </header>
        {children}
      </TRPCProvider>
    </ClerkProvider>
  );
}
