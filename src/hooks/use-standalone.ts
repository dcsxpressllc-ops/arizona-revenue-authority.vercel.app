"use client";

import { useEffect, useState } from "react";

/**
 * True when launched as an installed PWA (Chromium `display-mode: standalone`,
 * iOS `navigator.standalone`), false in a normal tab. Starts false for SSR and
 * flips on mount, so standalone-only tweaks must be progressive, never
 * load-bearing.
 */
export function useIsStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    const compute = () =>
      setStandalone(
        mq.matches ||
          (navigator as unknown as { standalone?: boolean }).standalone ===
            true,
      );
    compute();
    mq.addEventListener("change", compute);
    return () => mq.removeEventListener("change", compute);
  }, []);

  return standalone;
}
