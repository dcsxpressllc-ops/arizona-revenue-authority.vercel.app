import { notFound } from "next/navigation";
import { getAdminDb } from "@/lib/firebase/admin";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";
import type { LeadForm } from "@/types/forms";
import { PublicForm } from "@/components/forms/public-form";
import { appearanceStyle, resolveAppearance } from "@/lib/forms/appearance";

export const dynamic = "force-dynamic";

export default async function PublicFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ formId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { formId } = await params;
  const sp = await searchParams;

  const db = getAdminDb();
  const snap = await db.collection("forms").doc(formId).get();
  if (!snap.exists) notFound();
  const data = snap.data() as Omit<LeadForm, "id">;
  const form: LeadForm = { id: snap.id, ...data };

  const appearance = resolveAppearance(sp, form.settings);

  // Shown to clients' customers, so the template name must never appear.
  // resolveCustomBrand falls back to CUSTOM_BRAND on read errors.
  const brand = await resolveCustomBrand();

  if (!form.enabled) {
    return (
      <FormFrame appearance={appearance}>
        <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center">
          <h1 className="text-xl font-semibold">This form is paused</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Please check back later.
          </p>
        </div>
      </FormFrame>
    );
  }

  const safe: LeadForm = {
    ...form,
    createdAt: null,
    updatedAt: null,
  };

  return (
    <FormFrame appearance={appearance}>
      <div className="w-full max-w-lg">
        {!appearance.hideChrome && (
          <div className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
            {brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- operator-supplied URL, dimensions unknown
              <img
                src={brand.logoUrl}
                alt=""
                className="h-4 w-4 rounded-sm object-contain"
              />
            ) : (
              <span className="inline-block h-4 w-4 rounded-sm bg-gradient-to-br from-indigo-500 via-violet-500 to-pink-500" />
            )}
            <span className="font-medium text-foreground">{brand.name}</span>
          </div>
        )}
        <div className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
          {!appearance.hideTitle && (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">
                {form.name}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Fill this out and we&apos;ll be in touch shortly.
              </p>
            </>
          )}
          <div className={appearance.hideTitle ? "" : "mt-6"}>
            <PublicForm form={safe} />
          </div>
        </div>
        {!appearance.hideChrome && (
          <p className="mt-4 text-center text-[11px] text-muted-foreground">
            Powered by {brand.name}
          </p>
        )}
      </div>
    </FormFrame>
  );
}

const SYSTEM_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Forces html/body background with an inline <style>: next-themes puts .dark
 * on <html> from the system preference, and wrapper CSS vars don't reach body.
 */
function FormFrame({
  appearance,
  children,
}: {
  appearance: ReturnType<typeof resolveAppearance>;
  children: React.ReactNode;
}) {
  const style = {
    ...appearanceStyle(appearance),
    ...(appearance.embed ? { "--font-sans": SYSTEM_FONT_STACK } : {}),
  };

  // Embed is transparent so the host page shows through; otherwise an opaque
  // theme colour so the visitor's system theme can't leak through.
  const bodyBg = appearance.embed
    ? "transparent"
    : appearance.theme === "dark"
      ? "oklch(0.145 0 0)"
      : "oklch(1 0 0)";

  const wrapperClass = appearance.embed
    ? "flex min-h-screen items-center justify-center bg-transparent p-4 font-sans text-foreground sm:p-6"
    : appearance.theme === "dark"
      ? "flex min-h-screen items-center justify-center bg-[oklch(0.145_0_0)] p-4 text-foreground sm:p-6"
      : "flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-500/5 via-violet-500/5 to-pink-500/5 p-4 text-foreground sm:p-6";

  return (
    <>
      <style>{`html, body { background: ${bodyBg} !important; background-color: ${bodyBg} !important; }`}</style>
      <div style={style} className={wrapperClass}>
        {children}
      </div>
    </>
  );
}
