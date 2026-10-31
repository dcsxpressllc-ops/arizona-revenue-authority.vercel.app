/**
 * Sub-account-scoped Bearer API keys: `lsk_<mode>_<prefix>_<secret>`.
 * `test` keys hit parallel `_test` subcollections and skip every external
 * side-effect (no Resend/Twilio sends, no outbound webhooks), so integrations
 * can be built without touching real data or burning credits.
 * Only the SHA-256 of the full key is stored; the raw key is shown once.
 */
export type ApiKeyMode = "live" | "test";

/**
 * Stored as a list so finer scopes ("contacts:read", ...) can be added later
 * without a migration.
 * - `admin`: full CRUD, server-to-server only. Never embed in a browser.
 * - `forms-ingest`: only `POST /api/v1/forms/{id}/submissions`. Safe for
 *   client-side JS (CORS is open for this scope only).
 */
export type ApiKeyScope = "admin" | "forms-ingest";

/**
 * `subAccounts/{subAccountId}/apiKeys/{keyId}`. Server-only (rules deny
 * clients); the UI goes through the `/api/sub-accounts/{id}/api-keys` routes.
 */
export interface ApiKeyDoc {
  id: string;
  subAccountId: string;
  agencyId: string;
  /** Operator label, e.g. "Zapier production". */
  name: string;
  mode: ApiKeyMode;
  /**
   * First 8 chars of the secret. Auth looks the doc up by prefix, then
   * constant-time-compares the hash. Safe to store in clear (no forgery value)
   * and it's what the UI and logs show to identify a key.
   */
  prefix: string;
  /** SHA-256 hex of the full key string. */
  hashedSecret: string;
  scopes: ApiKeyScope[];
  /**
   * Version used when a request omits `LeadStack-Version`. Absent on older
   * keys, which fall back to latest.
   */
  defaultVersion?: string;
  createdByUid: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedByUid: string | null;
}

/**
 * Wire shape of `ApiKeyDoc` without `hashedSecret`. `secret` is set only on
 * the create response; the UI uses that for the "copy it now" banner.
 */
export interface ApiKeyResponse {
  id: string;
  name: string;
  mode: ApiKeyMode;
  prefix: string;
  scopes: ApiKeyScope[];
  defaultVersion?: string;
  createdByUid: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Full key, create response only. */
  secret?: string;
}

/**
 * One row of the Logs -> API viewer, from `subAccounts/{id}/apiRequestLogs`.
 * Header/body excerpts are sanitized and truncated at capture time.
 */
export interface ApiRequestLogResponse {
  id: string;
  requestId: string;
  mode: ApiKeyMode;
  keyPrefix: string;
  method: string;
  path: string;
  query: string;
  responseStatus: number;
  errorCode: string | null;
  latencyMs: number;
  createdAt: string;
  /** JSON string of request headers, auth headers dropped. */
  requestHeaders: string;
  /** Truncated to 2KB. */
  requestBody: string;
  /** Truncated to 2KB. */
  responseBody: string;
}
