/** Email display helpers for the conversation thread. Pure; they only shape the bubble, never the stored message. */

/** Strips stacked Re:/Fwd:, collapses whitespace, lowercases ("RE: RE: yo2" -> "yo2"), so the headline only re-shows on a real topic change. */
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const stripped = s.replace(/^(re|fwd?|aw|sv)\s*:\s*/i, "");
    if (stripped === s) break;
    s = stripped;
  }
  return s.replace(/\s+/g, " ").toLowerCase();
}

/**
 * Splits a plain-text body into the new part and the quoted history below it.
 * Handles ">" lines, Gmail's "On <date>, <sender> wrote:" (possibly wrapped),
 * and Outlook separators ("-----Original Message-----", underscore rules,
 * From:/Sent: header blocks). If everything would be trimmed (reply written
 * inside the quote, misfire), the full body is kept.
 */
export function splitQuotedReply(text: string): {
  visible: string;
  quoted: string | null;
} {
  const whole = { visible: text, quoted: null };
  const lines = text.split(/\r?\n/);

  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(">")) {
      cut = i;
      break;
    }
    if (
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      /^_{6,}$/.test(line) ||
      (/^From:\s?.+/.test(line) &&
        /^(Sent|Date):\s?.+/.test(lines[i + 1]?.trim() ?? ""))
    ) {
      cut = i;
      break;
    }
    // Single-line Gmail attribution with nothing after it yet.
    if (/^On .{3,120} wrote:$/.test(line) && i > 0) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return whole;

  // Absorb a wrapped attribution paragraph just above the quote if it starts
  // "On ..." and/or ends "wrote:".
  let start = cut;
  let end = cut - 1;
  while (end >= 0 && lines[end].trim() === "") end--;
  if (end >= 0) {
    let top = end;
    while (top - 1 >= 0 && lines[top - 1].trim() !== "") top--;
    const block = lines.slice(top, end + 1).map((l) => l.trim());
    const isAttribution =
      block.length <= 4 &&
      (/wrote:\s*$/.test(block[block.length - 1]) || /^On\b/.test(block[0]));
    if (isAttribution) start = top;
  }

  const visible = lines.slice(0, start).join("\n").trimEnd();
  const quoted = lines.slice(start).join("\n").trim();
  if (!visible) return whole;
  return { visible, quoted: quoted || null };
}
