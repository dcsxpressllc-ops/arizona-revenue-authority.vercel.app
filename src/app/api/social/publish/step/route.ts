import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { publishToFacebookPage, publishToInstagram } from "@/lib/comms/meta";
import { metaCanPublish } from "@/lib/comms/meta-capabilities";
import type {
  MetaConfig,
  SocialPostDoc,
  SocialPostTargetResult,
  SubAccountDoc,
} from "@/types";

export const dynamic = "force-dynamic";
// Instagram publishing polls the media container while Meta processes it
// (up to ~4 min for slow images), longer than the default budget. 300s is
// within Vercel's Fluid limit on every plan.
export const maxDuration = 300;

interface CallbackBody {
  postId?: string;
  subAccountId?: string;
}

/**
 * QStash callback that publishes a scheduled Social Planner post. Public
 * path; auth is Upstash-Signature.
 *
 * A transaction flips the post `scheduled -> publishing` before any platform
 * call, so a retry or duplicate delivery that finds any other state (or no
 * post) no-ops with 200. Failed publishes are marked `failed` and also 200:
 * a blind retry won't fix a revoked token or a bad image.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured on this deployment." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Upstash-Signature header" },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: CallbackBody;
  try {
    payload = JSON.parse(rawBody) as CallbackBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof payload.postId !== "string") {
    return NextResponse.json(
      { error: "Body must include postId (string)" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const ref = db.doc(`socialPosts/${payload.postId}`);

  // Claim the post (scheduled -> publishing).
  let post: Omit<SocialPostDoc, "id"> | null = null;
  try {
    post = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null; // deleted
      const data = snap.data() as Omit<SocialPostDoc, "id">;
      if (data.status !== "scheduled") return null; // already handled
      tx.update(ref, {
        status: "publishing",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return data;
    });
  } catch (err) {
    console.error("[social/publish] claim transaction failed", err);
    // Nothing published yet, so let QStash retry the claim.
    return NextResponse.json({ error: "claim failed" }, { status: 500 });
  }

  if (!post) {
    // Deleted or already processed; 200 so QStash stops.
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Meta connection
  const subSnap = await db.doc(`subAccounts/${post.subAccountId}`).get();
  const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  const meta = (sub?.metaConfig as MetaConfig | null | undefined) ?? null;

  const results: SocialPostTargetResult[] = [];
  for (const platform of post.targets) {
    if (!metaCanPublish(meta) || !meta?.pageId) {
      results.push({
        platform,
        status: "failed",
        externalId: null,
        error:
          "Posting permission missing — reconnect with posting access in Settings → Facebook & Instagram.",
      });
      continue;
    }
    try {
      if (platform === "facebook") {
        const { id } = await publishToFacebookPage({
          pageId: meta.pageId,
          pageAccessToken: meta.pageAccessToken,
          message: post.caption,
          imageUrl: post.imageUrl,
        });
        results.push({ platform, status: "published", externalId: id, error: null });
      } else {
        if (!meta.instagramBusinessAccountId || !post.imageUrl) {
          results.push({
            platform,
            status: "failed",
            externalId: null,
            error: "Instagram needs a linked IG account and an image URL.",
          });
          continue;
        }
        const { id } = await publishToInstagram({
          igUserId: meta.instagramBusinessAccountId,
          pageAccessToken: meta.pageAccessToken,
          caption: post.caption,
          imageUrl: post.imageUrl,
        });
        results.push({ platform, status: "published", externalId: id, error: null });
      }
    } catch (err) {
      results.push({
        platform,
        status: "failed",
        externalId: null,
        error: err instanceof Error ? err.message : "Publish failed.",
      });
    }
  }

  const anyFailed = results.some((r) => r.status === "failed");
  await ref.update({
    status: anyFailed ? "failed" : "published",
    results,
    publishedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, status: anyFailed ? "failed" : "published" });
}
