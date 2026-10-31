import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback, qstashIsConfigured } from "@/lib/automations/qstash";
import {
  GitpageError,
  getProductImageJob,
  gitpageIsConfigured,
  requestProductImage,
} from "@/lib/gitpage/client";
import { productKind, sellOnlineGateOn } from "@/lib/products/sell-online";
import {
  MAX_PRODUCT_IMAGE_BYTES,
  ProductImageStorageError,
  deleteProductImageFile,
  productImageBucketName,
  saveProductImage,
} from "@/lib/server/product-images-storage";
import { queueProductsChanged } from "@/lib/server/products-sync-service";
import type { Product, ProductImage } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * AI product images: gitpage writes the prompt and runs it on the agency's
 * Higgsfield keys; we poll it through QStash and copy the finished image into
 * our own Storage (its URL is temporary). Only for products with no images:
 * an upload that lands while a job runs always wins.
 */

export class ProductImageGenError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const POLL_PATH = "/api/products/images/poll";
const POLL_DELAY_S = 15;
/** ~10 minutes of polling, well past gitpage's usual minute. */
const MAX_POLLS = 40;
/** A pending job older than this is treated as lost and may be replaced. */
const STALE_MS = 15 * 60_000;
const PER_PRODUCT_PER_DAY = 3;
const PER_WORKSPACE_PER_DAY = 20;
const MAX_DOWNLOAD_BYTES = MAX_PRODUCT_IMAGE_BYTES;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Starts a job unless one is running or the product already has images.
 * `auto` calls (turning Sell online on) return quietly instead of throwing.
 */
export async function requestProductImageGeneration(input: {
  subAccountId: string;
  productId: string;
  auto?: boolean;
}): Promise<{ started: boolean; reason?: string }> {
  const { subAccountId, productId, auto = false } = input;
  const db = getAdminDb();
  const skip = (reason: string, status = 400) => {
    if (auto) return { started: false, reason };
    throw new ProductImageGenError(reason, status);
  };

  const sub = ((await db.doc(`subAccounts/${subAccountId}`).get()).data() ??
    {}) as Partial<SubAccountDoc>;
  if (!sellOnlineGateOn(sub)) return skip("Selling online is off for this workspace.", 403);
  if (!gitpageIsConfigured()) return skip("Image generation isn't set up on this deployment (GITPAGE_API_KEY).", 503);
  if (!qstashIsConfigured()) return skip("Image generation needs QStash on this deployment.", 503);
  if (!productImageBucketName()) return skip("Image generation needs Firebase Storage enabled.", 503);

  const ref = db.doc(`products/${productId}`);
  const counterRef = db.doc(`subAccounts/${subAccountId}/counters/productImages`);

  // Claim the slot first so double clicks and the auto trigger can't both start.
  let claimed: Partial<Product> | null = null;
  const placeholder = `claim_${Date.now()}`;
  const outcome = await db.runTransaction(async (tx) => {
    const [snap, counterSnap] = await Promise.all([tx.get(ref), tx.get(counterRef)]);
    const p = snap.data() as Partial<Product> | undefined;
    if (!snap.exists || p?.subAccountId !== subAccountId) return "Product not found.";
    if ((p.images?.length ?? 0) > 0) return "This product already has an image.";
    const gen = p.imageGeneration;
    if (gen?.status === "pending" && Date.now() - (gen.requestedAt ?? 0) < STALE_MS) {
      return "An image is already being generated.";
    }
    const day = today();
    const perProduct = p.imageGenerationDay?.day === day ? p.imageGenerationDay.n : 0;
    if (perProduct >= PER_PRODUCT_PER_DAY) return "This product has had its 3 tries today. Upload an image instead, or try tomorrow.";
    const c = counterSnap.data() as { day?: string; n?: number } | undefined;
    const perWorkspace = c?.day === day ? (c.n ?? 0) : 0;
    if (perWorkspace >= PER_WORKSPACE_PER_DAY) return "This workspace has used today's 20 image generations.";
    tx.set(counterRef, { day, n: perWorkspace + 1 }, { merge: true });
    tx.update(ref, {
      imageGeneration: { jobId: placeholder, status: "pending", error: null, requestedAt: Date.now() },
      imageGenerationDay: { day, n: perProduct + 1 },
    });
    claimed = p;
    return null;
  });
  if (outcome) return skip(outcome, outcome === "Product not found." ? 404 : 409);
  const product = claimed as unknown as Partial<Product>;

  let jobId: string;
  try {
    ({ jobId } = await requestProductImage({
      subAccountId,
      productId,
      name: product.name ?? "Product",
      description: (product.publicDescription || product.description || "").slice(0, 2_000),
      kind: productKind(product.delivery),
    }));
  } catch (err) {
    const message =
      err instanceof GitpageError ? err.message : "Couldn't reach the image service.";
    const refused = err instanceof GitpageError && (err.status === 403 || err.status === 409);
    await db.runTransaction(async (tx) => {
      const [snap, counterSnap] = await Promise.all([tx.get(ref), tx.get(counterRef)]);
      const p = snap.data() as Partial<Product> | undefined;
      const c = counterSnap.data() as { day?: string; n?: number } | undefined;
      if (c?.day === today() && (c.n ?? 0) > 0) tx.update(counterRef, { n: (c.n ?? 1) - 1 });
      if (p?.imageGeneration?.jobId !== placeholder) return;
      const day = p.imageGenerationDay;
      tx.update(ref, {
        ...(day?.day === today() && day.n > 0 ? { imageGenerationDay: { day: day.day, n: day.n - 1 } } : {}),
        imageGeneration:
          auto || refused
            ? null
            : { jobId: placeholder, status: "failed", error: message.slice(0, 300), requestedAt: Date.now() },
      });
    });
    return skip(message, refused ? (err as GitpageError).status : 502);
  }

  await ref.update({
    imageGeneration: { jobId, status: "pending", error: null, requestedAt: Date.now() },
    updatedAt: FieldValue.serverTimestamp(),
  });
  const scheduled = await publishCallback({
    pathname: POLL_PATH,
    body: { subAccountId, productId, jobId, attempt: 1 },
    delaySeconds: POLL_DELAY_S,
    deduplicationId: `pimg_${jobId}_1`,
  });
  if (!scheduled) {
    await failJob(subAccountId, productId, jobId, "Couldn't schedule the image check.");
    return skip("Couldn't schedule the image check.", 503);
  }
  return { started: true };
}

