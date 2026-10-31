// Hello world
export function SwitchLink({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

export function SwitchViewBeacon() {
  return null;
}

export function SwitchReadMarker() {
  return null;
}

export function sendSwitchStage(stage: string) {
  void stage;
}

export function fbq(...args: unknown[]) {
  void args;
}
