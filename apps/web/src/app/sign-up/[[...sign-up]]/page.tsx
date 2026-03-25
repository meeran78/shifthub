import Link from "next/link";
import { ClerkSignUp } from "@/components/clerk-sign-up";

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-8 sm:p-6">
      <div className="w-full max-w-md">
        <ClerkSignUp />
      </div>
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        Back to home
      </Link>
    </main>
  );
}
