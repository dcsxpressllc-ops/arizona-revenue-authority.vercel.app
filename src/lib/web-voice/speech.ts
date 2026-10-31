// Speech helpers for the Web Voice custom-LLM endpoint. A copy of the Vapi
// route's helpers on purpose, so the phone-voice route stays untouched.

/** Strip what sounds wrong read aloud ([[markers]], markdown, link syntax, bare
 *  URLs). The prompt forbids them, but output drifts and TTS reads every symbol. */
export function toSpeakable(text: string): string {
  return (
    text
      .replace(/\[\[[^\]]*\]\]/g, "")
      .replace(/\[\[/g, "")
      .replace(/\]\]/g, "")
      // [label](url) -> label
      .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\*\*/g, "")
      .replace(/(?<!\w)\*(?!\w)/g, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-•]\s+/gm, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim()
  );
}

/** OpenAI chat-completion SSE, as ElevenLabs' custom-LLM mode requires. The reply
 *  is already complete, so it goes out as one content chunk. */
export function sseReply(text: string, model: string): Response {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** Before ElevenLabs' first-token timeout (about 4s per attempt, network included). */
const FILLER_AFTER_MS = 3000;
const KEEPALIVE_MS = 2000;

/**
 * Like sseReply, but the stream opens at once and the reply follows when ready.
 * A booking turn (two LLM calls plus the booking) outlasts ElevenLabs' timeout,
 * which ends the call, so a slow turn speaks a short filler first and then
 * sends empty chunks until the reply lands.
 */
export function streamingSseReply(
  produce: () => Promise<string>,
  model: string,
  opts: { filler: string; fallback: string },
): Response {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const encoder = new TextEncoder();
  let closed = false;
  let fillerTimer: ReturnType<typeof setTimeout> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };
      send(chunk({ role: "assistant", content: "" }, null));

      let spokeFiller = false;
      fillerTimer = setTimeout(() => {
        spokeFiller = true;
        send(chunk({ content: `${opts.filler} ` }, null));
      }, FILLER_AFTER_MS);
      keepalive = setInterval(() => send(chunk({ content: "" }, null)), KEEPALIVE_MS);

      let text: string;
      try {
        text = (await produce()) || opts.fallback;
      } catch {
        text = opts.fallback;
      }
      clearTimeout(fillerTimer);
      clearInterval(keepalive);
      // Don't repeat the filler if the reply happens to open with it.
      if (spokeFiller && text.startsWith(opts.filler)) {
        text = text.slice(opts.filler.length).trimStart() || text;
      }
      send(chunk({ content: text }, null));
      send(chunk({}, "stop"));
      send("data: [DONE]\n\n");
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a hang-up.
        }
      }
    },
    cancel() {
      closed = true;
      clearTimeout(fillerTimer);
      clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** For callers that send `stream: false`. */
export function jsonReply(text: string, model: string): Response {
  return Response.json({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}
