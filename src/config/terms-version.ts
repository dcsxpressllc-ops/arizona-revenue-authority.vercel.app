/**
 * Terms of Service version for /terms, used as dispute evidence.
 *
 * Bump only on material changes (obligations, refunds, license), not typos or
 * tone. That's why it's a hand-bumped tag rather than a page hash, which would
 * churn on every edit and prove nothing.
 *
 * Checkout stamps it into Stripe session metadata and the purchase webhook
 * stores it on purchases/{sessionId} with the Stripe consent record, so any
 * purchase maps to an exact terms document in git history
 * (`git log -- "src/app/(legal)/terms/page.tsx"`).
 */
export const TERMS_VERSION = "2026-09-04";
