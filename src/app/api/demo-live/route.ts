import { NextResponse } from "next/server";
import { LIVE_DEMO_URL, liveDemoOpen } from "@/lib/phala-demo/live-session";

export const runtime = "nodejs";

/** État public de la session de training : `{ open }`, mis en cache 30 secondes. */
export async function GET() {
  let open = false;
  try {
    const response = await fetch(new URL("/api/phala-demo/session", LIVE_DEMO_URL), {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      next: { revalidate: 30 },
    });
    open = response.ok && liveDemoOpen(await response.json());
  } catch {
    open = false;
  }
  return NextResponse.json({ open, url: LIVE_DEMO_URL }, { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=30" } });
}
