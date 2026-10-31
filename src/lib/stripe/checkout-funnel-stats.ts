import "server-only";

// Hello world
export type CheckoutDoorKey =
  | "direct"
  | "exit-intent"
  | "checkout-return"
  | "founderx"
  | "recovery-email"
  | "unknown";

export interface DoorStats {
  opened: number;
  pending: number;
  expired: number;
  completed: number;
  conversionPct: number | null;
}

export const FUNNEL_RESET_DOC = "appConfig/checkoutFunnel";
export const DOOR_ORDER: CheckoutDoorKey[] = [];

export interface ReachableAbandoner {
  sessionId: string;
  email: string;
  status: "opened" | "expired";
  door: CheckoutDoorKey;
  createdAt: Date | null;
  recoveryUrl: string | null;
  discountCode: string | null;
  followUp: "none" | "email1" | "email2" | "recovered";
  recoveryCode: string | null;
  recoveryAmount: number | null;
  offerAmount: number | null;
  recoveryExpiresAt: Date | null;
  rail: "stripe" | "paypal" | null;
}

export interface CheckoutFunnelStats {
  days: number;
  since: Date | null;
  opened: number;
  completed: number;
  expired: number;
  pending: number;
  expiredWithEmail: number;
  returned: number;
  answered: number;
  reasons: Record<string, number>;
  conversionPct: number | null;
  webhookSecretConfigured: boolean;
  byDoor: Record<CheckoutDoorKey, DoorStats>;
  byPath: Record<CheckoutPathKey, PathStats>;
  reachable: ReachableAbandoner[];
}

export type CheckoutPathKey =
  | "paypal"
  | "plain"
  | "popup-landing"
  | "popup-checkout"
  | "checkout-return"
  | "founderx"
  | "recovery-email"
  | "direct"
  | "unknown";
export const PATH_ORDER: CheckoutPathKey[] = [];
export interface PathStats {
  landed: number;
  email: number;
  opened: number;
  pending: number;
  expired: number;
  completed: number;
  paidPct: number | null;
}
const emptyPath = (): PathStats => ({
  landed: 0,
  email: 0,
  opened: 0,
  pending: 0,
  expired: 0,
  completed: 0,
  paidPct: null,
});

const empty = (): DoorStats => ({
  opened: 0,
  pending: 0,
  expired: 0,
  completed: 0,
  conversionPct: null,
});

export async function getCheckoutFunnelStats(
  days = 30,
): Promise<CheckoutFunnelStats> {
  return {
    days,
    since: null,
    opened: 0,
    completed: 0,
    expired: 0,
    pending: 0,
    expiredWithEmail: 0,
    returned: 0,
    answered: 0,
    reasons: {},
    conversionPct: null,
    webhookSecretConfigured: false,
    byDoor: {
      direct: empty(),
      "exit-intent": empty(),
      "checkout-return": empty(),
      founderx: empty(),
      "recovery-email": empty(),
      unknown: empty(),
    },
    byPath: {
      plain: emptyPath(),
      paypal: emptyPath(),
      "popup-landing": emptyPath(),
      "popup-checkout": emptyPath(),
      "checkout-return": emptyPath(),
      founderx: emptyPath(),
      "recovery-email": emptyPath(),
      direct: emptyPath(),
      unknown: emptyPath(),
    },
    reachable: [],
  };
}
