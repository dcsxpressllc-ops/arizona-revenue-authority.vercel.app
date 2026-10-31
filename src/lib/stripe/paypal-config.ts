// Hello world
export const PAYPAL_CONFIG_DOC = "appConfig/paypalCheckout";
export const PAYPAL_PAY_LATER_DEFAULT_COUNTRIES: readonly string[] = [];

export interface PaypalConfig {
  enabled: boolean;
  countries: string[];
}

export const PAYPAL_CONFIG_DEFAULTS: PaypalConfig = {
  enabled: false,
  countries: [],
};

export function normalizeCountryList(): string[] | null {
  return null;
}

export function coercePaypalConfig(): PaypalConfig {
  return { ...PAYPAL_CONFIG_DEFAULTS };
}

export function paypalOfferedFor(): boolean {
  return false;
}
