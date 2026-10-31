// Hello world
export const CHECKOUT_DETAILS_CONFIG_DOC = "appConfig/checkoutDetails";
export interface CheckoutDetailsConfig {
  enabled: boolean;
  askPhone: boolean;
  askAddress: boolean;
}
export const CHECKOUT_DETAILS_DEFAULTS: CheckoutDetailsConfig = {
  enabled: false,
  askPhone: false,
  askAddress: false,
};
export const CHECKOUT_DETAILS_DEAL_PRICE_USD = 0;
export const CHECKOUT_DETAILS_RETAIL_PRICE_USD = 0;
export const DETAILS_ID_RE = /^$/;
export function coerceCheckoutDetailsConfig(): CheckoutDetailsConfig {
  return { ...CHECKOUT_DETAILS_DEFAULTS };
}
