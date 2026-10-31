"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Archive, Loader2, Package, Pencil, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToProducts } from "@/lib/firestore/products";
import type { Product } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";
import {
  ProductImagesField,
  uploadProductImage,
  type StagedImage,
} from "@/components/products/product-images-field";
import {
  ProductSellOnlinePanel,
  type SellOnlineDraft,
} from "@/components/products/product-sell-online-panel";

/** Product catalog. The quote/invoice builder snapshots these into line items. One-off prices only, no recurring. */

export default function ProductsPage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId, subAccount } = useSubAccount();

  const [products, setProducts] = useState<Product[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  // By id, so the open dialog follows live changes (uploads, generation).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const editing = useMemo(
    () => products.find((p) => p.id === editingId) ?? null,
    [products, editingId],
  );

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    const unsub = subscribeToProducts(
      { agencyId, subAccountId },
      setProducts,
    );
    return () => unsub();
  }, [user, agencyId, subAccountId, authLoading]);

  const visible = useMemo(
    () => products.filter((p) => showArchived || p.active),
    [products, showArchived],
  );
  const archivedCount = useMemo(
    () => products.filter((p) => !p.active).length,
    [products],
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reusable line items for quotes and invoices. Snapshotted into each
            document at the moment of add — editing a product never changes
            historical quotes or invoices.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New product
        </Button>
      </div>

      {archivedCount > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Show archived ({archivedCount})
          </label>
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Description</th>
                <th className="px-4 py-2.5 text-right font-medium">Price</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <ProductRow
                  key={p.id}
                  product={p}
                  subAccountId={subAccountId}
                  onEdit={() => setEditingId(p.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ProductDialog
        open={creating || !!editing}
        product={editing}
        subAccountId={subAccountId}
        subAccount={subAccount}
        onClose={() => {
          setCreating(false);
          setEditingId(null);
        }}
      />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-2xl border bg-card p-12 text-center">
      <Package className="mx-auto h-10 w-10 text-muted-foreground" />
      <h2 className="mt-4 text-base font-semibold">No products yet</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Add your first product to start building quotes and invoices.
      </p>
      <Button onClick={onCreate} className="mt-4">
        <Plus className="h-4 w-4" />
        New product
      </Button>
    </div>
  );
}

function ProductRow({
  product,
  subAccountId,
  onEdit,
}: {
  product: Product;
  subAccountId: string;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggleArchive() {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/products/${product.id}`,
        product.active
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ active: true }),
            },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed.");
      toast.success(product.active ? "Product archived." : "Product restored.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  const thumb = product.images?.[0];
  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-3 font-medium">
        <div className="flex items-center gap-2.5">
          {thumb && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumb.url}
              alt=""
              className="h-8 w-8 shrink-0 rounded-md border object-cover"
            />
          )}
          <span className="min-w-0 truncate">{product.name}</span>
          {product.sellOnline && product.active && (
            <span className="inline-flex shrink-0 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-400">
              Online
            </span>
          )}
        </div>
      </td>
      <td className="max-w-md truncate px-4 py-3 text-muted-foreground">
        {product.description || (
          <span className="italic text-muted-foreground/60">No description</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
        {formatPrice(product.unitPriceCents, product.currency)}
      </td>
      <td className="px-4 py-3">
        {product.active ? (
          <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Active
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Archived
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={toggleArchive}
            title={product.active ? "Archive" : "Restore"}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : product.active ? (
              <Archive className="h-3.5 w-3.5" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </td>
    </tr>
  );
}

/** Matches the server, which lets a new try replace a job pending this long. */
const IMAGE_JOB_STALE_MS = 15 * 60_000;

function imageGenerationState(product: Product): "pending" | "stale" | "none" {
  const gen = product.imageGeneration;
  if (gen?.status !== "pending") return "none";
  return Date.now() - (gen.requestedAt ?? 0) > IMAGE_JOB_STALE_MS ? "stale" : "pending";
}

async function startImageGeneration(
  subAccountId: string,
  productId: string,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<void> {
  try {
    const res = await fetch(
      `/api/sub-accounts/${subAccountId}/products/${productId}/images/generate`,
      { method: "POST" },
    );
    if (!res.ok && !quiet) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(data.error ?? "Couldn't start the image.");
    }
  } catch {
    if (!quiet) toast.error("Couldn't start the image.");
  }
}

const EMPTY_SELL: SellOnlineDraft = {
  sellOnline: false,
  slug: "",
  publicDescription: "",
  delivery: { type: "none" },
  checkoutPageId: null,
};

function sellDraftFrom(product: Product | null): SellOnlineDraft {
  if (!product) return EMPTY_SELL;
  return {
    sellOnline: product.sellOnline === true,
    slug: product.slug ?? "",
    publicDescription: product.publicDescription ?? "",
    delivery: product.delivery ?? { type: "none" },
    checkoutPageId: product.checkoutPageId ?? null,
  };
}

function ProductDialog({
  open,
  product,
  subAccountId,
  subAccount,
  onClose,
}: {
  open: boolean;
  product: Product | null;
  subAccountId: string;
  subAccount: SubAccountDoc | null;
  onClose: () => void;
}) {
  const editing = !!product;
  const productId = product?.id ?? null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceDollars, setPriceDollars] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [bumpEligible, setBumpEligible] = useState(false);
  const [bumpHeadline, setBumpHeadline] = useState("");
  const [sell, setSell] = useState<SellOnlineDraft>(EMPTY_SELL);
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const [saving, setSaving] = useState(false);
  const sellGateOn = subAccount?.sellOnlineEnabledByAgency === true;

  // Reset on open or when switching product, not on every live snapshot of
  // the same product (that would wipe what the operator is typing).
  useEffect(() => {
    if (!open) return;
    if (product) {
      setName(product.name);
      setDescription(product.description);
      setPriceDollars((product.unitPriceCents / 100).toFixed(2));
      setCurrency(product.currency);
      // Older products lack the field; treat as off.
      setBumpEligible(product.bumpEligible === true);
      setBumpHeadline(product.bumpHeadline ?? "");
    } else {
      setName("");
      setDescription("");
      setPriceDollars("");
      setCurrency("USD");
      setBumpEligible(false);
      setBumpHeadline("");
    }
    setSell(sellDraftFrom(product));
    setStaged((prev) => {
      for (const s of prev) URL.revokeObjectURL(s.previewUrl);
      return [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, productId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Name is required.");
      return;
    }
    const priceNum = Number(priceDollars);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast.error("Price must be a non-negative number.");
      return;
    }
    const unitPriceCents = Math.round(priceNum * 100);

    if (sellGateOn && sell.sellOnline) {
      if (sell.delivery.type === "community" && !sell.delivery.communityGroupId) {
        toast.error("Pick the community group the buyer joins.");
        return;
      }
      if (sell.delivery.type === "download" && !sell.delivery.url.trim()) {
        toast.error("Add the download link.");
        return;
      }
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: trimmedName,
        description: description.trim(),
        unitPriceCents,
        currency: currency.trim().toUpperCase(),
        bumpEligible,
        bumpHeadline: bumpEligible ? bumpHeadline.trim() : "",
      };
      // Only sent while the gate is on, so the request is unchanged otherwise.
      if (sellGateOn) {
        payload.sellOnline = sell.sellOnline;
        payload.publicDescription = sell.publicDescription.trim();
        payload.delivery =
          sell.delivery.type === "download"
            ? {
                ...sell.delivery,
                url: sell.delivery.url.trim(),
                label: sell.delivery.label?.trim() || undefined,
              }
            : sell.delivery;
        if (sell.slug.trim()) payload.slug = sell.slug.trim();
        if (editing) payload.checkoutPageId = sell.checkoutPageId;
      }
      const res = await fetch(
        editing
          ? `/api/sub-accounts/${subAccountId}/products/${product!.id}`
          : `/api/sub-accounts/${subAccountId}/products`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        id?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to save.");
      }
      // Put on sale without a picture: ask for an AI one (the server decides
      // whether it can, and stays quiet if not).
      if (!editing && data.id && staged.length === 0 && sellGateOn && sell.sellOnline) {
        void startImageGeneration(subAccountId, data.id, { quiet: true });
      }
      if (!editing && data.id && staged.length > 0) {
        let failed = 0;
        for (const s of staged) {
          try {
            await uploadProductImage(subAccountId, data.id, s.file);
          } catch {
            failed++;
          }
          URL.revokeObjectURL(s.previewUrl);
        }
        if (failed) {
          toast.error(
            `Product created, but ${failed} image${failed === 1 ? "" : "s"} didn't upload. Open it to try again.`,
          );
        }
      }
      toast.success(editing ? "Product updated." : "Product created.");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit product" : "New product"}</DialogTitle>
          <DialogDescription>
            {sellGateOn
              ? "A product or service for quotes, invoices and your website."
              : "Reusable line item for quotes and invoices."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="product-name">Name</Label>
            <Input
              id="product-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Website audit"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-description">Description</Label>
            <Textarea
              id="product-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional. Shown to the recipient on the invoice."
              rows={3}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="product-price">Unit price</Label>
              <Input
                id="product-price"
                type="number"
                step="0.01"
                min="0"
                value={priceDollars}
                onChange={(e) => setPriceDollars(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-currency">Currency</Label>
              <Input
                id="product-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="USD"
              />
            </div>
          </div>

          {product ? (
            <ProductImagesField
              mode="live"
              subAccountId={subAccountId}
              productId={product.id}
              images={product.images ?? []}
              generating={imageGenerationState(product) === "pending"}
              generationError={
                imageGenerationState(product) === "stale"
                  ? "It took too long."
                  : product.imageGeneration?.status === "failed"
                    ? (product.imageGeneration.error ?? null)
                    : null
              }
              onGenerate={
                sellGateOn
                  ? () => startImageGeneration(subAccountId, product.id)
                  : undefined
              }
            />
          ) : (
            <ProductImagesField
              mode="staged"
              staged={staged}
              onStagedChange={setStaged}
            />
          )}

          {/* Order bumps. A non-bump-eligible product behaves as before in quotes and invoices. */}
          <div className="rounded-lg border bg-muted/30 p-3">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={bumpEligible}
                onChange={(e) => setBumpEligible(e.target.checked)}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  Offer as an order bump
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Lets you attach this as a one-click add-on on a checkout
                  page. Doesn&apos;t change how it works in quotes or invoices.
                </span>
              </span>
            </label>
            {bumpEligible && (
              <div className="mt-3 space-y-1.5">
                <Label htmlFor="product-bump-headline">Bump pitch</Label>
                <Input
                  id="product-bump-headline"
                  value={bumpHeadline}
                  onChange={(e) => setBumpHeadline(e.target.value)}
                  maxLength={140}
                  placeholder="e.g. Add priority onboarding — skip the queue"
                />
                <p className="text-[11px] text-muted-foreground">
                  One line, shown next to the checkbox at checkout. Leave blank
                  to use the description above.
                </p>
              </div>
            )}
          </div>

          <ProductSellOnlinePanel
            subAccountId={subAccountId}
            subAccount={subAccount}
            productId={productId}
            productName={name}
            draft={sell}
            onChange={setSell}
          />

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : editing ? (
                "Save"
              ) : (
                "Create"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