async function failJob(subAccountId: string, productId: string, jobId: string, error: string) {
  const ref = getAdminDb().doc(`products/${productId}`);
  await getAdminDb().runTransaction(async (tx) => {
    const p = (await tx.get(ref)).data() as Partial<Product> | undefined;
    if (p?.subAccountId !== subAccountId || p.imageGeneration?.jobId !== jobId) return;
    tx.update(ref, {
      imageGeneration: { jobId, status: "failed", error: error.slice(0, 300), requestedAt: p.imageGeneration.requestedAt },
    });
  });
}

async function downloadImage(url: string): Promise<Buffer> {
  if (!/^https:\/\//.test(url)) throw new Error("The image service returned an unusable link.");
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Couldn't fetch the generated image (${res.status}).`);
  const tooBig = "The generated image was too large to keep.";
  if (Number(res.headers.get("content-length") || 0) > MAX_DOWNLOAD_BYTES) throw new Error(tooBig);
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(tooBig);
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(tooBig);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * One QStash tick: ask gitpage, then reschedule, save or fail. Idempotent on
 * the product's current jobId, so stale or repeated ticks do nothing.
 */
export async function pollProductImage(input: {
  subAccountId: string;
  productId: string;
  jobId: string;
  attempt: number;
}): Promise<string> {
  const { subAccountId, productId, jobId, attempt } = input;
  const db = getAdminDb();
  const ref = db.doc(`products/${productId}`);
  const p = (await ref.get()).data() as Partial<Product> | undefined;
  if (p?.subAccountId !== subAccountId || p.imageGeneration?.jobId !== jobId || p.imageGeneration.status !== "pending") {
    return "stale";
  }

  let job;
  try {
    job = await getProductImageJob(jobId);
  } catch (err) {
    if (err instanceof GitpageError && err.status >= 400 && err.status < 500) {
      await failJob(subAccountId, productId, jobId, err.message);
      return "failed";
    }
    job = null; // Network or 5xx: try again on the next tick.
  }

  if (!job || job.status === "pending") {
    if (attempt >= MAX_POLLS) {
      await failJob(subAccountId, productId, jobId, "The image took too long.");
      return "timeout";
    }
    const next = await publishCallback({
      pathname: POLL_PATH,
      body: { subAccountId, productId, jobId, attempt: attempt + 1 },
      delaySeconds: POLL_DELAY_S,
      deduplicationId: `pimg_${jobId}_${attempt + 1}`,
    });
    if (!next) {
      await failJob(subAccountId, productId, jobId, "Couldn't schedule the next image check. Try again.");
      return "failed";
    }
    return "pending";
  }
  if (job.status === "failed" || !job.imageUrl) {
    await failJob(subAccountId, productId, jobId, job.error || "The image could not be generated.");
    return "failed";
  }

  let saved;
  try {
    saved = await saveProductImage({ subAccountId, productId, buffer: await downloadImage(job.imageUrl) });
  } catch (err) {
    const msg = err instanceof ProductImageStorageError || err instanceof Error ? err.message : "save failed";
    await failJob(subAccountId, productId, jobId, msg);
    return "failed";
  }

  const image: ProductImage = {
    id: saved.id,
    url: saved.url,
    path: saved.path,
    source: "generated",
    alt: p.name || "",
    width: saved.width,
    height: saved.height,
    createdAt: Date.now(),
  };
  const kept = await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data() as Partial<Product> | undefined;
    if (fresh?.subAccountId !== subAccountId || fresh.imageGeneration?.jobId !== jobId) return false;
    // An upload that landed meanwhile wins; the job just ends.
    if ((fresh.images?.length ?? 0) > 0) {
      tx.update(ref, { imageGeneration: null });
      return false;
    }
    tx.update(ref, {
      images: [image],
      imageGeneration: null,
      ...(fresh.sellOnline === true ? { publicVersion: (fresh.publicVersion ?? 0) + 1 } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!kept) await deleteProductImageFile(subAccountId, productId, saved.path);
  else if (p.sellOnline === true) {
    await queueProductsChanged({ subAccountId, productId, reason: "updated" }).catch(() => {});
  }
  return kept ? "done" : "superseded";
}
