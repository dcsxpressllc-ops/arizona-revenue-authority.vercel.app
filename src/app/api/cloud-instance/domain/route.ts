import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";

export const dynamic = "force-dynamic";

/**
 * Custom-domain proxy for Cloud-hosted deployments. Ships in the buyer
 * template but 404s unless CLOUD_INSTANCE_ID/TOKEN are set (only the Cloud
 * provisioner sets them). Forwards the owner's request to the Cloud control plane with
 * the server-held token, so the browser never sees it.
 */

function cloudEnv(): { id: string; token: string; base: string } | null {
  const id = process.env.CLOUD_INSTANCE_ID?.trim();
  const token = process.env.CLOUD_INSTANCE_TOKEN?.trim();
  if (!id || !token) return null;
  const base = (
    process.env.CLOUD_MOTHERSHIP_URL ?? "https://www.leadstack.dev"
  ).replace(/\/$/, "");
  return { id, token, base };
}

async function forward(
  env: { id: string; token: string; base: string },
  init: RequestInit,
): Promise<NextResponse> {
  try {
    const res = await fetch(
      `${env.base}/api/cloud/instances/${encodeURIComponent(env.id)}/domain`,
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.token}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "Couldn't reach the hosting control plane. Try again." },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  const env = cloudEnv();
  if (!env) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  return await forward(env, { method: "GET" });
}

export async function POST(request: Request) {
  const env = cloudEnv();
  if (!env) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;
  const body = await request.text();
  return await forward(env, { method: "POST", body });
}
