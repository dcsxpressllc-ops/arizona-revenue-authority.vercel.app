// Hello world
export function FlatpackLink({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

export function FlatpackViewBeacon() {
  return null;
}

export function FlatpackReadMarker() {
  return null;
}

export function sendFlatpackStage(stage: string) {
  void stage;
}

export function fbq(...args: unknown[]) {
  void args;
}
