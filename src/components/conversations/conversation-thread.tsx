"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import { CheckCheck, Mic } from "lucide-react";
import { getFirebaseDb } from "@/lib/firebase/client";
import { normalizeSubject, splitQuotedReply } from "@/lib/email-quote";
import { toDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MessageDoc } from "@/types/messages";
import type { ConversationChannel } from "@/types/conversations";
import type { ConversationTheme } from "@/hooks/use-conversation-theme";

type ChannelMessage = MessageDoc & {
  channel: ConversationChannel;
  /** Email only: bold headline above the body. */
  subject?: string;
  /** Email only: set when the subject differs from the previous email's (ignoring Re:/Fwd:), so it isn't repeated on every bubble. */
  showSubject?: boolean;
  /** Web chat only: "voice" when spoken via Web Voice. */
  via?: "voice";
};

const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  "web-chat": "Web Chat",
  email: "Email",
};

const CHANNEL_CHIP: Record<ConversationChannel, string> = {
  sms: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  whatsapp: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  messenger: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  instagram: "bg-pink-500/10 text-pink-700 dark:text-pink-400",
  "web-chat": "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  email: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

type MetaMessageDoc = MessageDoc & { channel?: ConversationChannel };

type EmailMessageRow = MessageDoc & { subject?: string };

/**
 * Merged timeline. For contact channels it subscribes to messages,
 * whatsappMessages and metaMessages and merges them at read time (nothing is
 * moved). With sessionId it reads that web chat session's messages instead.
 */
export function ConversationThread({
  contactId,
  sessionId = null,
  subAccountId,
  theme = "standard",
}: {
  contactId: string;
  /** Web chat only. */
  sessionId?: string | null;
  /** Needed with sessionId to find the session doc. */
  subAccountId?: string;
  theme?: ConversationTheme;
}) {
  const [sms, setSms] = useState<MessageDoc[]>([]);
  const [wa, setWa] = useState<MessageDoc[]>([]);
  const [meta, setMeta] = useState<MetaMessageDoc[]>([]);
  const [emailMsgs, setEmailMsgs] = useState<EmailMessageRow[]>([]);
  const [web, setWeb] = useState<MessageDoc[]>([]);
  const [smsReady, setSmsReady] = useState(false);
  const [waReady, setWaReady] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const [emailReady, setEmailReady] = useState(false);
  const [webReady, setWebReady] = useState(false);
  const isWebChat = !!sessionId && !!subAccountId;
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const db = getFirebaseDb();

    // Web chat: one source under the session, no contact listeners.
    if (isWebChat) {
      const unsubWeb = onSnapshot(
        query(
          collection(
            db,
            `subAccounts/${subAccountId}/webChatSessions/${sessionId}/messages`,
          ),
          orderBy("createdAt", "asc"),
        ),
        (snap) => {
          setWeb(
            snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MessageDoc),
          );
          setWebReady(true);
        },
        () => setWebReady(true),
      );
      return () => unsubWeb();
    }

    if (!contactId) return;
    const unsubSms = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/messages`),
        orderBy("createdAt", "asc"),
      ),
      (snap) => {
        setSms(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MessageDoc));
        setSmsReady(true);
      },
      () => setSmsReady(true),
    );
    const unsubWa = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/whatsappMessages`),
        orderBy("createdAt", "asc"),
      ),
      (snap) => {
        setWa(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MessageDoc));
        setWaReady(true);
      },
      () => setWaReady(true),
    );
    const unsubMeta = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/metaMessages`),
        orderBy("createdAt", "asc"),
      ),
      (snap) => {
        setMeta(
          snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MetaMessageDoc),
        );
        setMetaReady(true);
      },
      () => setMetaReady(true),
    );
    const unsubEmail = onSnapshot(
      query(
        collection(db, `contacts/${contactId}/emailMessages`),
        orderBy("createdAt", "asc"),
      ),
      (snap) => {
        setEmailMsgs(
          snap.docs.map((d) => ({ id: d.id, ...d.data() }) as EmailMessageRow),
        );
        setEmailReady(true);
      },
      () => setEmailReady(true),
    );
    return () => {
      unsubSms();
      unsubWa();
      unsubMeta();
      unsubEmail();
    };
  }, [contactId, isWebChat, sessionId, subAccountId]);

  const merged = useMemo<ChannelMessage[]>(() => {
    if (isWebChat) {
      return web
        .map((m) => ({ ...m, channel: "web-chat" as const }))
        .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
    }
    const all: ChannelMessage[] = [
      ...sms.map((m) => ({ ...m, channel: "sms" as const })),
      ...wa.map((m) => ({ ...m, channel: "whatsapp" as const })),
      ...meta.map((m) => ({
        ...m,
        channel: (m.channel ?? "messenger") as ConversationChannel,
      })),
      ...emailMsgs.map((m) => ({ ...m, channel: "email" as const })),
    ];
    all.sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
    // Headline only when the topic changes.
    let lastSubjectKey: string | null = null;
    for (const m of all) {
      if (m.channel !== "email") continue;
      const key = normalizeSubject(m.subject ?? "");
      m.showSubject = !!m.subject && key !== lastSubjectKey;
      lastSubjectKey = key;
    }
    return all;
  }, [sms, wa, meta, emailMsgs, web, isWebChat]);

  const hydrated = isWebChat
    ? webReady
    : smsReady && waReady && metaReady && emailReady;

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [merged.length]);

  return (
    <div
      ref={scrollerRef}
      className="flex-1 space-y-2 overflow-y-auto p-4"
    >
      {!hydrated ? (
        <div className="space-y-2">
          <div className="h-12 w-2/3 animate-pulse rounded-lg bg-muted" />
          <div className="ml-auto h-12 w-3/4 animate-pulse rounded-lg bg-muted" />
        </div>
      ) : merged.length === 0 ? (
        <div className="flex h-full min-h-[150px] items-center justify-center text-center">
          <p className="text-xs text-muted-foreground">
            No messages yet. Reply below to start the conversation.
          </p>
        </div>
      ) : (
        merged.map((m) => (
          <ChannelBubble key={`${m.channel}:${m.id}`} message={m} theme={theme} />
        ))
      )}
    </div>
  );
}

function bubbleClasses(
  channel: ConversationChannel,
  isOutbound: boolean,
  theme: ConversationTheme,
): string {
  if (theme === "native") {
    if (channel === "whatsapp") {
      return isOutbound
        ? "rounded-br-sm bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-white"
        : "rounded-bl-sm bg-white text-[#111b21] ring-1 ring-black/5 dark:bg-[#202c33] dark:text-[#e9edef] dark:ring-0";
    }
    if (channel === "messenger") {
      // Messenger: blue outbound
      return isOutbound
        ? "rounded-br-sm bg-[#0084ff] text-white"
        : "rounded-bl-sm bg-[#e9e9eb] text-black dark:bg-[#3b3b3d] dark:text-white";
    }
    if (channel === "instagram") {
      // Instagram: purple gradient outbound
      return isOutbound
        ? "rounded-br-sm bg-gradient-to-br from-[#a033ff] via-[#ff5280] to-[#ff7061] text-white"
        : "rounded-bl-sm bg-[#efefef] text-black dark:bg-[#3b3b3d] dark:text-white";
    }
    if (channel === "web-chat") {
      // Web chat: sky outbound
      return isOutbound
        ? "rounded-br-sm bg-sky-500 text-white"
        : "rounded-bl-sm bg-[#e9e9eb] text-black dark:bg-[#3b3b3d] dark:text-white";
    }
    if (channel === "email") {
      // Email: parchment card
      return isOutbound
        ? "rounded-br-sm bg-amber-600 text-white"
        : "rounded-bl-sm bg-amber-50 text-black ring-1 ring-amber-500/20 dark:bg-[#3b3325] dark:text-amber-50 dark:ring-0";
    }
    // SMS: iMessage palette
    return isOutbound
      ? "rounded-br-sm bg-[#007aff] text-white"
      : "rounded-bl-sm bg-[#e9e9eb] text-black dark:bg-[#3b3b3d] dark:text-white";
  }
  return isOutbound
    ? "rounded-br-sm bg-primary text-primary-foreground"
    : "rounded-bl-sm bg-muted";
}

function ChannelBubble({
  message,
  theme,
}: {
  message: ChannelMessage;
  theme: ConversationTheme;
}) {
  const isOutbound = message.direction === "outbound";
  const ts = toDate(message.createdAt);
  const native = theme === "native";
  const channelLabel = CHANNEL_LABEL[message.channel] ?? message.channel;
  // Native theme: colour shows the channel, so no text chip. WhatsApp outbound
  // gets the double tick (cosmetic only).
  const showTicks =
    native && isOutbound && message.channel === "whatsapp" &&
    message.status !== "failed";

  return (
    <div className={cn("flex flex-col", isOutbound ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[78%] rounded-2xl px-3 py-2 text-sm",
          bubbleClasses(message.channel, isOutbound, theme),
          message.status === "failed" && "ring-2 ring-destructive",
        )}
      >
        {message.channel === "email" && message.subject && message.showSubject ? (
          <p className="mb-1 text-xs font-semibold opacity-80">
            {message.subject}
          </p>
        ) : null}
        {message.channel === "email" ? (
          <EmailBody body={message.body} />
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {!native && (
          <span
            className={cn(
              "rounded-full px-1.5 font-medium",
              CHANNEL_CHIP[message.channel] ?? CHANNEL_CHIP.sms,
            )}
          >
            {channelLabel}
          </span>
        )}
        <span>
          {ts
            ? ts.toLocaleString(undefined, {
                hour: "numeric",
                minute: "2-digit",
                month: "short",
                day: "numeric",
              })
            : ""}
        </span>
        {message.via === "voice" && (
          <span
            className="inline-flex items-center gap-0.5 text-indigo-600 dark:text-indigo-400"
            aria-label="Spoken (voice)"
            title="Spoken through Web Voice"
          >
            <Mic className="h-3 w-3" />
            voice
          </span>
        )}
        {showTicks && (
          <CheckCheck
            className="h-3 w-3 text-sky-500"
            aria-label="delivered"
          />
        )}
        {message.status === "failed" && (
          <span className="text-destructive">· failed</span>
        )}
      </div>
    </div>
  );
}

/** Shows the new text with quoted history collapsed (display only). Full body if nothing was detected. */
function EmailBody({ body }: { body: string }) {
  const { visible, quoted } = useMemo(() => splitQuotedReply(body), [body]);
  const [showQuoted, setShowQuoted] = useState(false);
  return (
    <div>
      <p className="whitespace-pre-wrap break-words">{visible}</p>
      {quoted && (
        <>
          <button
            type="button"
            onClick={() => setShowQuoted((v) => !v)}
            className="mt-1.5 rounded-full bg-black/10 px-2 py-0.5 text-[10px] font-medium opacity-70 hover:opacity-100 dark:bg-white/10"
          >
            {showQuoted ? "Hide quoted text" : "··· Show quoted text"}
          </button>
          {showQuoted && (
            <p className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-current/30 pl-2 text-xs opacity-70">
              {quoted}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
