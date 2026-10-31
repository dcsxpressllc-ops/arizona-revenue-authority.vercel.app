"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Package, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { ContactPicker } from "@/components/quotes/contact-picker";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToTerritories } from "@/lib/firestore/territories";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { formatCurrency, toDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDealStageResolver } from "@/hooks/use-pipelines";
import { type Deal } from "@/types/deals";
import type {
  Quote,
  QuoteDiscount,
  QuoteKind,
  QuoteLineItem,
} from "@/types/quotes";
import type { Product } from "@/types/products";
import type { Contact } from "@/types/contacts";
import { GLOBAL_TERRITORY_ID, type TerritoryDoc } from "@/types";

/**
 * Operator form for creating/editing a quote. Hands the full payload to `onSave`;
 * the parent picks the create or update API. The totals preview uses the same
 * `computeQuoteTotals` as the public page and email, so what's shown here matches
 * what the recipient sees. Single global tax % and discount, no per-line.
 */

/** Fields the builder owns; lifecycle, tenancy and ids are handled by the parent/API. */
export interface QuoteFormValues {
  lineItems: QuoteLineItem[];
  currency: string;
  globalDiscount: QuoteDiscount;
  globalTaxPercent: number | null;
  termsAndNotes: string;
  billedToOrganization: string | null;
  billingAddress: string | null;
  /** Quote-only. yyyy-mm-dd or null; parent converts to Timestamp. */
  validUntilDateString: string | null;
  /** Invoice-only. 0 = due on receipt, null = not stated. */
  paymentDueDays: number | null;
  autoCreateDealOnAccept: boolean;
  /** Quote-only. On accept this deal moves to Won instead of a new deal being created. Null = unlinked. */
  dealId: string | null;
}

interface QuoteBuilderProps {
  /** Present = edit mode (pre-filled), undefined = create mode. */
  initial?: Quote;
  /** Picks Valid until vs Payment due. Defaults to "quote". */
  kind?: QuoteKind;
  /** Shown when there's no inline picker (edit mode). */
  contactName: string;
  /** Enables the inline recipient picker. Pass with `selectedContactId` and `onContactChange`. */
  contacts?: Contact[];
  selectedContactId?: string;
  onContactChange?: (contactId: string) => void;
  /** Active catalog products. Empty hides the picker. */
  products?: Product[];
  /** Filtered to the selected contact's open deals for the link picker. Empty hides it (invoices never show it). */
  deals?: Deal[];
  onSave: (values: QuoteFormValues) => Promise<void>;
  onCancel?: () => void;
  saveLabel?: string;
}

