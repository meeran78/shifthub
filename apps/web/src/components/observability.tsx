"use client";

import { useEffect, useRef } from "react";

/**
 * Initializes browser observability when public env vars are set (Sentry, Datadog RUM).
 * Server-side agents should be configured separately in hosting (Vercel/Datadog integration).
 */
export function Observability() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (sentryDsn) {
      void import("@sentry/browser").then((Sentry) => {
        Sentry.init({
          dsn: sentryDsn,
          tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
          environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
        });
      });
    }

    const ddAppId = process.env.NEXT_PUBLIC_DATADOG_APPLICATION_ID;
    const ddClient = process.env.NEXT_PUBLIC_DATADOG_CLIENT_TOKEN;
    if (ddAppId && ddClient && typeof window !== "undefined") {
      void import("@datadog/browser-rum").then(({ datadogRum }) => {
        datadogRum.init({
          applicationId: ddAppId,
          clientToken: ddClient,
          site: process.env.NEXT_PUBLIC_DATADOG_SITE ?? "datadoghq.com",
          service: "shifthub-web",
          env: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
          sessionSampleRate: 100,
          sessionReplaySampleRate: 0,
          defaultPrivacyLevel: "mask-user-input",
        });
      });
    }
  }, []);

  return null;
}
