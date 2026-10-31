import "server-only";

/**
 * Minimal Vercel REST client for the setup form: list env var names (never
 * values), upsert vars, and trigger a redeploy (env is baked at build time,
 * especially NEXT_PUBLIC_*). Needs VERCEL_TOKEN + VERCEL_PROJECT_ID, plus
 * VERCEL_TEAM_ID for team projects. The deploy hook URL needs no token.
 */

import {
  cloudVercelProxyActive,
  proxyLatestDeployment,
  proxyListEnvKeys,
  proxyTriggerRedeploy,
  proxyUpsertEnvVars,
} from "@/lib/cloud-instance/vercel-proxy";

const API = "https://api.vercel.com";

// Cloud-hosted instances have no Vercel token; these operations proxy to the
// hosting control plane (lib/cloud-instance/vercel-proxy.ts). Only active when
// CLOUD_INSTANCE_ID/TOKEN are set.

export class VercelError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "VercelError";
    this.status = status;
  }
}

/** Preflight vars present; enables the setup-form toggle. TEAM_ID isn't required
 *  (personal accounts have none). */
export function vercelConfigured(): boolean {
  if (cloudVercelProxyActive()) return true;
  return (
    !!process.env.VERCEL_TOKEN?.trim() &&
    !!process.env.VERCEL_PROJECT_ID?.trim() &&
    !!process.env.VERCEL_DEPLOY_HOOK_URL?.trim()
  );
}

/** Readiness for funnel subdomains. No deploy hook needed: attaching a domain
 *  doesn't redeploy. */
export function vercelDomainsConfigured(): boolean {
  return (
    !!process.env.VERCEL_TOKEN?.trim() && !!process.env.VERCEL_PROJECT_ID?.trim()
  );
}

/**
 * Attach a hostname (e.g. `7dsummer.leadstack.dev`) to the project. With a
 * wildcard CNAME already in place this is the only per-subdomain step; Vercel
 * issues the cert within a minute or two. A 409 (already on this project)
 * counts as success.
 */
export async function addProjectDomain(hostname: string): Promise<void> {
  const { token, projectId, teamId } = requireConfig();
  const res = await fetch(
    url(`/v10/projects/${projectId}/domains`, teamId),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: hostname }),
    },
  );
  if (res.ok || res.status === 409) return;
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  throw new VercelError(
    body.error?.message ?? `Couldn't add ${hostname} (HTTP ${res.status})`,
    res.status,
  );
}

/** Best-effort at call sites; a leftover domain just serves a 404 funnel. */
export async function removeProjectDomain(hostname: string): Promise<void> {
  const { token, projectId, teamId } = requireConfig();
  const res = await fetch(
    url(`/v9/projects/${projectId}/domains/${encodeURIComponent(hostname)}`, teamId),
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  // 404 = already gone.
  if (res.ok || res.status === 404) return;
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  throw new VercelError(
    body.error?.message ?? `Couldn't remove ${hostname} (HTTP ${res.status})`,
    res.status,
  );
}

function requireConfig(): { token: string; projectId: string; teamId?: string } {
  const token = process.env.VERCEL_TOKEN?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) {
    throw new VercelError(
      "Vercel is not configured — set VERCEL_TOKEN + VERCEL_PROJECT_ID.",
    );
  }
  const teamId = process.env.VERCEL_TEAM_ID?.trim() || undefined;
  return { token, projectId, teamId };
}

function url(path: string, teamId?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  if (teamId) params.set("teamId", teamId);
  const qs = params.toString();
  return `${API}${path}${qs ? `?${qs}` : ""}`;
}

async function vercelFetch(
  path: string,
  init: RequestInit,
  teamId?: string,
  extra?: Record<string, string>,
): Promise<unknown> {
  const { token } = requireConfig();
  let res: Response;
  try {
    res = await fetch(url(path, teamId, extra), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      // Never cache credentialed control-plane calls.
      cache: "no-store",
    });
  } catch (e) {
    throw new VercelError(
      `Couldn't reach Vercel: ${(e as Error).message}`,
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body; leave null.
  }
  if (!res.ok) {
    const errObj = json as { error?: { message?: string } } | null;
    const msg = errObj?.error?.message || text || res.statusText;
    throw new VercelError(`Vercel API ${res.status}: ${msg}`, res.status);
  }
  return json;
}

