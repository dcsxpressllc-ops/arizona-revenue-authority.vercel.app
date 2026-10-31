"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Grip,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Contact } from "@/types/contacts";

/**
 * Floating in-call bar, one per call. Fetches a scoped AccessToken, lazy-loads
 * @twilio/voice-sdk, then device.connect({ params: { contactId } }); our TwiML
 * App webhook dials the contact server-side. The browser only holds a short-TTL JWT.
 */

type CallPhase = "connecting" | "ringing" | "in-call" | "ended" | "error";

/** Structural types for the lazy-loaded SDK, to avoid a hard type dependency. */
interface VoiceCall {
  on(event: string, handler: (...args: unknown[]) => void): void;
  mute(shouldMute: boolean): void;
  isMuted(): boolean;
  sendDigits(digits: string): void;
  disconnect(): void;
}
interface VoiceDevice {
  connect(opts: { params: Record<string, string> }): Promise<VoiceCall>;
  destroy(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

export function BrowserCallBar({
  contact,
  subAccountId,
  onClose,
}: {
  contact: Contact;
  subAccountId: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<CallPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [showKeypad, setShowKeypad] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const deviceRef = useRef<VoiceDevice | null>(null);
  const callRef = useRef<VoiceCall | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teardown = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    callRef.current = null;
    deviceRef.current?.destroy();
    deviceRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const res = await fetch("/api/comms/dialer/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subAccountId }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          token?: string;
          error?: string;
        };
        if (!res.ok || !data.ok || !data.token) {
          throw new Error(data.error ?? "Couldn't authorize the call.");
        }
        if (cancelled) return;

        const { Device } = await import("@twilio/voice-sdk");
        if (cancelled) return;
        const device = new Device(data.token) as unknown as VoiceDevice;
        deviceRef.current = device;
        device.on("error", (e) => {
          const msg =
            e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : "Call failed.";
          setError(msg);
          setPhase("error");
        });

        setPhase("ringing");
        const call = await device.connect({
          params: { contactId: contact.id },
        });
        if (cancelled) {
          call.disconnect();
          return;
        }
        callRef.current = call;
        call.on("accept", () => {
          setPhase("in-call");
          timerRef.current = setInterval(
            () => setSeconds((s) => s + 1),
            1000,
          );
        });
        const onEnd = () => {
          setPhase((p) => (p === "error" ? p : "ended"));
          if (timerRef.current) clearInterval(timerRef.current);
          closeTimerRef.current = setTimeout(onClose, 2500);
        };
        call.on("disconnect", onEnd);
        call.on("cancel", onEnd);
        call.on("error", (e) => {
          const msg =
            e && typeof e === "object" && "message" in e
              ? String((e as { message: unknown }).message)
              : "Call failed.";
          setError(msg);
          setPhase("error");
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't start the call.");
        setPhase("error");
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      callRef.current?.disconnect();
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id, subAccountId]);

  function toggleMute() {
    const call = callRef.current;
    if (!call) return;
    const next = !call.isMuted();
    call.mute(next);
    setMuted(next);
  }

  function hangUp() {
    callRef.current?.disconnect();
    if (phase === "connecting" || phase === "error") onClose();
  }

  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  const statusLine =
    phase === "connecting"
      ? "Connecting…"
      : phase === "ringing"
        ? "Ringing…"
        : phase === "in-call"
          ? `${mm}:${ss}`
          : phase === "ended"
            ? "Call ended"
            : (error ?? "Call failed");

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-2xl border bg-card p-4 shadow-xl">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {contact.name || contact.phone}
          </p>
          <p
            className={cn(
              "text-xs",
              phase === "error"
                ? "text-destructive"
                : phase === "in-call"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground",
            )}
          >
            {statusLine}
          </p>
        </div>
        {(phase === "connecting" || phase === "ringing") && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>

      {showKeypad && phase === "in-call" && (
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {KEYPAD.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => callRef.current?.sendDigits(d)}
              className="rounded-lg border bg-background py-1.5 text-sm font-medium hover:bg-muted"
            >
              {d}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={toggleMute}
          disabled={phase !== "in-call"}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? (
            <MicOff className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowKeypad((v) => !v)}
          disabled={phase !== "in-call"}
          title="Keypad"
        >
          <Grip className="h-3.5 w-3.5" />
        </Button>
        {phase === "ended" ? (
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={hangUp}
          >
            <PhoneOff className="mr-1 h-3.5 w-3.5" />
            {phase === "error" ? "Close" : "Hang up"}
          </Button>
        )}
      </div>
    </div>
  );
}
