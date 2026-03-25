"use client";

import { ClerkLoaded, ClerkLoading, SignUp } from "@clerk/nextjs";

export function ClerkSignUp() {
  return (
    <>
      <ClerkLoading>
        <div className="flex min-h-[24rem] w-full items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
          Loading sign-up…
        </div>
      </ClerkLoading>
      <ClerkLoaded>
        <SignUp
          routing="path"
          path="/sign-up"
          signInUrl="/sign-in"
          forceRedirectUrl="/schedule"
          fallbackRedirectUrl="/schedule"
        />
      </ClerkLoaded>
    </>
  );
}
