/**
 * Browser-side resize before upload: serverless hosts cap request bodies
 * (Vercel at 4.5 MB), and a 2000px image is plenty for a product page.
 * Images already small enough are sent as they are.
 */

const MAX_EDGE = 2000;
const TARGET_BYTES = 3.5 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

export const PRODUCT_IMAGE_ACCEPT = ACCEPTED.join(",");

export async function shrinkImageForUpload(file: File): Promise<File> {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error("Use a JPG, PNG or WebP image.");
  }
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("That image couldn't be read.");

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= TARGET_BYTES) {
    bitmap.close();
    return file;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Your browser couldn't resize that image.");
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // PNG keeps transparency (logos, cut-outs); photos go to WebP.
  const type = file.type === "image/png" ? "image/png" : "image/webp";
  for (const quality of [0.86, 0.75, 0.6]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, quality),
    );
    if (blob && blob.size <= TARGET_BYTES) {
      const name = file.name.replace(/\.[^.]+$/, "") + (type === "image/png" ? ".png" : ".webp");
      return new File([blob], name, { type });
    }
  }
  throw new Error("That image is too large even after resizing.");
}
