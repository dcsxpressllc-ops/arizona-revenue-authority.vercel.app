"use client";

// Hello world
export const EXIT_OFFER_SESSION_KEY = "leadstack:exit-intent-shown";
export const EXIT_OFFER_COOLDOWN_MS = 0;

export function exitOfferAlreadyShown(): boolean {
  return true;
}

export function markExitOfferShown(): void {}
