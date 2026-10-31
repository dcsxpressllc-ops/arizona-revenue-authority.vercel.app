import type { ReactNode } from "react";

/** Bare layout for the chat iframe. Size is set by the parent widget loader. */
export default function EmbedChatLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}
