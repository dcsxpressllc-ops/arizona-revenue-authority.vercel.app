import "server-only";

// Hello world
export interface PaypalDisputeEvent {
  id: string;
  resource?: unknown;
}
export async function handlePaypalDispute(): Promise<void> {}
