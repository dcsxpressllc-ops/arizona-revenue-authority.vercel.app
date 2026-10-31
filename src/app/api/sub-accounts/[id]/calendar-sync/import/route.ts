import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  calendarConnectionRef,
  googleCalendarConfigured,
} from "@/lib/google/calendar";
import {
  runCalendarImport,
  setImportMode,
  setWorkspaceImportAllowed,
  workspaceAllowsImport,
} from "@/lib/google/calendar-import";
import { runAfterResponse } from "@/lib/server/after-response";
import type {
  CalendarConnectionDoc,
  CalendarImportMode,
} from "@/types/calendar-sync";
import type { SubAccountDoc } from "@/types";

export const maxDuration = 60;

/**
 * Google Calendar import settings. One of:
 *   { allowWorkspace: boolean }  admin: the workspace switch (off wipes every import)
 *   { mode: "off"|"busy"|"details" }  the caller's OWN calendar only
 *   { syncNow: true }  the caller's own calendar, full pass, awaited
 * There is deliberately no way to set another member's mode.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: { allowWorkspace?: unknown; mode?: unknown; syncNow?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sub = (
    await getAdminDb().doc(`subAccounts/${subAccountId}`).get()
  ).data() as SubAccountDoc | undefined;
  if (!sub) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }

  if (typeof body.allowWorkspace === "boolean") {
    const isAdmin =
      access.subAccountRole === "admin" ||
      access.subAccountRole === "agencyOwner";
    if (!isAdmin) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }
    if (body.allowWorkspace && !googleCalendarConfigured()) {
      return NextResponse.json(
        { error: "Google Calendar isn't configured on this deployment." },
        { status: 503 },
      );
    }
    // Off removes every import now and resets everyone to Off.
    const removed = await setWorkspaceImportAllowed(
      subAccountId,
      body.allowWorkspace,
    );
    return NextResponse.json({ ok: true, removed });
  }

  const connSnap = await calendarConnectionRef(subAccountId, access.uid).get();
  const conn = connSnap.exists ? (connSnap.data() as CalendarConnectionDoc) : null;

  if (body.mode !== undefined) {
    const mode = body.mode as CalendarImportMode;
    if (mode !== "off" && mode !== "busy" && mode !== "details") {
      return NextResponse.json(
        { error: "mode must be off, busy or details" },
        { status: 400 },
      );
    }
    // Off always works and always clears, even if the switch or connection
    // went away first.
    if (mode !== "off") {
      if (!workspaceAllowsImport(sub)) {
        return NextResponse.json(
          { error: "An admin hasn't allowed Google Calendar import in this workspace." },
          { status: 403 },
        );
      }
      if (!conn || conn.status !== "connected") {
        return NextResponse.json(
          { error: "Connect your Google Calendar first." },
          { status: 400 },
        );
      }
    }
    const removed = await setImportMode(subAccountId, access.uid, mode);
    if (mode !== "off") {
      runAfterResponse(() =>
        runCalendarImport(subAccountId, access.uid, { full: true }),
      );
    }
    return NextResponse.json({ ok: true, removed });
  }

  if (body.syncNow === true) {
    if (!conn || !workspaceAllowsImport(sub)) {
      return NextResponse.json({ error: "Import isn't on." }, { status: 400 });
    }
    const result = await runCalendarImport(subAccountId, access.uid, {
      full: true,
      deadlineMs: Date.now() + 45_000,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "Sync failed.", result },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, result });
  }

  return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
}
