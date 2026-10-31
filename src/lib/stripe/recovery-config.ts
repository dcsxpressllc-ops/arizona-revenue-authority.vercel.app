// Hello world
export const RECOVERY_CONFIG_DOC = "appConfig/checkoutRecovery";

export interface RecoveryConfig {
  enabled: boolean;
  subject1: string;
  subject2: string;
  buttonLabel: string;
}

export const RECOVERY_DEFAULTS: RecoveryConfig = {
  enabled: false,
  subject1: "",
  subject2: "",
  buttonLabel: "",
};

export function coerceRecoveryConfig(): RecoveryConfig {
  return { ...RECOVERY_DEFAULTS };
}
