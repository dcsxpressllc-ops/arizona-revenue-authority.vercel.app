import "server-only";

/**
 * Posts to a Slack Incoming Webhook. Slack answers "ok" (200) on success and
 * a short plain-text error otherwise; 404/410 means the hook was revoked.
 */

export interface SlackMessage {
  /** Notification/fallback text; Slack shows it in previews. */
  text: string;
  blocks?: unknown[];
}

export interface SlackPostResult {
  ok: boolean;
  error: string | null;
  /** The hook is gone; posting again won't help until the URL is replaced. */
  revoked: boolean;
}

export async function postSlackMessage(
  webhookUrl: string,
  message: SlackMessage,
): Promise<SlackPostResult> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return { ok: true, error: null, revoked: false };
    const body = (await res.text().catch(() => "")).slice(0, 200);
    const revoked = res.status === 404 || res.status === 410;
    return {
      ok: false,
      revoked,
      error: revoked
        ? "Slack no longer accepts this webhook URL. Create a new one and reconnect."
        : `Slack returned ${res.status}${body ? `: ${body}` : "."}`,
    };
  } catch (err) {
    return {
      ok: false,
      revoked: false,
      error: err instanceof Error ? err.message : "Could not reach Slack.",
    };
  }
}
