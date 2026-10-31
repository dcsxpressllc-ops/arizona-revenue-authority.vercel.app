import "server-only";

import { randomUUID } from "crypto";
import { getStorage } from "firebase-admin/storage";

/**
 * Product images live in our own bucket under products/{saId}/{productId}/.
 * Written with the Admin SDK only (no client Storage rule), with a download
 * token so the URL is public without a read rule, like member avatars.
 */

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;

export class ProductImageStorageError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function productImageBucketName(): string | null {
  return process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim() || null;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The real type from the file's first bytes; the browser's claim isn't trusted. */
export function sniffImageType(buf: Buffer): keyof typeof EXT | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Pixel size from the header, so pages can reserve space (no layout shift). */
export function imageDimensions(
  buf: Buffer,
  type: string,
): { width: number; height: number } | null {
  try {
    if (type === "image/png" && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (type === "image/webp" && buf.length >= 30) {
      const chunk = buf.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X") {
        return {
          width: 1 + buf.readUIntLE(24, 3),
          height: 1 + buf.readUIntLE(27, 3),
        };
      }
      if (chunk === "VP8 ") {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    // A truncated header just means no dimensions.
  }
  return null;
}

export interface SavedProductImage {
  id: string;
  url: string;
  path: string;
  width: number | null;
  height: number | null;
}

export async function saveProductImage(opts: {
  subAccountId: string;
  productId: string;
  buffer: Buffer;
}): Promise<SavedProductImage> {
  const bucketName = productImageBucketName();
  if (!bucketName) {
    throw new ProductImageStorageError(
      "Image uploads need Firebase Storage. Set NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET and enable Storage in the Firebase console.",
      503,
    );
  }
  if (opts.buffer.length > MAX_PRODUCT_IMAGE_BYTES) {
    throw new ProductImageStorageError("Image is too large, keep it under 5 MB.", 400);
  }
  const type = sniffImageType(opts.buffer);
  if (!type) {
    throw new ProductImageStorageError("Use a JPG, PNG or WebP image.", 400);
  }
  const id = randomUUID();
  const path = `products/${opts.subAccountId}/${opts.productId}/${id}.${EXT[type]}`;
  const token = randomUUID();
  await getStorage()
    .bucket(bucketName)
    .file(path)
    .save(opts.buffer, {
      resumable: false,
      metadata: {
        contentType: type,
        cacheControl: "public, max-age=31536000, immutable",
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
  const dims = imageDimensions(opts.buffer, type);
  return {
    id,
    url: `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`,
    path,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  };
}

/**
 * Best effort: a leftover file costs pennies, a thrown error would block the
 * delete. Only ever touches this product's own folder, so a path copied from
 * another workspace can't remove that workspace's file.
 */
export async function deleteProductImageFile(
  subAccountId: string,
  productId: string,
  path: string,
): Promise<void> {
  const bucketName = productImageBucketName();
  if (!bucketName || !path.startsWith(`products/${subAccountId}/${productId}/`)) return;
  if (path.includes("..")) return;
  try {
    await getStorage().bucket(bucketName).file(path).delete({ ignoreNotFound: true });
  } catch (err) {
    console.warn(`[product-images] delete failed path=${path}`, err);
  }
}

export async function deleteProductImageFolder(
  subAccountId: string,
  productId: string,
): Promise<void> {
  const bucketName = productImageBucketName();
  if (!bucketName) return;
  try {
    await getStorage()
      .bucket(bucketName)
      .deleteFiles({ prefix: `products/${subAccountId}/${productId}/` });
  } catch (err) {
    console.warn(`[product-images] folder delete failed product=${productId}`, err);
  }
}
