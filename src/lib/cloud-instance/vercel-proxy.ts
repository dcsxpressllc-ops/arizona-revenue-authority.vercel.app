import "server-only";

/**
 * Forwards the setup form's Vercel operations on a Cloud instance. Ships in the
 * template but is inert without CLOUD_INSTANCE_ID + CLOUD_INSTANCE_TOKEN.
 *
 * Hosted instances have no Vercel token of their own, so env reads/writes and
 * redeploys go to the Cloud control plane's per-instance env API with the
 * instance bearer token, which applies them and refuses provisioner-owned keys.
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

export function cloudVercelProxyActive(): boolean {
  return cloudEnv() !== null;
}

// Provisioner-owned keys. The control plane's env route has the authoritative
// list (keep in sync); the setup form shows these read-only instead of
// letting a write fail.
const MANAGED_KEY_RE =
  /^(NEXT_PUBLIC_FIREBASE_|FIREBASE_ADMIN_|COOKIE_SECRET_|CLOUD_|VERCEL_|GITHUB_|STRIPE_CLOUD_)/;
const MANAGED_KEYS = new Set([
  "NEXT_PUBLIC_APP_URL",
  "BOOTSTRAP_ADMIN_EMAIL",
  "AUTOMATIONS_TOKEN_SECRET",
  "NEXT_PUBLIC_CLOUD",
  "MOTHERSHIP_API_URL",
]);

/** On a Cloud instance, a key the buyer can't (and needn't) edit. */
export function isCloudManagedKey(name: string): boolean {
  if (!cloudVercelProxyActive()) return false;
  return MANAGED_KEY_RE.test(name) || MANAGED_KEYS.has(name);
}

async function call<T>(init: {
  method: "GET" | "POST";
  body?: Record<string, unknown>;
}): Promise<T> {
  const env = cloudEnv();
  if (!env) throw new Error("Cloud proxy is not active");
  const res = await fetch(
    `${env.base}/api/cloud/instances/${encodeURIComponent(env.id)}/env`,
    {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.token}`,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    },
  );
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      data.error ?? `Hosting control plane returned ${res.status}`,
    );
  }
  return data;
}

export async function proxyListEnvKeys(): Promise<
  Map<string, { id: string; target: string[] }>
> {
  const data = await call<{
    keys: Array<{ key: string; id: string; target: string[] }>;
  }>({ method: "GET" });
  const out = new Map<string, { id: string; target: string[] }>();
  for (const k of data.keys ?? []) out.set(k.key, { id: k.id, target: k.target });
  return out;
}

export async function proxyUpsertEnvVars(
  vars: { key: string; value: string }[],
): Promise<
  Array<{ key: string; ok: boolean; action?: "created" | "updated"; error?: string }>
> {
  const data = await call<{
    results: Array<{
      key: string;
      ok: boolean;
      action?: "created" | "updated";
      error?: string;
    }>;
  }>({ method: "POST", body: { action: "upsert", vars } });
  return data.results ?? [];
}

export async function proxyTriggerRedeploy(): Promise<{
  ok: boolean;
  id?: string;
}> {
  const data = await call<{ ok: boolean; id?: string }>({
    method: "POST",
    body: { action: "redeploy" },
  });
  return { ok: !!data.ok, id: data.id };
}

export async function proxyLatestDeployment(): Promise<{
  id: string;
  state: string;
} | null> {
  try {
    const data = await call<{ deployment: { id: string; state: string } | null }>(
      { method: "POST", body: { action: "deployment" } },
    );
    return data.deployment;
  } catch {
    return null;
  }
}
