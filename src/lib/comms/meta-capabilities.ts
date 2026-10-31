/**
 * Client-safe helpers for what a stored Meta connection can do. Kept out of
 * lib/comms/meta.ts (server-only) so the settings card and Social Planner can
 * use them. Source of truth is `metaConfig.capabilities`, stamped at connect
 * time from granted permissions intersected with the agency gates.
 */

export interface MetaCapabilities {
  inbox: boolean;
  publish: boolean;
  /**
   * Needs `instagram_manage_messages`, which users can decline separately from
   * `pages_messaging`. Older connections lack the field and fall back to `inbox`.
   */
  instagramDm?: boolean;
}

interface CapabilityCarrier {
  connected?: boolean;
  capabilities?: MetaCapabilities;
}

/**
 * Granted scopes intersected with the enabled gates: `inbox` needs
 * pages_messaging, `instagramDm` also needs instagram_manage_messages (so
 * Messenger working never implies IG DMs do), `publish` needs pages_manage_posts.
 * A gate that's off forces its capability false.
 */
export function deriveMetaCapabilities(
  granted: Set<string>,
  gates: { inbox: boolean; publish: boolean },
): MetaCapabilities {
  return {
    inbox: gates.inbox && granted.has("pages_messaging"),
    instagramDm: gates.inbox && granted.has("instagram_manage_messages"),
    publish: gates.publish && granted.has("pages_manage_posts"),
  };
}

/** Connections with no capabilities recorded are assumed yes. */
export function metaCanInbox(cfg: CapabilityCarrier | null | undefined): boolean {
  if (!cfg?.connected) return false;
  return cfg.capabilities ? cfg.capabilities.inbox : true;
}

/** No capabilities recorded: assume yes, like metaCanInbox. No `instagramDm` field: fall back to `inbox`. */
export function metaCanInstagramDm(
  cfg: CapabilityCarrier | null | undefined,
): boolean {
  if (!cfg?.connected) return false;
  if (!cfg.capabilities) return true;
  return cfg.capabilities.instagramDm ?? cfg.capabilities.inbox;
}

/** Connections with no capabilities recorded must reconnect to publish. */
export function metaCanPublish(
  cfg: CapabilityCarrier | null | undefined,
): boolean {
  return !!(cfg?.connected && cfg.capabilities?.publish);
}
