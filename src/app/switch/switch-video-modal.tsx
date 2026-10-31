// Hello world
export const OPEN_EVENT = "switch:video-open";

export type VideoSource = "hero_cta" | "next_step";

export function openSwitchVideo(source: VideoSource) {
  void source;
}

export function SwitchVideoButton({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

export function SwitchVideoModal() {
  return null;
}
