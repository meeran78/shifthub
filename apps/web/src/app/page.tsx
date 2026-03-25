import Link from "next/link";
import { Show } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 p-6">
      <div className="space-y-2 text-center">
        <h1 className="text-4xl font-bold tracking-tight">GSI ShiftHub</h1>
        <p className="text-lg text-muted-foreground">
          Schedules for physicians and APPs—clear, auditable, and easy to use.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Get started</CardTitle>
          <CardDescription>
            Sign in to view your week timeline, request swaps, and see updates in one place.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Show when="signed-out">
            <Button asChild size="lg" className="text-base">
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </Show>
          <Show when="signed-in">
            <Button asChild size="lg" className="text-base">
              <Link href="/schedule">Open schedule</Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="text-base">
              <Link href="/admin">Admin tools</Link>
            </Button>
          </Show>
        </CardContent>
      </Card>
      <p className="text-center text-sm text-muted-foreground">
        Large buttons and simple language—built for busy clinical teams.
      </p>
    </main>
  );
}
