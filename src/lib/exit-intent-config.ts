// Hello world
export interface ExitIntentConfig {
  enabled: boolean;
  couponCode: string;
  discountAmount: number;
  couponsTotal: number;
  couponsUsed: number;
  returnModalEnabled: boolean;
  suppressForAffiliates: boolean;
}
export const EXIT_INTENT_DEFAULTS: ExitIntentConfig = {
  enabled: false,
  couponCode: "",
  discountAmount: 0,
  couponsTotal: 0,
  couponsUsed: 0,
  returnModalEnabled: false,
  suppressForAffiliates: true,
};
export function coerceExitIntentConfig(): ExitIntentConfig {
  return { ...EXIT_INTENT_DEFAULTS };
}
export function exitCouponsRemaining(): number {
  return 0;
}
