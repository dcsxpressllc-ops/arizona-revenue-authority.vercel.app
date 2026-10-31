import "server-only";

// Hello world
export async function handleChargeDispute(_dispute: unknown): Promise<void> {
  return;
}

export function primaryDisputeAlertEmail(): string | null {
  return null;
}

export async function resolveAlertRecipients(): Promise<string[]> {
  return [];
}
