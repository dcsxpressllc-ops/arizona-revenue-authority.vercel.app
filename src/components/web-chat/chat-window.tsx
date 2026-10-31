"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { accentOnWhite, textOnAccent } from "@/components/web-chat/contrast";

/**
 * Chat widget rendered inside the /embed/chat/[saId] iframe. Owns the session
 * id, message history, the send call and postMessage open/close/resize to the
 * parent loader.
 *
 * No shadcn here: the iframe has none of the host page's Tailwind variables,
 * so it uses inline styles plus a small <style> block, which also keeps the
 * buyer's CSS from bleeding in.
 */

interface ChatWindowProps {
  subAccountId: string;
  welcomeMessage: string;
  accentColor: string;
  /** Inside the loader's iframe: shows the close button, which asks the parent loader to hide the iframe. */
  embedded: boolean;
}

type CaptureFieldId = "name" | "email" | "phone";

type LocalMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  pending?: boolean;
  /** Assistant-only: render an inline capture form with these fields. Cleared once submitted/skipped. */
  formFields?: CaptureFieldId[];
  /** Assistant-only: bookable times shown as buttons. Cleared on the visitor's next message. */
  slots?: OfferedSlot[];
};

type OfferedSlot = { startIso: string; label: string };

function sessionStorageKey(saId: string): string {
  return `leadstack:webchat:session:${saId}`;
}

/** 22-char URL-safe id. Server accepts 16-64 chars of [a-zA-Z0-9_-]. */
function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function ensureSessionId(saId: string): string {
  if (typeof window === "undefined") return "";
  const key = sessionStorageKey(saId);
  let existing = window.localStorage.getItem(key);
  if (!existing) {
    existing = newSessionId();
    window.localStorage.setItem(key, existing);
  }
  return existing;
}

function postToParent(message: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  if (window.parent === window) return;
  window.parent.postMessage({ source: "leadstack-webchat", ...message }, "*");
}

/** ms to wait for a human reply (held message, within hours) before the softer
 *  "we'll follow up" note. Reset on each visitor send, cleared on operator reply. */
const WAIT_NOTE_DELAY_MS = 3 * 60 * 1000;
/** Shown immediately when a held message lands outside configured hours. */
const OFFLINE_NOTE =
  "We're offline right now — leave your details and we'll get back to you.";
const WAITING_NOTE = "Thanks for waiting — we'll follow up as soon as we can.";

type VoiceStatus = "idle" | "connecting" | "listening" | "speaking";

/** The bit of the ElevenLabs conversation we use. SDK is dynamically imported on mic tap only. */
type VoiceConversation = {
  endSession: () => Promise<void>;
  /** Text into the live call, answered by voice like speech. */
  sendUserMessage: (text: string) => void;
};

/** Times on offer during a voice call; `key` changes with each new offer. */
type VoiceOffer = { key: number; slots: OfferedSlot[] };

/** If the agent has no greeting, stop ringing this long after the call opens. */
const ANSWER_FALLBACK_MS = 4000;

/**
 * A soft ring while the call connects, then a short chime when the agent
 * answers, so the gap before the greeting doesn't sound like a dead line.
 * Must be created inside the click so the browser lets it play.
 */
function createCallTones(): { ring: () => void; answered: () => void; stop: () => void } {
  const Ctx =
    typeof window !== "undefined"
      ? window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!Ctx) return { ring: () => {}, answered: () => {}, stop: () => {} };
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctx();
  } catch {
    return { ring: () => {}, answered: () => {}, stop: () => {} };
  }
  let ringTimer: ReturnType<typeof setInterval> | null = null;

  const beep = (freq: number, at: number, length: number, volume: number) => {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.03);
    gain.gain.setValueAtTime(volume, at + length - 0.05);
    gain.gain.linearRampToValueAtTime(0, at + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length);
  };
  const ringOnce = () => {
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    beep(440, t, 0.4, 0.05);
    beep(440, t + 0.6, 0.4, 0.05);
  };
  const stopRing = () => {
    if (ringTimer) clearInterval(ringTimer);
    ringTimer = null;
  };
  const close = (afterMs: number) => {
    const c = ctx;
    ctx = null;
    if (c) setTimeout(() => void c.close().catch(() => {}), afterMs);
  };

  return {
    ring: () => {
      if (!ctx || ringTimer) return;
      void ctx.resume().catch(() => {});
      ringOnce();
      ringTimer = setInterval(ringOnce, 2500);
    },
    answered: () => {
      stopRing();
      if (!ctx) return;
      const t = ctx.currentTime + 0.02;
      beep(660, t, 0.12, 0.06);
      beep(880, t + 0.14, 0.16, 0.06);
      close(600);
    },
    stop: () => {
      stopRing();
      close(0);
    },
  };
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function MicIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

