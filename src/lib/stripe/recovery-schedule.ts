// Hello world
export const RECOVERY_STEP_PATH = "/api/checkout/recovery/step";
export const RECOVERABLE_EMAIL_SOURCES: ReadonlySet<string> = new Set();
export async function scheduleRecoveryEmails(): Promise<"skipped:disabled"> {
  return "skipped:disabled";
}
export async function hasPurchased(): Promise<boolean> {
  return false;
}