// Env vars

interface VercelEnvEntry {
  id: string;
  key: string;
  target?: string[] | string;
  type?: string;
}

/** Env var names + metadata keyed by name. Never decrypts values; presence is
 *  all the form needs. */
export async function listEnvKeys(): Promise<
  Map<string, { id: string; target: string[] }>
> {
  if (cloudVercelProxyActive()) return await proxyListEnvKeys();
  const { projectId, teamId } = requireConfig();
  const data = (await vercelFetch(
    `/v9/projects/${projectId}/env`,
    { method: "GET" },
    teamId,
    { decrypt: "false" },
  )) as { envs?: VercelEnvEntry[] };

  const out = new Map<string, { id: string; target: string[] }>();
  for (const e of data.envs ?? []) {
    if (!e.key || !e.id) continue;
    const target = Array.isArray(e.target)
      ? e.target
      : e.target
        ? [e.target]
        : [];
    // First entry per key wins.
    if (!out.has(e.key)) out.set(e.key, { id: e.id, target });
  }
  return out;
}

export interface UpsertResult {
  key: string;
  ok: boolean;
  action?: "created" | "updated";
  error?: string;
}

/** Create-or-update against Production: PATCH existing by id, POST new ones.
 *  Never deletes anything. */
export async function upsertEnvVars(
  vars: { key: string; value: string }[],
): Promise<UpsertResult[]> {
  if (cloudVercelProxyActive()) return await proxyUpsertEnvVars(vars);
  const { projectId, teamId } = requireConfig();
  const existing = await listEnvKeys();
  const results: UpsertResult[] = [];

  for (const { key, value } of vars) {
    try {
      const current = existing.get(key);
      if (current) {
        await vercelFetch(
          `/v10/projects/${projectId}/env/${current.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ value, target: ["production"] }),
          },
          teamId,
        );
        results.push({ key, ok: true, action: "updated" });
      } else {
        await vercelFetch(
          `/v10/projects/${projectId}/env`,
          {
            method: "POST",
            body: JSON.stringify({
              key,
              value,
              type: "encrypted",
              target: ["production"],
            }),
          },
          teamId,
        );
        results.push({ key, ok: true, action: "created" });
      }
    } catch (e) {
      results.push({ key, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

// Deploy

/** Fire the Deploy Hook. The hook URL is the credential. */
export async function triggerRedeploy(): Promise<{ ok: boolean; id?: string }> {
  if (cloudVercelProxyActive()) return await proxyTriggerRedeploy();
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL?.trim();
  if (!hook) throw new VercelError("VERCEL_DEPLOY_HOOK_URL is not set.");
  let res: Response;
  try {
    res = await fetch(hook, { method: "POST", cache: "no-store" });
  } catch (e) {
    throw new VercelError(`Couldn't reach the deploy hook: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new VercelError(
      `Deploy hook returned ${res.status}: ${await res.text()}`,
      res.status,
    );
  }
  const json = (await res.json().catch(() => null)) as {
    job?: { id?: string };
  } | null;
  return { ok: true, id: json?.job?.id };
}

/** Latest deployment state for the rebuild poller. Null instead of throwing. */
export async function getLatestDeploymentState(): Promise<{
  id: string;
  state: string;
} | null> {
  if (cloudVercelProxyActive()) return await proxyLatestDeployment();
  try {
    const { projectId, teamId } = requireConfig();
    const data = (await vercelFetch(
      `/v6/deployments`,
      { method: "GET" },
      teamId,
      { projectId, limit: "1" },
    )) as {
      deployments?: { uid?: string; state?: string; readyState?: string }[];
    };
    const d = data.deployments?.[0];
    if (!d?.uid) return null;
    return { id: d.uid, state: d.state ?? d.readyState ?? "UNKNOWN" };
  } catch {
    return null;
  }
}
