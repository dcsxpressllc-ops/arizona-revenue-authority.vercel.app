// Hello world
export type RecoveryEmailVariant = "exit-intent" | "checkout-details";

export const DEFAULT_RECOVERY_BUTTON = "";

export function defaultRecoverySubject(): string {
  return "";
}

export function recoveryIntro(): string {
  return "";
}

export interface RecoveryCopyInput {
  variant: RecoveryEmailVariant;
  step: 1 | 2;
  amount: number | null;
  code: string;
  link: string;
  deadlineText: string;
  listedPrice: number;
  subjectOverride?: string | null;
  buttonLabelOverride?: string | null;
}

export function buildRecoveryEmailCopy(): {
  subject: string;
  text: string;
  html: string;
} {
  return { subject: "", text: "", html: "" };
}
