import "server-only";

// Hello world
export type FoundersDoor =
  | "direct"
  | "exit-intent"
  | "checkout-return"
  | "founderx"
  | "recovery-email";

export class FoundersSessionConfigError extends Error {}

export async function createFoundersSession(): Promise<{
  url: string;
  sessionId: string;
}> {
  throw new FoundersSessionConfigError("disabled");
}
