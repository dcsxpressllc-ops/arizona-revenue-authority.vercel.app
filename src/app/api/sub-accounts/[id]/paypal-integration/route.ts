import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import type { PayPalConfig } from "@/types";

/**
 * PayPal connection for Products + Invoices. Uses paypal.me links: the
 * operator saves a username and invoices link to
 * `https://paypal.me/{username}/{amount}{currency}`.
 *
 * POST { username }: 1-20 chars, alphanumerics and hyphens; a pasted
 * paypal.me/ prefix is stripped. DELETE clears it.
 *
 * Not checked against paypal.me (rate-limited and unreliable); a wrong
 * username shows up as PayPal's "no such account" page.
 */

const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,18}[A-Za-z0-9])?$/;

interface PostBody {
  username?: string;
}

function normaliseUsername(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?paypal\.me\//i, "")
    .replace(/^\//, "")
    .replace(/\/+$/, "");
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const username = normaliseUsername(body.username ?? "");
  if (!username) {
    return NextResponse.json(
      { error: "PayPal.me username is required." },
      { status: 400 },
    );
  }
  if (!USERNAME_RE.test(username)) {
    return NextResponse.json(
      {
        error:
          "PayPal.me usernames are 1-20 characters, letters / digits / hyphens, can't start or end with a hyphen.",
      },
      { status: 400 },
    );
  }

  const cfg: PayPalConfig = {
    username,
    connectedAt: new Date(),
  };
  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      {
        paypalConfig: cfg,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return NextResponse.json({
    ok: true,
    username,
    paypalMeUrl: `https://paypal.me/${username}`,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  await getAdminDb()
    .doc(`subAccounts/${subAccountId}`)
    .set(
      {
        paypalConfig: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return NextResponse.json({ ok: true });
}