const COMMON_CURRENCIES = [
  "USD",
  "AUD",
  "EUR",
  "GBP",
  "CAD",
  "NZD",
  "JPY",
  "CHF",
  "SGD",
  "HKD",
] as const;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function toDateString(value: Quote["validUntil"]): string | null {
  const d = toDate(value);
  if (!d) return null;
  // yyyy-mm-dd, locale-safe (toISOString gives UTC).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function QuoteBuilder({
  initial,
  kind = "quote",
  contactName,
  contacts,
  selectedContactId,
  onContactChange,
  products = [],
  deals = [],
  onSave,
  onCancel,
  saveLabel = "Save quote",
}: QuoteBuilderProps) {
  const isInvoice = kind === "invoice";
  const canEditRecipient = !!contacts && !!onContactChange;
  const { subAccountId, subAccount } = useSubAccount();
  const scopingOn = subAccount?.territoryScopingEnabled === true;
  const [territories, setTerritories] = useState<TerritoryDoc[]>([]);

  // Only to label contacts in the picker and show the "inherited" hint; subscribed only with scoping on.
  useEffect(() => {
    if (!scopingOn || !subAccountId) {
      setTerritories([]);
      return;
    }
    const unsub = subscribeToTerritories(subAccountId, (list) =>
      setTerritories(list),
    );
    return () => unsub();
  }, [scopingOn, subAccountId]);
  const [lineItems, setLineItems] = useState<QuoteLineItem[]>(
    initial?.lineItems ?? [],
  );
  const [currency, setCurrency] = useState<string>(initial?.currency ?? "USD");
  const [discount, setDiscount] = useState<QuoteDiscount>(
    initial?.globalDiscount ?? null,
  );
  const [taxPercent, setTaxPercent] = useState<string>(
    initial?.globalTaxPercent != null
      ? String(initial.globalTaxPercent)
      : "",
  );
  const [terms, setTerms] = useState(initial?.termsAndNotes ?? "");
  const [billedTo, setBilledTo] = useState(
    initial?.billedToOrganization ?? "",
  );
  const [billingAddress, setBillingAddress] = useState(
    initial?.billingAddress ?? "",
  );
  // Once the operator edits billingAddress, contact picks stop auto-filling it.
  // Starts true when the doc already had a value.
  const [addressTouched, setAddressTouched] = useState(
    !!(initial?.billingAddress && initial.billingAddress.trim()),
  );

  // Fill billingAddress from the picked contact until the operator edits it. Re-runs
  // on each contact change so correcting a wrong pick fixes the address too.
  const pickedContact = useMemo(
    () => contacts?.find((c) => c.id === selectedContactId) ?? null,
    [contacts, selectedContactId],
  );
  useEffect(() => {
    if (addressTouched) return;
    const fromContact = pickedContact?.address?.trim() ?? "";
    if (fromContact && fromContact !== billingAddress) {
      setBillingAddress(fromContact);
    }
  }, [pickedContact, addressTouched, billingAddress]);
  const [validUntil, setValidUntil] = useState<string>(
    toDateString(initial?.validUntil ?? null) ?? "",
  );
  // null = not chosen, 0 = due on receipt, >0 = due in N days. New invoices default to 7.
  const [paymentDueDays, setPaymentDueDays] = useState<number | null>(
    initial?.paymentDueDays ?? (isInvoice ? 7 : null),
  );
  const [autoCreateDeal, setAutoCreateDeal] = useState<boolean>(
    initial?.autoCreateDealOnAccept ?? true,
  );
  const [dealId, setDealId] = useState<string | null>(initial?.dealId ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Picker selection in create mode, the saved contact in edit mode.
  const dealContactId = selectedContactId ?? initial?.contactId ?? null;

  // A linked deal belongs to one contact, so a recipient change clears the link.
  // Only on an actual contact change (not while deals are loading) so a saved link
  // is never silently dropped.
  const [prevDealContactId, setPrevDealContactId] = useState(dealContactId);
  if (prevDealContactId !== dealContactId) {
    setPrevDealContactId(dealContactId);
    setDealId(null);
  }

  // Open deals for the selected contact. Terminal is per-pipeline.
  const resolveStage = useDealStageResolver();
  const openDeals = useMemo(
    () =>
      dealContactId
        ? deals.filter(
            (d) => d.contactId === dealContactId && !resolveStage(d).terminal,
          )
        : [],
    [deals, dealContactId, resolveStage],
  );
  // Keep a saved link renderable even if it's not open (already Won, or no deals passed).
  const linkedDealMissingFromList =
    !!dealId && !openDeals.some((d) => d.id === dealId);

  const totals = useMemo(
    () =>
      computeQuoteTotals({
        lineItems,
        globalDiscount: discount,
        globalTaxPercent: taxPercent.trim() === "" ? null : Number(taxPercent),
      }),
    [lineItems, discount, taxPercent],
  );

  const territoryNameById = useMemo(
    () => new Map(territories.map((t) => [t.id, t.name])),
    [territories],
  );
  const labelForTerritory = (id: string | null | undefined) =>
    !id || id === GLOBAL_TERRITORY_ID
      ? "Global"
      : (territoryNameById.get(id) ?? "Global");
  // Territory comes from the recipient (Global fallback), same as the API; display-only.
  const recipientTerritoryId =
    pickedContact?.territoryId ?? initial?.territoryId ?? null;
  const territoryLabel = labelForTerritory(recipientTerritoryId);
  // Territory chip per contact row, only when scoping is on.
  const contactTerritoryLabel = scopingOn
    ? (c: Contact) => labelForTerritory(c.territoryId)
    : undefined;

  const updateItem = (id: string, patch: Partial<QuoteLineItem>) => {
    setLineItems((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };
  const removeItem = (id: string) => {
    setLineItems((items) => items.filter((item) => item.id !== id));
  };
  const addFromCatalog = (productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    const snapshotted: QuoteLineItem = {
      id: newId(),
      description: product.description
        ? `${product.name} — ${product.description}`
        : product.name,
      quantity: 1,
      unitPrice: product.unitPriceCents / 100,
      productId: product.id,
    };
    setLineItems((items) => [...items, snapshotted]);
  };

  const handleSave = async () => {
    setError(null);
    // Light check; the server validates again.
    if (lineItems.length === 0) {
      setError("Add at least one product from the catalog.");
      return;
    }
    const taxNum = taxPercent.trim() === "" ? null : Number(taxPercent);
    if (taxNum !== null && (Number.isNaN(taxNum) || taxNum < 0 || taxNum > 100)) {
      setError("Tax % must be between 0 and 100.");
      return;
    }
    if (canEditRecipient && !selectedContactId) {
      setError("Pick a recipient first.");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        lineItems: lineItems.map((item) => ({
          ...item,
          description: item.description.trim(),
          quantity: Number(item.quantity) || 0,
          unitPrice: Number(item.unitPrice) || 0,
        })),
        currency,
        globalDiscount: discount,
        globalTaxPercent: taxNum,
        termsAndNotes: terms.trim(),
        billedToOrganization: billedTo.trim() || null,
        billingAddress: billingAddress.trim() || null,
        // For invoices, null out validUntil; for quotes, null out paymentDueDays.
        validUntilDateString: isInvoice ? null : validUntil || null,
        paymentDueDays: isInvoice ? paymentDueDays : null,
        autoCreateDealOnAccept: autoCreateDeal,
        dealId: isInvoice ? null : dealId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* With `contacts` and `onContactChange` the recipient is an inline picker; otherwise read-only. */}
      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label
              htmlFor="recipient-picker"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Recipient
            </Label>
            {canEditRecipient ? (
              <div className="mt-1">
                <ContactPicker
                  id="recipient-picker"
                  contacts={contacts!}
                  value={selectedContactId ?? ""}
                  onChange={(id) => onContactChange?.(id)}
                  placeholder="Search by name, email, or phone…"
                  territoryLabel={contactTerritoryLabel}
                />
              </div>
            ) : (
              <p className="mt-1 text-sm font-medium">{contactName}</p>
            )}
            {scopingOn && (pickedContact || initial) && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Territory:{" "}
                <span className="font-medium text-foreground">
                  {territoryLabel}
                </span>{" "}
                · inherited from the contact
              </p>
            )}
          </div>
          <div>
            <Label
              htmlFor="billed-to"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Billed to (organization, optional)
            </Label>
            <Input
              id="billed-to"
              value={billedTo}
              onChange={(e) => setBilledTo(e.target.value)}
              placeholder="e.g. ACME Holdings Pty Ltd"
              className="mt-1"
            />
          </div>
        </div>

        <div className="mt-4">
          <Label
            htmlFor="billing-address"
            className="text-xs uppercase tracking-wider text-muted-foreground"
          >
            Billing address (optional)
          </Label>
          <Textarea
            id="billing-address"
            value={billingAddress}
            onChange={(e) => {
              setBillingAddress(e.target.value);
              setAddressTouched(true);
            }}
            placeholder="Street, City, State, Postal, Country"
            rows={3}
            className="mt-1"
          />
          {pickedContact?.address?.trim() && !addressTouched && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Auto-filled from {pickedContact.name || pickedContact.email}&apos;s
              saved address. Edits here only affect this {kind}.
            </p>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold">Line items</Label>
          <div className="flex items-center gap-2">
            <Label
              htmlFor="currency"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Currency
            </Label>
            <select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground"
            >
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {lineItems.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/20 px-4 py-6 text-center text-xs text-muted-foreground">
              No products added yet. Pick one from the catalog below.
              {products.length === 0 && (
                <>
                  {" "}
                  <br />
                  Your catalog is empty —{" "}
                  <a
                    href="../products"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    add a product first
                  </a>
                  .
                </>
              )}
            </p>
          ) : (
            lineItems.map((item) => (
              <LineItemRow
                key={item.id}
                item={item}
                currency={currency}
                onChange={(patch) => updateItem(item.id, patch)}
                onRemove={() => removeItem(item.id)}
              />
            ))
          )}
        </div>

        {products.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Package className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  addFromCatalog(e.target.value);
                  e.currentTarget.value = "";
                }
              }}
              className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground"
            >
              <option value="">Add product from catalog…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatCurrency(p.unitPriceCents / 100, p.currency)}
                </option>
              ))}
            </select>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Discount
              </Label>
              <div className="mt-1 flex items-center gap-2">
                <select
                  value={discount?.type ?? "none"}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "none") setDiscount(null);
                    else if (val === "percent")
                      setDiscount({ type: "percent", value: discount?.value ?? 0 });
                    else setDiscount({ type: "flat", value: discount?.value ?? 0 });
                  }}
                  className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground"
                >
                  <option value="none">No discount</option>
                  <option value="percent">% off</option>
                  <option value="flat">Flat amount</option>
                </select>
                {discount && (
                  <Input
                    type="number"
                    min={0}
                    max={discount.type === "percent" ? 100 : undefined}
                    step={discount.type === "percent" ? "0.1" : "0.01"}
                    value={discount.value === 0 ? "" : discount.value}
                    onChange={(e) =>
                      setDiscount({
                        type: discount.type,
                        value: Number(e.target.value) || 0,
                      })
                    }
                    placeholder={discount.type === "percent" ? "10" : "100"}
                    className="w-24"
                  />
                )}
              </div>
            </div>

            <div>
              <Label
                htmlFor="tax-percent"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                Tax % (optional)
              </Label>
              <Input
                id="tax-percent"
                type="number"
                min={0}
                max={100}
                step="0.1"
                value={taxPercent}
                onChange={(e) => setTaxPercent(e.target.value)}
                placeholder="10"
                className="mt-1 w-32"
              />
            </div>

            {isInvoice ? (
              <div>
                <Label
                  htmlFor="payment-due"
                  className="text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Payment due
                </Label>
                <select
                  id="payment-due"
                  value={paymentDueDays === null ? "" : String(paymentDueDays)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPaymentDueDays(v === "" ? null : Number(v));
                  }}
                  className="mt-1 h-9 w-48 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground"
                >
                  <option value="0">Due on receipt</option>
                  <option value="7">Net 7 days</option>
                  <option value="14">Net 14 days</option>
                  <option value="30">Net 30 days</option>
                  <option value="60">Net 60 days</option>
                  <option value="">No specific date</option>
                </select>
              </div>
            ) : (
              <div>
                <Label
                  htmlFor="valid-until"
                  className="text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Valid until (optional)
                </Label>
                <Input
                  id="valid-until"
                  type="date"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                  className="mt-1 w-48"
                />
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-muted/30 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Preview totals
            </p>
            <div className="mt-3 space-y-1.5 text-sm">
              <TotalRow
                label="Subtotal"
                value={formatCurrency(totals.subtotal, currency)}
              />
              {totals.discountAmount > 0 && (
                <TotalRow
                  label="Discount"
                  value={`− ${formatCurrency(totals.discountAmount, currency)}`}
                />
              )}
              {totals.taxAmount > 0 && (
                <TotalRow
                  label={`Tax (${taxPercent}%)`}
                  value={formatCurrency(totals.taxAmount, currency)}
                />
              )}
              <Separator className="my-1" />
              <TotalRow
                label="Total"
                value={formatCurrency(totals.total, currency)}
                strong
              />
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <Label
          htmlFor="terms"
          className="text-xs uppercase tracking-wider text-muted-foreground"
        >
          Terms &amp; notes (shown to recipient)
        </Label>
        <Textarea
          id="terms"
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          rows={5}
          placeholder="Payment terms, scope notes, next-steps language…"
          className="mt-1"
        />

        {!isInvoice && (
          <>
            {/* Accepting a linked quote moves that deal to Won (value = quote total) instead of
                creating a duplicate. Only shown when there are open deals or a saved link. */}
            {(openDeals.length > 0 || dealId) && (
              <div className="mt-5">
                <Label
                  htmlFor="linked-deal"
                  className="text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Pipeline deal this quote is for (optional)
                </Label>
                <select
                  id="linked-deal"
                  value={dealId ?? ""}
                  onChange={(e) => setDealId(e.target.value || null)}
                  className="mt-1 h-9 w-full max-w-md rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground"
                >
                  <option value="">
                    None — create a new deal on accept
                  </option>
                  {openDeals.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title} · {resolveStage(d).label} ·{" "}
                      {formatCurrency(d.value, d.currency)}
                    </option>
                  ))}
                  {linkedDealMissingFromList && (
                    <option value={dealId!}>Currently linked deal</option>
                  )}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {dealId
                    ? "On accept, this deal moves to Won and its value is set to the quote total — no duplicate deal is created."
                    : "Link the open deal you're already tracking so accepting the quote wins it, instead of creating a second deal beside it."}
                </p>
              </div>
            )}

            {!dealId && (
              <div className="mt-5 flex items-start gap-3">
                <Checkbox
                  id="auto-create-deal"
                  checked={autoCreateDeal}
                  onCheckedChange={(c) =>
                    setAutoCreateDeal(c === true)
                  }
                />
                <div>
                  <Label htmlFor="auto-create-deal" className="text-sm font-medium">
                    Auto-create a deal at &ldquo;Won&rdquo; when this quote is accepted
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Deal value = quote total. Uncheck if you&apos;re already
                    tracking this opportunity in the pipeline manually.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
        )}
        <Button type="button" onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            saveLabel
          )}
        </Button>
      </div>

      {error && (
        <p className="text-right text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}

function LineItemRow({
  item,
  currency,
  onChange,
  onRemove,
}: {
  item: QuoteLineItem;
  currency: string;
  onChange: (patch: Partial<QuoteLineItem>) => void;
  onRemove: () => void;
}) {
  const lineTotal = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_5rem_8rem_8rem_auto] sm:items-center">
      {/* Snapshotted from the catalog. Archive and replace the product to change it. */}
      <div className="min-w-0 rounded-md border border-input/40 bg-muted/30 px-3 py-2 text-sm">
        <p className="truncate" title={item.description}>
          {item.description || (
            <span className="italic text-muted-foreground">Untitled item</span>
          )}
        </p>
      </div>
      <Input
        type="number"
        min={0}
        step="0.5"
        value={item.quantity === 0 ? "" : item.quantity}
        onChange={(e) => onChange({ quantity: Number(e.target.value) || 0 })}
        placeholder="Qty"
        className="sm:col-span-1"
      />
      {/* Snapshotted from the catalog; discounts go through the quote-level control. */}
      <p className="rounded-md border border-input/40 bg-muted/30 px-3 py-2 text-right text-sm tabular-nums text-muted-foreground sm:col-span-1">
        {formatCurrency(item.unitPrice, currency)}
      </p>
      <p className="text-right text-sm font-medium tabular-nums sm:col-span-1">
        {formatCurrency(lineTotal, currency)}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        aria-label="Remove line item"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function TotalRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between",
        strong && "text-base",
      )}
    >
      <span className={cn(strong ? "font-semibold" : "text-muted-foreground")}>
        {label}
      </span>
      <span
        className={cn(
          "tabular-nums",
          strong ? "font-bold" : "font-medium",
        )}
      >
        {value}
      </span>
    </div>
  );
}
