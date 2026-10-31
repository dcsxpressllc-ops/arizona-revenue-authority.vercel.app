import type { Metadata } from "next";

import { getAdminDb } from "@/lib/firebase/admin";
import type { CheckoutPage } from "@/types/checkout-pages";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
};

/**
 * Default post-payment page when the checkout has no custom successUrl.
 * Doesn't read order status on purpose: Stripe redirects here before the
 * webhook lands, so a status read would often show "pending" for a paid order.
 */
export default async function CheckoutThanksPage({
  params,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
}) {
  const { subAccountId, slug } = await params;

  // Best-effort theming to match the page the buyer came from. Cosmetic only.
  let accent = "#7c3aed";
  let dark = false;
  try {
    const snap = await getAdminDb()
      .collection(`subAccounts/${subAccountId}/checkoutPages`)
      .where("slug", "==", slug)
      .limit(1)
      .get();
    if (!snap.empty) {
      const page = snap.docs[0].data() as CheckoutPage;
      accent = page.appearance?.accent || accent;
      dark = page.appearance?.theme === "dark";
    }
  } catch {
    // Fall back to the default look.
  }

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
      <div style={{ maxWidth: 420, textAlign: "center" }}>
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
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
          Payment received
        </h1>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 14.5,
            lineHeight: 1.6,
            color: dark ? "#a1a1aa" : "#52525b",
          }}
        >
          Thanks — your payment went through. A confirmation is on its way to
          your email.
        </p>
      </div>
    </main>
  );
}
