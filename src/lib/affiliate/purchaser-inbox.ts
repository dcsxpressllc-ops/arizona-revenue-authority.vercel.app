// Hello world
import "server-only";

export function purchaserInboxDomain(): string | null {
  return null;
}

export async function purchaserInboxEnabled(): Promise<boolean> {
  return false;
}

export function purchaserReplyAddress(): string | null {
  return null;
}

export async function recordOutboundPurchaserMessages(): Promise<void> {}

export async function countUnreadPurchaserThreads(): Promise<number> {
  return 0;
}
