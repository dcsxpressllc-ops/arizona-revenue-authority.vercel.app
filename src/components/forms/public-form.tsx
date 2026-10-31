"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { defaultSmsConsentText, type LeadForm } from "@/types/forms";
import type { ContactAttribution } from "@/types/contacts";
import {
  readAttributionFromBrowser,
  trackLeadEvent,
} from "@/lib/attribution";
import { safeFormRedirectUrl } from "@/lib/forms/redirect";

interface PublicFormProps {
  form: LeadForm;
}

export function PublicForm({ form }: PublicFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of form.fields) initial[f.id] = "";
    return initial;
  });
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<{
    message: string;
    redirectUrl: string | null;
  } | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const attributionRef = useRef<ContactAttribution | null>(null);
  // Spam guard (lib/forms/spam-guard.ts): a hidden honeypot plus time on screen.
  // Both are sent outside `values` so they never touch field data.
  const honeypotRef = useRef<HTMLInputElement>(null);
  const mountedAtRef = useRef<number>(0);

  // Capture attribution on mount, before any navigation or post-submit redirect.
  useEffect(() => {
    attributionRef.current = readAttributionFromBrowser();
    mountedAtRef.current = Date.now();
  }, []);

  function setValue(id: string, v: string) {
    setValues((prev) => ({ ...prev, [id]: v }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setApiError(null);
    const next: Record<string, string> = {};
    for (const f of form.fields) {
      if (f.type === "sms_consent") {
        // Consent is "true" when checked; only blocks submit if the field is required.
        if (f.required && values[f.id] !== "true") {
          next[f.id] = "Please tick this box to continue";
        }
        continue;
      }
      if (f.required && !values[f.id]?.trim()) {
        next[f.id] = `${f.label} is required`;
      } else if (f.type === "email" && values[f.id]) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values[f.id])) {
          next[f.id] = "Enter a valid email";
        }
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/forms/${form.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values,
          attribution: attributionRef.current,
          hp: honeypotRef.current?.value ?? "",
          elapsedMs: mountedAtRef.current
            ? Date.now() - mountedAtRef.current
            : undefined,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        thankYouMessage?: string;
        redirectUrl?: string | null;
      };
      if (!res.ok || !data.ok) {
        setApiError(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      // Before any redirect, or the pixel unloads with the page.
      trackLeadEvent({
        utmCampaign: attributionRef.current?.utmCampaign ?? null,
      });
      // Re-checked client-side too: this page is on the app's origin, so a
      // javascript: URL would run here.
      const redirectTo = safeFormRedirectUrl(
        data.redirectUrl,
        window.location.href,
      );
      if (redirectTo) {
        window.location.href = redirectTo;
        return;
      }
      setSuccess({
        message: data.thankYouMessage ?? "Thanks — we'll be in touch shortly.",
        redirectUrl: null,
      });
    } catch (err) {
      console.error(err);
      setApiError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-white">
          <Check className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium">{success.message}</p>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      {form.fields.map((f) =>
        f.type === "sms_consent" ? (
          <div key={f.id} className="space-y-1.5">
            <label className="flex cursor-pointer items-start gap-2 text-sm leading-snug text-muted-foreground">
              <input
                type="checkbox"
                checked={values[f.id] === "true"}
                onChange={(e) => setValue(f.id, e.target.checked ? "true" : "")}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
                aria-invalid={!!errors[f.id]}
              />
              <span>
                {f.consentText?.trim() || defaultSmsConsentText()}
                {f.required && <span className="text-destructive"> *</span>}
              </span>
            </label>
            {errors[f.id] && (
              <p className="text-xs text-destructive">{errors[f.id]}</p>
            )}
          </div>
        ) : (
        <div key={f.id} className="space-y-1.5">
          <Label htmlFor={f.id}>
            {f.label}
            {f.required && <span className="text-destructive">*</span>}
          </Label>
          {f.type === "textarea" ? (
            <Textarea
              id={f.id}
              value={values[f.id] ?? ""}
              onChange={(e) => setValue(f.id, e.target.value)}
              placeholder={f.placeholder}
              rows={4}
              aria-invalid={!!errors[f.id]}
            />
          ) : f.type === "select" ? (
            <select
              id={f.id}
              value={values[f.id] ?? ""}
              onChange={(e) => setValue(f.id, e.target.value)}
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
            >
              <option value="">— Choose —</option>
              {f.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id={f.id}
              type={
                f.type === "email"
                  ? "email"
                  : f.type === "phone"
                    ? "tel"
                    : "text"
              }
              value={values[f.id] ?? ""}
              onChange={(e) => setValue(f.id, e.target.value)}
              placeholder={f.placeholder}
              aria-invalid={!!errors[f.id]}
            />
          )}
          {errors[f.id] && (
            <p className="text-xs text-destructive">{errors[f.id]}</p>
          )}
        </div>
      ))}

      {/* Honeypot. Off-screen rather than display:none (some bots skip those), with
          tabIndex -1 and aria-hidden so keyboard and screen-reader users never hit it.
          autocomplete=off stops autofill from tripping it. */}
      <input
        ref={honeypotRef}
        type="text"
        name="ls_website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        defaultValue=""
        style={{
          position: "absolute",
          left: "-10000px",
          top: "auto",
          width: "1px",
          height: "1px",
          overflow: "hidden",
          opacity: 0,
        }}
      />

      {apiError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {apiError}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            Submitting…
          </>
        ) : (
          "Submit"
        )}
      </Button>
    </form>
  );
}
