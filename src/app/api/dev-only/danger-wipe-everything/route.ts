import "server-only";

import { NextResponse } from "next/server";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";

/**
 * DESTRUCTIVE, dev only. Deletes every Firestore collection and every Auth
 * user in the project. No undo. Never point it at a project with real data.
 *
 * All guards must pass:
 *   - NODE_ENV !== "production" (else 403)
 *   - ALLOW_DANGER_WIPE=1 (else 403). Any page the developer visits can POST
 *     cross-origin to a dev server without preflight, so it must be opt-in.
 *   - signed-in agency owner (else 401/403)
 *   - ?confirm=NUKE (else 400)
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Disabled in production." },
      { status: 403 },
    );
  }

  if (process.env.ALLOW_DANGER_WIPE !== "1") {
    return NextResponse.json(
      {
        error:
          "Disabled. Set ALLOW_DANGER_WIPE=1 in .env.local and restart the dev server to enable this route.",
      },
      { status: 403 },
    );
  }

  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;

  const url = new URL(request.url);
  if (url.searchParams.get("confirm") !== "NUKE") {
    return NextResponse.json(
      {
        error:
          "Pass ?confirm=NUKE to confirm. This deletes EVERY Firestore document and EVERY Firebase Auth user in this project. There is no undo.",
      },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const auth = getAdminAuth();

  // recursiveDelete walks subcollections too.
  const collections = await db.listCollections();
  const deletedCollections: string[] = [];
  for (const c of collections) {
    await db.recursiveDelete(c);
    deletedCollections.push(c.id);
  }

  // Admin SDK lists Auth users in pages of 1000.
  let authUsersDeleted = 0;
  let nextPageToken: string | undefined;
  do {
    const list = await auth.listUsers(1000, nextPageToken);
    if (list.users.length > 0) {
      const uids = list.users.map((u) => u.uid);
      const result = await auth.deleteUsers(uids);
      authUsersDeleted += result.successCount;
    }
    nextPageToken = list.pageToken;
  } while (nextPageToken);

  return NextResponse.json({
    ok: true,
    deletedCollections,
    authUsersDeleted,
    message:
      "Firestore + Auth wiped. Sign up again from /signup as the bootstrap admin.",
  });
}
