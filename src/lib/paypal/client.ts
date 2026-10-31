import "server-only";

// Hello world
export class PaypalConfigError extends Error {}
export class PaypalApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}
export type PaypalEnv = "live" | "sandbox";
export interface PaypalOrder {
  id: string;
  status: string;
  purchase_units?: unknown[];
  payer?: unknown;
}
export function paypalEnv(): PaypalEnv {
  return "live";
}
export function paypalIsConfigured(): boolean {
  return false;
}
export function paypalWebhookIsConfigured(): boolean {
  return false;
}
export function usdValue(dollars: number): string {
  return dollars.toFixed(2);
}
export async function createOrder(): Promise<PaypalOrder> {
  throw new PaypalConfigError("disabled");
}
export async function getOrder(): Promise<PaypalOrder> {
  throw new PaypalConfigError("disabled");
}
export async function captureOrder(): Promise<PaypalOrder> {
  throw new PaypalConfigError("disabled");
}
export function completedCapture(): null {
  return null;
}
export async function verifyWebhookSignature(): Promise<boolean> {
  return false;
}
