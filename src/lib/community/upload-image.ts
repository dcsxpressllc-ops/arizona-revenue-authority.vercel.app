import {
  getDownloadURL,
  ref,
  uploadBytes,
} from "firebase/storage";
import { getFirebaseStorage } from "@/lib/firebase/client";

/**
 * Uploads a group cover/logo to Storage and returns the public URL. Client
 * side: staff are Firebase-authed and Storage rules allow authenticated write to
 * community/** with public read (members never upload). Path
 * `community/{saId}/{groupId}/{kind}-{timestamp}.{ext}`; the timestamp busts
 * CDN caches on replace.
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function uploadCommunityImage(
  file: File,
  saId: string,
  groupId: string,
  kind: "cover" | "card" | "logo" | "course",
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file (JPG, PNG, WebP, or GIF).");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Image is too large — keep it under 5 MB.");
  }
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "img";
  const path = `community/${saId}/${groupId}/${kind}-${Date.now()}.${ext}`;
  const storageRef = ref(getFirebaseStorage(), path);
  await uploadBytes(storageRef, file, { contentType: file.type });
  return getDownloadURL(storageRef);
}
