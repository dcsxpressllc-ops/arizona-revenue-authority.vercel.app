import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { LATEST_API_VERSION } from "./versions";

/**
 * Stripe-style response helpers. Every response carries `X-Request-Id` (also
 * stored on apiRequestLogs) and `LeadStack-Version` (the version actually used).
 *
 * Error body is always { error: { type, code, message, request_id, doc_url? } }.
 * Consumers switch on `code`, so new codes don't break anyone.
 */

export type ErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request"
  | "rate_limit_error"
  | "idempotency_error"
  | "not_found"
  | "internal_error";

export interface ApiErrorBody {
  error: {
    type: ErrorType;
    code: string;
    message: string;
    request_id: string;
    /** Deep link into /docs/api for this error. */
    doc_url?: string;
  };
}

const STATUS_FOR_TYPE: Record<ErrorType, number> = {
  authentication_error: 401,
  permission_error: 403,
  invalid_request: 400,
  rate_limit_error: 429,
  idempotency_error: 409,
  not_found: 404,
  internal_error: 500,
};

export function newRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

export interface ResponseMeta {
  requestId: string;
  apiVersion: string;
}

function metaHeaders(meta: ResponseMeta): Record<string, string> {
  return {
    "X-Request-Id": meta.requestId,
    "LeadStack-Version": meta.apiVersion,
  };
}

export function apiOk<T>(
  meta: ResponseMeta,
  body: T,
  init?: { status?: number; headers?: Record<string, string> },
): NextResponse {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { ...metaHeaders(meta), ...(init?.headers ?? {}) },
  });
}

export function apiError(
  meta: ResponseMeta | null,
  type: ErrorType,
  code: string,
  message: string,
  opts: {
    docUrl?: string;
    status?: number;
    extraHeaders?: Record<string, string>;
  } = {},
): NextResponse {
  // Meta is null when we fail before auth (e.g. bad version header). Still mint a
  // request id so the error is greppable.
  const resolvedMeta: ResponseMeta = meta ?? {
    requestId: newRequestId(),
    apiVersion: LATEST_API_VERSION,
  };
  const body: ApiErrorBody = {
    error: {
      type,
      code,
      message,
      request_id: resolvedMeta.requestId,
      ...(opts.docUrl ? { doc_url: opts.docUrl } : {}),
    },
  };
  return NextResponse.json(body, {
    status: opts.status ?? STATUS_FOR_TYPE[type],
    headers: { ...metaHeaders(resolvedMeta), ...(opts.extraHeaders ?? {}) },
  });
}
