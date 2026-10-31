"use client";

import { useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Loader2,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  PRODUCT_IMAGE_ACCEPT,
  shrinkImageForUpload,
} from "@/lib/products/shrink-image-client";
import { MAX_PRODUCT_IMAGES, type ProductImage } from "@/types/products";

/**
 * Product images. "live" mode edits a saved product through the image routes;
 * "staged" mode (a product not created yet) collects files that the dialog
 * uploads right after the create call.
 */

export interface StagedImage {
  key: string;
  file: File;
  previewUrl: string;
}

export async function uploadProductImage(
  subAccountId: string,
  productId: string,
  file: File,
): Promise<ProductImage> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(
    `/api/sub-accounts/${subAccountId}/products/${productId}/images`,
    { method: "POST", body: form },
  );
  const data = (await res.json().catch(() => ({}))) as {
    image?: ProductImage;
    error?: string;
  };
  if (!res.ok || !data.image) throw new Error(data.error ?? "Upload failed.");
  return data.image;
}

type Props =
  | {
      mode: "live";
      subAccountId: string;
      productId: string;
      images: ProductImage[];
      generating?: boolean;
      generationError?: string | null;
      /** Rendered only when supplied (needs the generation backend). */
      onGenerate?: () => void;
    }
  | {
      mode: "staged";
      staged: StagedImage[];
      onStagedChange: (next: StagedImage[]) => void;
    };

export function ProductImagesField(props: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [altDrafts, setAltDrafts] = useState<Record<string, string>>({});

  const count = props.mode === "live" ? props.images.length : props.staged.length;
  const room = MAX_PRODUCT_IMAGES - count;

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    const picked = Array.from(files).slice(0, room);
    if (files.length > room) {
      toast.message(`Only ${MAX_PRODUCT_IMAGES} images per product; extra files skipped.`);
    }
    setBusy(true);
    try {
      const ready: File[] = [];
      for (const f of picked) {
        try {
          ready.push(await shrinkImageForUpload(f));
        } catch (err) {
          toast.error(`${f.name}: ${err instanceof Error ? err.message : "couldn't use it"}`);
        }
      }
      if (props.mode === "staged") {
        props.onStagedChange([
          ...props.staged,
          ...ready.map((file) => ({
            key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
            file,
            previewUrl: URL.createObjectURL(file),
          })),
        ]);
      } else {
        for (const file of ready) {
          try {
            await uploadProductImage(props.subAccountId, props.productId, file);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Upload failed.");
            break;
          }
        }
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function patchImages(next: ProductImage[]) {
    if (props.mode !== "live") return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${props.subAccountId}/products/${props.productId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            images: next.map((img) => ({ id: img.id, alt: img.alt })),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  async function removeLive(img: ProductImage) {
    if (props.mode !== "live") return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${props.subAccountId}/products/${props.productId}/images/${img.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't remove it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove it.");
    } finally {
      setBusy(false);
    }
  }

  function move<T>(list: T[], from: number, to: number): T[] {
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }

  const tiles =
    props.mode === "live"
      ? props.images.map((img, i) => ({
          key: img.id,
          src: img.url,
          alt: img.alt,
          generated: img.source === "generated",
          onLeft: i > 0 ? () => patchImages(move(props.images, i, i - 1)) : null,
          onRight:
            i < props.images.length - 1
              ? () => patchImages(move(props.images, i, i + 1))
              : null,
          onPrimary: i > 0 ? () => patchImages(move(props.images, i, 0)) : null,
          onRemove: () => removeLive(img),
          altEditable: true,
          onAltCommit: (alt: string) => {
            if (alt === img.alt) return;
            patchImages(props.images.map((x) => (x.id === img.id ? { ...x, alt } : x)));
          },
        }))
      : props.staged.map((s, i) => ({
          key: s.key,
          src: s.previewUrl,
          alt: s.file.name,
          generated: false,
          onLeft: i > 0 ? () => props.onStagedChange(move(props.staged, i, i - 1)) : null,
          onRight:
            i < props.staged.length - 1
              ? () => props.onStagedChange(move(props.staged, i, i + 1))
              : null,
          onPrimary: i > 0 ? () => props.onStagedChange(move(props.staged, i, 0)) : null,
          onRemove: () => {
            URL.revokeObjectURL(s.previewUrl);
            props.onStagedChange(props.staged.filter((x) => x.key !== s.key));
          },
          altEditable: false,
          onAltCommit: () => {},
        }));

  const generating = props.mode === "live" && props.generating && count === 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Images</p>
          <p className="text-xs text-muted-foreground">
            Up to {MAX_PRODUCT_IMAGES}. The first is the main image on your
            website and at checkout.
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {props.mode === "live" && props.onGenerate && count === 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || generating}
              onClick={props.onGenerate}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Generate image
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || room <= 0}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImagePlus className="h-3.5 w-3.5" />
            )}
            Add images
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={PRODUCT_IMAGE_ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => onPick(e.target.files)}
        />
      </div>

      {generating && (
        <div className="flex h-24 animate-pulse items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/40 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          Generating an image…
        </div>
      )}
      {props.mode === "live" && props.generationError && !generating && count === 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Couldn&apos;t generate an image: {props.generationError} Try again or
          upload one.
        </p>
      )}

      {tiles.length === 0 && !generating ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex h-24 w-full items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground transition hover:bg-muted/40"
        >
          No image yet. Click to add one.
        </button>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {tiles.map((t, i) => (
            <div key={t.key} className="group space-y-1">
              <div
                className={cn(
                  "relative aspect-square overflow-hidden rounded-lg border bg-muted",
                  i === 0 && "ring-2 ring-primary/60",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.src} alt={t.alt} className="h-full w-full object-cover" />
                {i === 0 && (
                  <span className="absolute left-1 top-1 rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-medium">
                    Main
                  </span>
                )}
                {t.generated && (
                  <span className="absolute right-1 top-1 rounded bg-background/90 px-1.5 py-0.5 text-[10px] font-medium">
                    AI
                  </span>
                )}
                <div className="absolute inset-x-0 bottom-0 flex justify-between bg-background/85 p-0.5 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <div className="flex">
                    <IconBtn label="Move left" disabled={busy || !t.onLeft} onClick={t.onLeft}>
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn label="Move right" disabled={busy || !t.onRight} onClick={t.onRight}>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </IconBtn>
                    <IconBtn label="Make main image" disabled={busy || !t.onPrimary} onClick={t.onPrimary}>
                      <Star className="h-3.5 w-3.5" />
                    </IconBtn>
                  </div>
                  <IconBtn label="Remove image" disabled={busy} onClick={t.onRemove}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </IconBtn>
                </div>
              </div>
              {t.altEditable && (
                <Input
                  aria-label="Image description (alt text)"
                  className="h-7 text-xs"
                  placeholder="Describe the image"
                  value={altDrafts[t.key] ?? t.alt}
                  onChange={(e) =>
                    setAltDrafts((d) => ({ ...d, [t.key]: e.target.value }))
                  }
                  onBlur={(e) => t.onAltCommit(e.target.value.trim())}
                  onKeyDown={(e) => {
                    // Enter saves this field, not the whole product form.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                  maxLength={200}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: (() => void) | null;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || !onClick}
      onClick={() => onClick?.()}
      className="rounded p-1 hover:bg-muted disabled:opacity-30"
    >
      {children}
    </button>
  );
}
