"use client";

import { ClerkLoaded, ClerkLoading, SignIn } from "@clerk/nextjs";

export function ClerkSignIn() {
  return (
    <>
      <ClerkLoading>
        <div className="flex min-h-[24rem] w-full items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
          Loading sign-in…
        </div>
      </ClerkLoading>
      <ClerkLoaded>
        <SignIn
          routing="path"
          path="/sign-in"
          signUpUrl="/sign-up"
          forceRedirectUrl="/schedule"
          fallbackRedirectUrl="/schedule"
        />
      </ClerkLoaded>
    </>
  );
}
