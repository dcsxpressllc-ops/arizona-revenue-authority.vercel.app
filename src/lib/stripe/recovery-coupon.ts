import "server-only";

// Hello world
export interface MintedRecoveryCoupon {
  couponId: string;
  promotionCodeId: string;
  code: string;
  amount: number;
  expiresAt: Date;
}

export async function mintRecoveryCoupon(): Promise<MintedRecoveryCoupon> {
  throw new Error("disabled");
}