export function ChatWindow(props: ChatWindowProps) {
  const { subAccountId, welcomeMessage, accentColor, embedded } = props;
  // Light accents need dark text, and the accent is darkened where drawn on white (mic button).
  const onAccent = useMemo(() => textOnAccent(accentColor), [accentColor]);
  const accentInk = useMemo(() => accentOnWhite(accentColor), [accentColor]);

  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errored, setErrored] = useState(false);
  // Status line while a human has the thread. "Offline" line straight away when
  // a held message lands outside hours, else the softer line after
  // WAIT_NOTE_DELAY_MS. Cleared when the operator replies.
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [parentPageUrl, setParentPageUrl] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Delivery poll state: ids already rendered (so inline replies aren't shown
  // twice), the createdAt cursor, and a primed flag so the first poll seeds
  // history without replaying it.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const cursorRef = useRef<number>(0);
  const primedRef = useRef<boolean>(false);
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // voiceToken comes from the loader (?vt=), only set when the origin-checked
  // /config said voice is available. Null = no mic.
  const [voiceToken, setVoiceToken] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [voiceMaxSeconds, setVoiceMaxSeconds] = useState(0);
  const voiceConvRef = useRef<VoiceConversation | null>(null);
  // True from the mic tap until the call is fully closed, so only one call can exist.
  const voiceBusyRef = useRef(false);
  // Times on offer during a call, from the poll. Read by the poll via a ref
  // so the polling interval isn't restarted on every status change.
  const [voiceOffer, setVoiceOffer] = useState<VoiceOffer | null>(null);
  const voiceLiveRef = useRef(false);
  const tappedOfferKeyRef = useRef<number | null>(null);
  // Offer key seen when the call connected; undefined = not polled yet this call.
  const callBaselineKeyRef = useRef<number | null | undefined>(undefined);
  // End pressed before the call finished connecting.
  const voiceCancelRef = useRef(false);
  const voiceSessionTokenRef = useRef<string | null>(null);
  const voiceConversationIdRef = useRef<string | null>(null);
  // Ring until the agent first speaks; the call clock starts then.
  const callTonesRef = useRef<ReturnType<typeof createCallTones> | null>(null);
  const answerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceActive = voiceStatus !== "idle";

  const clearWaitTimer = useCallback(() => {
    if (waitTimerRef.current) {
      clearTimeout(waitTimerRef.current);
      waitTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearWaitTimer(), [clearWaitTimer]);

  // Boot: session id, parent-page URL from ?p=, welcome message.
  useEffect(() => {
    const sid = ensureSessionId(subAccountId);
    setSessionId(sid);
    try {
      const qs = new URLSearchParams(window.location.search);
      const p = qs.get("p");
      if (p) setParentPageUrl(p);
      const vt = qs.get("vt");
      if (vt) setVoiceToken(vt);
    } catch {
      // Parent URL is only used for server-side logging.
    }
    setMessages([
      { id: "welcome", role: "assistant", text: welcomeMessage },
    ]);
  }, [subAccountId, welcomeMessage]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Web chat has no provider push, so the widget polls for operator replies
  // and approved suggest-mode drafts. First poll primes the seen-set, later
  // polls render only unseen outbound messages.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let lastPollMs = 0;
    let inFlight = false;

    async function poll() {
      // Skip while hidden; the cursor only moves forward so the next tick catches up.
      if (typeof document !== "undefined" && document.hidden) return;
      if (inFlight) return;
      inFlight = true;
      lastPollMs = Date.now();
      // During a call, also ask for the times on offer (shown as buttons).
      const withOffer = voiceLiveRef.current;
      try {
        const res = await fetch(
          `/api/web-chat/poll?sa=${encodeURIComponent(
            subAccountId,
          )}&sessionId=${encodeURIComponent(sessionId)}&after=${cursorRef.current}${
            withOffer ? "&withOffer=1" : ""
          }`,
          { method: "GET" },
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          messages?: {
            id: string;
            body: string;
            createdAtMs: number;
            via?: "voice";
          }[];
          offer?: VoiceOffer | null;
          serverNowMs?: number;
        };
        if (withOffer && voiceLiveRef.current && data.offer !== undefined) {
          const next = data.offer;
          // An offer left over from before the call isn't shown, only ones the
          // call makes. The baseline normally comes from /voice/start; the
          // first poll is only a fallback for an older server.
          if (callBaselineKeyRef.current === undefined) {
            callBaselineKeyRef.current = next?.key ?? null;
          }
          // A tapped offer stays hidden; a new offer (new key) shows again.
          setVoiceOffer(
            next &&
              next.slots.length > 0 &&
              next.key !== tappedOfferKeyRef.current &&
              next.key !== callBaselineKeyRef.current
              ? next
              : null,
          );
        }
        const incoming = data.messages ?? [];
        for (const m of incoming) {
          if (m.createdAtMs > cursorRef.current) cursorRef.current = m.createdAtMs;
          if (seenIdsRef.current.has(m.id)) continue;
          seenIdsRef.current.add(m.id);
          // Voice turns were already shown live by the SDK.
          if (m.via === "voice") continue;
          if (!primedRef.current) continue;
          // Operator replied: drop the handoff note and wait timer.
          setHandoffNote(null);
          clearWaitTimer();
          setMessages((prev) => [
            ...prev,
            { id: `poll-${m.id}`, role: "assistant", text: m.body },
          ]);
        }
        primedRef.current = true;
      } catch {
        // Silent, next tick retries.
      } finally {
        inFlight = false;
      }
    }

    void poll();
    // Every 5s normally; every 2s during a call so offered times show up quickly.
    const iv = setInterval(() => {
      const gap = voiceLiveRef.current ? 2000 : 5000;
      if (Date.now() - lastPollMs >= gap) void poll();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [sessionId, subAccountId, clearWaitTimer]);

  const sendMessage = useCallback(
    async (text: string, pickedSlot?: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending || !sessionId) return;

      const userMsg: LocalMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        text: trimmed,
      };
      // Time buttons belong to the offer they came with; any new message retires them.
      setMessages((prev) => [
        ...prev.map((m) => (m.slots ? { ...m, slots: undefined } : m)),
        userMsg,
      ]);
      setInput("");
      setSending(true);
      setErrored(false);

      try {
        const res = await fetch("/api/web-chat/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sa: subAccountId,
            sessionId,
            message: trimmed,
            ...(pickedSlot ? { pickedSlot } : {}),
            // Parent page URL. Falls back to document.referrer, and last to the
            // iframe's own href (wrong page, but better than nothing for logs).
            pageUrl:
              parentPageUrl ||
              document.referrer ||
              (typeof window !== "undefined" ? window.location.href : null),
            referrer: document.referrer || null,
          }),
        });
        const data = (await res.json()) as {
          reply?: string | null;
          error?: string;
          formFields?: CaptureFieldId[] | null;
          slots?: OfferedSlot[] | null;
          messageId?: string;
          held?: boolean;
          offline?: boolean;
        };
        if (!res.ok) {
          throw new Error(data.error ?? "no reply");
        }
        // So the delivery poll doesn't render it again.
        if (data.messageId) seenIdsRef.current.add(data.messageId);
        // A human has the thread: no bot reply. Outside hours, say so now;
        // otherwise arm a timer for the softer follow-up note.
        if (data.held) {
          clearWaitTimer();
          if (data.offline) {
            setHandoffNote(OFFLINE_NOTE);
          } else {
            setHandoffNote(null);
            waitTimerRef.current = setTimeout(() => {
              setHandoffNote(WAITING_NOTE);
            }, WAIT_NOTE_DELAY_MS);
          }
          return;
        }
        if (!data.reply) {
          throw new Error(data.error ?? "no reply");
        }
        // Bot answered, so AI is back in control: clear any handoff note/timer.
        clearWaitTimer();
        setHandoffNote(null);
        const replyText = data.reply;
        const formFields = data.formFields ?? null;
        const slots = Array.isArray(data.slots)
          ? data.slots.filter(
              (s) =>
                typeof s?.startIso === "string" && typeof s?.label === "string",
            )
          : [];
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: replyText,
            formFields: formFields && formFields.length > 0 ? formFields : undefined,
            slots: slots.length > 0 ? slots : undefined,
          },
        ]);
      } catch {
        setErrored(true);
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            text:
              "I had trouble reaching the server. Try again in a moment, or refresh the page.",
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [subAccountId, sessionId, sending, parentPageUrl, clearWaitTimer],
  );

  /** Fire-and-forget lifecycle ping. `beacon` survives page unload. */
  const sendVoiceEvent = useCallback(
    (type: "connected" | "ended", beacon = false) => {
      const token = voiceSessionTokenRef.current;
      const conversationId = voiceConversationIdRef.current;
      if (!token || !conversationId) return;
      const payload = JSON.stringify({ token, type, conversationId });
      if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon("/api/web-chat/voice/event", payload);
        return;
      }
      void fetch("/api/web-chat/voice/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    },
    [],
  );

  // Only a connected call asks the poll for offered times.
  useEffect(() => {
    voiceLiveRef.current = voiceStatus === "listening" || voiceStatus === "speaking";
  }, [voiceStatus]);

  /** Tapping a time during a call sends it into the call as if spoken. */
  const pickVoiceSlot = useCallback((offerKey: number, slot: OfferedSlot) => {
    const conv = voiceConvRef.current;
    if (!conv) return;
    const text = `I'll take ${slot.label}`;
    try {
      conv.sendUserMessage(text);
    } catch {
      return;
    }
    tappedOfferKeyRef.current = offerKey;
    setVoiceOffer(null);
    setMessages((prev) => [
      ...prev,
      { id: `vt-${Date.now()}`, role: "user", text },
    ]);
  }, []);

  const resetVoice = useCallback(() => {
    callTonesRef.current?.stop();
    callTonesRef.current = null;
    if (answerTimerRef.current) clearTimeout(answerTimerRef.current);
    answerTimerRef.current = null;
    setVoiceOffer(null);
    tappedOfferKeyRef.current = null;
    callBaselineKeyRef.current = undefined;
    voiceLiveRef.current = false;
    voiceBusyRef.current = false;
    voiceConvRef.current = null;
    voiceSessionTokenRef.current = null;
    voiceConversationIdRef.current = null;
    setVoiceStatus("idle");
    setVoiceElapsed(0);
  }, []);

  const startVoice = useCallback(async () => {
    // A ref, not state: a quick second tap runs before the re-render, and two
    // live calls mean two voices answering every turn.
    if (!voiceToken || !sessionId || voiceBusyRef.current || sending) return;
    voiceBusyRef.current = true;
    voiceCancelRef.current = false;
    callBaselineKeyRef.current = undefined;
    tappedOfferKeyRef.current = null;
    setVoiceNote(null);
    setVoiceStatus("connecting");
    callTonesRef.current?.stop();
    const tones = createCallTones();
    callTonesRef.current = tones;
    tones.ring();
    let answered = false;
    const markAnswered = () => {
      if (answered) return;
      answered = true;
      if (answerTimerRef.current) clearTimeout(answerTimerRef.current);
      answerTimerRef.current = null;
      tones.answered();
    };
    // The voice conversation may book or offer new times, so typed buttons go stale.
    setMessages((prev) =>
      prev.map((m) => (m.slots ? { ...m, slots: undefined } : m)),
    );

    // Ask for the mic first, inside the click, so the prompt is tied to the
    // gesture and a refusal costs no voice minutes.
    let probe: MediaStream | null = null;
    try {
      probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      tones.stop();
      voiceBusyRef.current = false;
      setVoiceStatus("idle");
      setVoiceNote(
        "Microphone access was blocked. Allow it in your browser to talk, or keep typing.",
      );
      return;
    }

    try {
      const res = await fetch("/api/web-chat/voice/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sa: subAccountId,
          sessionId,
          voiceToken,
          pageUrl: parentPageUrl || document.referrer || null,
          referrer: document.referrer || null,
        }),
      });
      const data = (await res.json()) as {
        signedUrl?: string;
        token?: string;
        maxCallSeconds?: number;
        offerBaselineKey?: number | null;
        error?: string;
        voiceEnabled?: boolean;
      };
      if (!res.ok || !data.signedUrl || !data.token) {
        if (data.voiceEnabled === false) setVoiceToken(null);
        throw new Error(data.error || "Couldn't start voice — please type instead.");
      }
      // End was pressed while we were setting up: don't open the call at all.
      if (voiceCancelRef.current) {
        resetVoice();
        return;
      }
      voiceSessionTokenRef.current = data.token;
      setVoiceMaxSeconds(data.maxCallSeconds ?? 0);
      // From the server at call start, so a missed or late first poll can't
      // mistake an in-call offer for a leftover one.
      callBaselineKeyRef.current = data.offerBaselineKey ?? null;

      const { Conversation } = await import("@elevenlabs/client");
      // Callbacks from a call that's no longer the current one must not touch the UI.
      let thisConv: VoiceConversation | null = null;
      const isCurrent = () =>
        voiceConvRef.current === null || voiceConvRef.current === thisConv;
      const conversation = await Conversation.startSession({
        signedUrl: data.signedUrl,
        connectionType: "websocket",
        // Sent to LeadStack's reply endpoint each turn to bind the call to this chat session.
        customLlmExtraBody: { token: data.token },
        onConnect: ({ conversationId }) => {
          if (voiceCancelRef.current || !isCurrent()) return;
          voiceConversationIdRef.current = conversationId;
          sendVoiceEvent("connected");
          // Stay on "Connecting" until the greeting starts, unless there is none.
          answerTimerRef.current = setTimeout(() => {
            if (voiceCancelRef.current || !isCurrent() || answered) return;
            markAnswered();
            setVoiceStatus("listening");
          }, ANSWER_FALLBACK_MS);
        },
        onModeChange: ({ mode }) => {
          if (voiceCancelRef.current || !isCurrent()) return;
          if (mode === "speaking") markAnswered();
          if (!answered) return;
          setVoiceStatus(mode === "speaking" ? "speaking" : "listening");
        },
        onMessage: ({ message, role, event_id }) => {
          if (voiceCancelRef.current || !isCurrent()) return;
          const text = message?.trim();
          if (!text) return;
          setMessages((prev) => [
            ...prev,
            {
              id: `v-${role}-${event_id}-${Date.now()}`,
              role: role === "user" ? "user" : "assistant",
              text,
            },
          ]);
        },
        onDisconnect: () => {
          if (!isCurrent()) return;
          sendVoiceEvent("ended");
          resetVoice();
        },
        onError: (message) => {
          setVoiceNote(
            typeof message === "string" && message
              ? "Voice connection problem — you can keep typing."
              : "Voice connection problem.",
          );
        },
      });
      thisConv = conversation;
      // End was pressed while connecting: the call opened anyway, so close it now.
      if (voiceCancelRef.current) {
        await conversation.endSession().catch(() => {});
        sendVoiceEvent("ended");
        resetVoice();
        return;
      }
      voiceConvRef.current = conversation;
    } catch (err) {
      resetVoice();
      setVoiceNote(err instanceof Error ? err.message : "Couldn't start voice.");
    } finally {
      probe?.getTracks().forEach((t) => t.stop());
    }
  }, [
    voiceToken,
    sessionId,
    sending,
    subAccountId,
    parentPageUrl,
    sendVoiceEvent,
    resetVoice,
  ]);

  const stopVoice = useCallback(async () => {
    const conv = voiceConvRef.current;
    if (!conv) {
      // Still connecting: startVoice sees the flag and closes the call it opens.
      voiceCancelRef.current = true;
      callTonesRef.current?.stop();
      callTonesRef.current = null;
      if (answerTimerRef.current) clearTimeout(answerTimerRef.current);
      answerTimerRef.current = null;
      setVoiceStatus("idle");
      setVoiceElapsed(0);
      return;
    }
    try {
      await conv.endSession();
    } catch {
      // onDisconnect may not fire if the socket was already gone.
      sendVoiceEvent("ended");
      resetVoice();
    }
  }, [resetVoice, sendVoiceEvent]);

  // Display only; ElevenLabs enforces the real limit.
  useEffect(() => {
    if (voiceStatus === "idle" || voiceStatus === "connecting") return;
    const iv = setInterval(() => setVoiceElapsed((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [voiceStatus]);

  // Tab closed or unmounted mid-call: settle minutes via beacon and end the session.
  useEffect(() => {
    function onHide() {
      if (voiceConvRef.current) sendVoiceEvent("ended", true);
    }
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void voiceConvRef.current?.endSession().catch(() => {});
    };
  }, [sendVoiceEvent]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  const handleCaptureFormDone = useCallback(
    async (
      messageId: string,
      payload:
        | { skip: true }
        | { skip?: false; name?: string; email?: string; phone?: string },
    ) => {
      if (!sessionId) return;
      // Remove the form right away, whatever the network outcome.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, formFields: undefined } : m,
        ),
      );
      try {
        const res = await fetch("/api/web-chat/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sa: subAccountId,
            sessionId,
            pageUrl:
              parentPageUrl ||
              (typeof window !== "undefined" ? window.location.href : null),
            ...payload,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          reply?: string;
          error?: string;
          messageId?: string;
        };
        if (!res.ok || !data.reply) {
          throw new Error(data.error ?? "capture failed");
        }
        if (data.messageId) seenIdsRef.current.add(data.messageId);
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: data.reply!,
          },
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            text: msg,
          },
        ]);
      }
    },
    [subAccountId, sessionId, parentPageUrl],
  );

  function handleClose() {
    // Closing hides the iframe but keeps it alive, so don't leave a call running.
    if (voiceActive) void stopVoice();
    postToParent({ type: "close" });
  }

  const containerStyle = useMemo<React.CSSProperties>(
    () => ({
      // Parent loader sizes the iframe; just fill it.
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "#ffffff",
      color: "#0f172a",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      fontSize: "14px",
      lineHeight: 1.45,
      overflow: "hidden",
      borderRadius: embedded ? "16px" : "0",
      boxShadow: embedded ? "0 16px 48px -12px rgba(15,23,42,0.25)" : "none",
    }),
    [embedded],
  );

  return (
    <div style={containerStyle}>
      <style>{`
        .lswc-bubble {
          max-width: 80%;
          padding: 10px 14px;
          border-radius: 16px;
          word-wrap: break-word;
          white-space: pre-wrap;
        }
        .lswc-bubble-assistant {
          background: #f1f5f9;
          color: #0f172a;
          border-bottom-left-radius: 4px;
        }
        .lswc-bubble-user {
          background: ${accentColor};
          color: ${onAccent};
          align-self: flex-end;
          border-bottom-right-radius: 4px;
        }
        .lswc-row {
          display: flex;
          margin-top: 10px;
        }
        .lswc-row-user { justify-content: flex-end; }
        .lswc-row-assistant { justify-content: flex-start; }
        @keyframes lswc-pulse {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        .lswc-typing-dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          margin: 0 2px;
          border-radius: 50%;
          background: #94a3b8;
          animation: lswc-pulse 1.2s infinite ease-in-out;
        }
        .lswc-typing-dot:nth-child(2) { animation-delay: 0.15s; }
        .lswc-typing-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes lswc-voice-pulse {
          0% { box-shadow: 0 0 0 0 ${accentColor}66; }
          70% { box-shadow: 0 0 0 8px ${accentColor}00; }
          100% { box-shadow: 0 0 0 0 ${accentColor}00; }
        }
        .lswc-voice-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: ${accentColor};
          animation: lswc-voice-pulse 1.4s infinite;
          flex-shrink: 0;
        }
      `}</style>

      <div
        style={{
          background: accentColor,
          color: onAccent,
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: onAccent === "#ffffff" ? "rgba(255,255,255,0.2)" : "rgba(15,23,42,0.08)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
            }}
            aria-hidden
          >
            💬
          </span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Chat with us</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>
              We typically reply instantly
            </div>
          </div>
        </div>
        {embedded && (
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close chat"
            style={{
              background: "transparent",
              color: onAccent,
              border: 0,
              cursor: "pointer",
              fontSize: 22,
              lineHeight: 1,
              padding: 4,
              opacity: 0.9,
            }}
          >
            ×
          </button>
        )}
      </div>

      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 16px",
          background: "#fbfbfd",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {messages.map((m) => (
          <div key={m.id}>
            <div className={`lswc-row lswc-row-${m.role}`}>
              <div className={`lswc-bubble lswc-bubble-${m.role}`}>{m.text}</div>
            </div>
            {m.role === "assistant" && m.formFields && (
              <InlineCaptureForm
                fields={m.formFields}
                accentColor={accentColor}
                onSubmit={(payload) => handleCaptureFormDone(m.id, payload)}
                onSkip={() => handleCaptureFormDone(m.id, { skip: true })}
              />
            )}
            {m.role === "assistant" && m.slots && !voiceActive && (
              <div
                role="group"
                aria-label="Available times"
                style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}
              >
                {m.slots.map((s) => (
                  <button
                    key={s.startIso}
                    type="button"
                    disabled={sending}
                    onClick={() => void sendMessage(s.label, s.startIso)}
                    style={{
                      background: "white",
                      color: accentInk,
                      border: `1px solid ${accentInk}`,
                      borderRadius: 999,
                      padding: "6px 12px",
                      fontSize: 13,
                      cursor: sending ? "not-allowed" : "pointer",
                      opacity: sending ? 0.5 : 1,
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {sending && (
          <div className="lswc-row lswc-row-assistant">
            <div
              className="lswc-bubble lswc-bubble-assistant"
              aria-label="Assistant is typing"
            >
              <span className="lswc-typing-dot" />
              <span className="lswc-typing-dot" />
              <span className="lswc-typing-dot" />
            </div>
          </div>
        )}
        {handoffNote && !sending && (
          <div
            style={{
              textAlign: "center",
              fontSize: 11,
              color: "#94a3b8",
              margin: "10px 4px 4px",
            }}
            role="status"
          >
            {handoffNote}
          </div>
        )}
      </div>

      {/* Times offered during a call; tapping one tells the agent by text. */}
      {voiceActive && voiceOffer && (
        <div
          role="group"
          aria-label="Available times"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: "8px 12px",
            borderTop: "1px solid #e2e8f0",
            background: "white",
            flexShrink: 0,
          }}
        >
          {voiceOffer.slots.map((s) => (
            <button
              key={s.startIso}
              type="button"
              onClick={() => pickVoiceSlot(voiceOffer.key, s)}
              style={{
                background: "white",
                color: accentInk,
                border: `1px solid ${accentInk}`,
                borderRadius: 999,
                padding: "6px 12px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Voice status bar, only during a live call */}
      {voiceActive && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          <span className="lswc-voice-dot" aria-hidden />
          <span style={{ flex: 1, color: "#334155" }}>
            {voiceStatus === "connecting"
              ? "Connecting…"
              : voiceStatus === "speaking"
                ? "Speaking…"
                : "Listening — go ahead and talk"}
          </span>
          {voiceStatus !== "connecting" && (
            <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
              {formatClock(voiceElapsed)}
              {voiceMaxSeconds > 0 ? ` / ${formatClock(voiceMaxSeconds)}` : ""}
            </span>
          )}
          <button
            type="button"
            onClick={() => void stopVoice()}
            aria-label="End voice chat"
            style={{
              background: "#ef4444",
              color: "white",
              border: 0,
              borderRadius: 8,
              padding: "5px 10px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            End
          </button>
        </div>
      )}
      {voiceNote && !voiceActive && (
        <div
          role="status"
          style={{
            fontSize: 11,
            color: "#64748b",
            padding: "6px 12px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            flexShrink: 0,
          }}
        >
          {voiceNote}
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 12px",
          borderTop: "1px solid #e2e8f0",
          background: "white",
          flexShrink: 0,
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            voiceActive
              ? "Voice chat in progress…"
              : sending
                ? "Waiting for reply…"
                : "Type a message…"
          }
          disabled={sending || !sessionId || voiceActive}
          aria-label="Type a message"
          style={{
            flex: 1,
            padding: "10px 12px",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            outline: "none",
            fontSize: 14,
            background: "white",
            color: "#0f172a",
          }}
        />
        {voiceToken && !voiceActive && (
          <button
            type="button"
            onClick={() => void startVoice()}
            disabled={sending || !sessionId}
            aria-label="Talk to us (voice)"
            title="Talk instead of typing"
            style={{
              background: "white",
              color: accentInk,
              border: `1px solid ${accentInk}`,
              borderRadius: 10,
              padding: "0 10px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: sending ? "not-allowed" : "pointer",
              opacity: sending ? 0.5 : 1,
            }}
          >
            <MicIcon />
          </button>
        )}
        <button
          type="submit"
          disabled={sending || !input.trim() || !sessionId || voiceActive}
          aria-label="Send"
          style={{
            background: accentColor,
            color: onAccent,
            border: 0,
            borderRadius: 10,
            padding: "0 16px",
            fontSize: 16,
            cursor: sending || !input.trim() ? "not-allowed" : "pointer",
            opacity: sending || !input.trim() ? 0.5 : 1,
          }}
        >
          ↑
        </button>
      </form>

      {errored && (
        <div
          style={{
            background: "#fef2f2",
            color: "#b91c1c",
            fontSize: 11,
            padding: "4px 12px",
            textAlign: "center",
          }}
          role="status"
        >
          Connection issue — your message may not have been delivered.
        </div>
      )}
    </div>
  );
}

/** Capture form under a bot reply when the LLM emitted a [[form fields="..."]] marker. Posts to /api/web-chat/capture. */
function InlineCaptureForm(props: {
  fields: CaptureFieldId[];
  accentColor: string;
  onSubmit: (payload: { name?: string; email?: string; phone?: string }) => void;
  onSkip: () => void;
}) {
  const { fields, accentColor, onSubmit, onSkip } = props;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const labelFor: Record<CaptureFieldId, string> = {
    name: "Your name",
    email: "Email address",
    phone: "Phone number",
  };
  const placeholderFor: Record<CaptureFieldId, string> = {
    name: "Jane Smith",
    email: "jane@example.com",
    phone: "+61 400 000 000",
  };
  const typeFor: Record<CaptureFieldId, string> = {
    name: "text",
    email: "email",
    phone: "tel",
  };
  const valueFor: Record<CaptureFieldId, string> = {
    name,
    email,
    phone,
  };
  const setterFor: Record<CaptureFieldId, (v: string) => void> = {
    name: setName,
    email: setEmail,
    phone: setPhone,
  };

  // Server needs email or phone; name alone isn't enough to follow up.
  const canSubmit =
    !submitting &&
    (!fields.includes("email") || email.trim().length > 0
      ? true
      : false) &&
    (!fields.includes("phone") || phone.trim().length > 0 ? true : false) &&
    (email.trim().length > 0 || phone.trim().length > 0);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    onSubmit({
      name: name.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        marginTop: 8,
        marginLeft: 0,
        marginRight: 0,
        padding: 14,
        background: "white",
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {fields.map((f) => (
        <label
          key={f}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
            {labelFor[f]}
          </span>
          <input
            type={typeFor[f]}
            value={valueFor[f]}
            onChange={(e) => setterFor[f](e.target.value)}
            placeholder={placeholderFor[f]}
            disabled={submitting}
            required={f === "email" || f === "phone"}
            style={{
              padding: "8px 10px",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              fontSize: 14,
              outline: "none",
              background: "white",
              color: "#0f172a",
            }}
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            flex: 1,
            background: accentColor,
            color: textOnAccent(accentColor),
            border: 0,
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 13,
            fontWeight: 600,
            cursor: canSubmit ? "pointer" : "not-allowed",
            opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {submitting ? "Sending…" : "Send details"}
        </button>
        <button
          type="button"
          onClick={() => {
            setSubmitting(true);
            onSkip();
          }}
          disabled={submitting}
          style={{
            background: "transparent",
            color: "#64748b",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 13,
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          Skip
        </button>
      </div>
    </form>
  );
}
