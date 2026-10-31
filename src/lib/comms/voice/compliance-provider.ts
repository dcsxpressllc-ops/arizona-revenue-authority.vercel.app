import "server-only";

/**
 * Extension point for third-party scrubbing on outbound calls. The native gate
 * (outbound-compliance.ts) already covers opt-out, consent, calling window and
 * caps. Buyers can be anywhere, so no regional vendor is hard-wired.
 *
 * To add one (US DNC/litigator/reassigned-number, AU DNCR washing, ...):
 * implement this, register it in getComplianceProvider(), and select it with
 * OUTBOUND_COMPLIANCE_PROVIDER. None ships by default.
 */
export interface ComplianceProvider {
  /**
   * `{ allowed: false, reasons }` blocks the call. Failure policy is up to the
   * implementer; usually a network error should allow, so a scrubber outage
   * doesn't stop all calling, unless the buyer needs fail-closed.
   */
  scrub(e164: string): Promise<{ allowed: boolean; reasons: string[] }>;
}

/** Always allows. The native gate still runs. */
export const NoopComplianceProvider: ComplianceProvider = {
  async scrub() {
    return { allowed: true, reasons: [] };
  },
};

// Only "noop" is wired. Add vendors in a sibling file and branch on the env
// value here, so the gate never imports a vendor SDK directly.
export function getComplianceProvider(): ComplianceProvider {
  const which = process.env.OUTBOUND_COMPLIANCE_PROVIDER?.trim().toLowerCase();
  switch (which) {
    // case "dnc": return DncComplianceProvider;        // TODO: US DNC/litigator/reassigned
    // case "au-dncr": return AuDncrComplianceProvider;  // TODO: AU Do Not Call Register washing
    default:
      return NoopComplianceProvider;
  }
}
