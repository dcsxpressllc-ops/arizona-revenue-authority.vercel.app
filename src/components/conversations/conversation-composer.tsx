"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { GoogleGIcon } from "@/components/brand/google-g-icon";
import { cn } from "@/lib/utils";
import { DEFAULT_REVIEW_SMS_TEMPLATE } from "@/lib/reviews/constants";
import type { Contact } from "@/types/contacts";
import type { ConversationChannel } from "@/types/conversations";

const LABEL: Record<ConversationChannel, string> = {
  sms: "SMS",
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  "web-chat": "Web Chat",
  email: "Email",
};

/**
 * Channel-aware reply box using the existing send routes; ConversationThread's
 * listener shows the new row. Defaults to the contact's last-used channel.
 */
export function ConversationComposer({
  contact,
  availableChannels,
  defaultChannel,
}: {
  contact: Contact;
  availableChannels: ConversationChannel[];
  defaultChannel: ConversationChannel;
}) {
  const { subAccount } = useSubAccount();
  const initial = availableChannels.includes(defaultChannel)
    ? defaultChannel
    : (availableChannels[0] ?? "sms");
  const [channel, setChannel] = useState<ConversationChannel>(initial);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  // "Ask for review" inserts the review message as free text so it can be edited.
  // On WhatsApp no template is needed because the customer's recent inbound keeps
  // the 24h window open (the route 409s if it closed).
  const reviewCfg = subAccount?.googleReviewConfig ?? null;
  const reviewConfigured = !!reviewCfg?.reviewUrl;

  function insertReviewMessage() {
    if (!reviewCfg?.reviewUrl) return;
    const firstName = (contact.name ?? "").trim().split(/\s+/)[0] ?? "";
    const msg = (reviewCfg.messageTemplate || DEFAULT_REVIEW_SMS_TEMPLATE)
      .replace(/\{\{\s*firstName\s*\}\}/g, firstName)
      .replace(/\{\{\s*businessName\s*\}\}/g, subAccount?.name ?? "")
      .replace(/\{\{\s*reviewUrl\s*\}\}/g, reviewCfg.reviewUrl);
    // Keep anything already typed.
    setBody((prev) => (prev.trim() ? `${prev.trim()} ${msg}` : msg));
  }

  if (availableChannels.length === 0) {
    return (
      <div className="border-t px-4 py-3 text-xs text-muted-foreground">
        No messaging channel is configured for this sub-account. Set up a
        dedicated Twilio number (Settings → SMS) to reply here.
      </div>
    );
  }

  // Messenger/Instagram replies use their own route, address by metaUserId and
  // have no STOP opt-out. Email sends no subject; the route derives
  // "Re: <last inbound subject>".
  const isMeta = channel === "messenger" || channel === "instagram";
  const isEmail = channel === "email";
  const optedOut = isMeta
    ? false
    : isEmail
      ? !!contact.emailOptedOut
      : channel === "sms"
        ? !!contact.smsOptedOut
        : !!contact.whatsappOptedOut;
  const endpoint = isMeta
    ? "/api/comms/meta/send"
    : isEmail
      ? "/api/comms/email/send"
      : channel === "sms"
        ? "/api/comms/sms/send"
        : "/api/comms/whatsapp/send";
  const hasIdentity = isMeta
    ? !!contact.metaUserId
    : isEmail
      ? !!contact.email
      : !!contact.phone;
  const disabled = optedOut || sending || !hasIdentity;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!hasIdentity) {
      toast.error(
        isMeta
          ? "This contact hasn't messaged via Facebook/Instagram."
          : isEmail
            ? "This contact has no email address."
            : "This contact has no phone number.",
      );
      return;
    }
    if (optedOut) {
      toast.error(`This contact opted out of ${LABEL[channel]}.`);
      return;
    }
    setSending(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          body: trimmed,
          ...(isMeta ? { channel } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't send.");
      }
      setBody("");
      // The snapshot listener appends the row.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t px-4 py-3">
      {availableChannels.length > 1 && (
        <div className="mb-2 flex gap-1">
          {availableChannels.map((ch) => (
            <button
              key={ch}
              type="button"
              onClick={() => setChannel(ch)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                channel === ch
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {LABEL[ch]}
            </button>
          ))}
        </div>
      )}
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          optedOut
            ? `Contact opted out of ${LABEL[channel]}`
            : `Reply via ${LABEL[channel]} to ${
                (isMeta
                  ? contact.name
                  : isEmail
                    ? contact.email
                    : contact.phone) || "this contact"
              }…`
        }
        rows={2}
        disabled={disabled}
        className="min-h-[60px] resize-none px-3 py-2 text-sm"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        {reviewConfigured ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={insertReviewMessage}
            disabled={sending}
            title="Insert a Google review request into the reply"
          >
            <GoogleGIcon className="mr-1 h-3.5 w-3.5" />
            Ask for review
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="submit"
          size="sm"
          disabled={!body.trim() || disabled}
        >
          {sending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="mr-1 h-3.5 w-3.5" />
          )}
          Send via {LABEL[channel]}
        </Button>
      </div>
    </form>
  );
}
