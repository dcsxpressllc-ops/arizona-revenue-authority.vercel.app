import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import type { Funnel } from "@/types/funnels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
};

/**
 * Funnel thank-you step, reached from Stripe via the ?fn= hop. Doesn't read
 * order status: Stripe redirects before the webhook lands, so it'd show
 * "pending" for paid orders. The optional redirect runs client-side after a
 * delay so the buyer sees the confirmation first.
 */
export default async function FunnelThanksPage({
  params,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
}) {
  const { subAccountId, slug } = await params;

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists || subSnap.data()?.labsEnabledByAgency !== true) {
    notFound();
  }

  const snap = await db
    .collection(`subAccounts/${subAccountId}/funnels`)
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) notFound();

  const funnel = snap.docs[0].data() as Funnel;
  // Published-only, same as the landing page.
  if (funnel.status !== "published") notFound();

  const t = funnel.thanks;
  const accent = funnel.appearance?.accent || "#7c3aed";
  const dark = funnel.appearance?.theme === "dark";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: dark ? "#18181b" : "#fafafa",
        color: dark ? "#fafafa" : "#18181b",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 460, textAlign: "center" }}>
        <div
          style={{
            width: 52,
            height: 52,
            margin: "0 auto 18px",
            borderRadius: "50%",
            background: `${accent}1a`,
            color: accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
          }}
          aria-hidden
        >
          ✓
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
          {t.headline || "Thank you"}
        </h1>
        {t.body && (
          <p
            style={{
              margin: "12px 0 0",
              fontSize: 15,
              lineHeight: 1.65,
              color: dark ? "#a1a1aa" : "#52525b",
              whiteSpace: "pre-wrap",
            }}
          >
            {t.body}
          </p>
        )}
        {t.redirectUrl && (
          <>
            <p
              style={{
                margin: "20px 0 0",
                fontSize: 13,
                color: dark ? "#71717a" : "#71717a",
              }}
            >
              Taking you onward…{" "}
              <a
                href={t.redirectUrl}
                style={{ color: accent, textDecoration: "underline" }}
              >
                go now
              </a>
            </p>
            {/* https-only, validated at save time (lib/funnels/sanitize.ts). */}
            <meta httpEquiv="refresh" content={`5;url=${t.redirectUrl}`} />
          </>
        )}
      </div>
    </main>
  );
}
