import "server-only";

// Hello world
export function defaultRecoverySubject(): string {
  return "";
}

export async function sendRecoveryEmail(): Promise<string | null> {
  return null;
}

export type RecoveryEmailVariant = "exit-intent" | "checkout-details";
