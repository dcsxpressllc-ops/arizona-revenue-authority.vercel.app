import "server-only";

/**
 * Patches console.log/info/warn/error/debug to mask the secret half of any
 * `lsk_<live|test>_*` key before the line is written (prefix kept, secret -> ***).
 *
 * Global rather than opt-in because one stray `console.log(req.headers)` would
 * put a key into Vercel's log retention and any downstream log shipper.
 *
 * Called once from instrumentation.ts at cold start; calling again is a no-op.
 */

const SECRET_RE = /lsk_(live|test)_([0-9A-HJKMNP-TV-Z]{8})_[0-9A-HJKMNP-TV-Z]{32}/g;
const REDACTED_TAG = "__leadstack_redacted_console__";

function redactString(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (!input.includes("lsk_")) return input;
  return input.replace(SECRET_RE, (_match, mode, prefix) => {
    return `lsk_${mode}_${prefix}_***`;
  });
}

function redactArg(arg: unknown): unknown {
  if (typeof arg === "string") return redactString(arg);
  // Stack traces and messages can contain keys too.
  if (arg instanceof Error) {
    const cloned = new Error(redactString(arg.message) as string);
    cloned.name = arg.name;
    if (arg.stack) cloned.stack = redactString(arg.stack) as string;
    return cloned;
  }
  // Shallow walk only. Deep-walking every logged object is too expensive, and
  // leaks in practice come from string concat or header dumps.
  if (arg && typeof arg === "object") {
    let touched = false;
    if (Array.isArray(arg)) {
      const out: unknown[] = [];
      for (const v of arg) {
        const redacted = typeof v === "string" ? redactString(v) : v;
        if (redacted !== v) touched = true;
        out.push(redacted);
      }
      return touched ? out : arg;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
      const redacted = typeof v === "string" ? redactString(v) : v;
      if (redacted !== v) touched = true;
      out[k] = redacted;
    }
    return touched ? out : arg;
  }
  return arg;
}

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

export function installLogRedaction(): void {
  const c = console as unknown as Record<string, unknown> & {
    [REDACTED_TAG]?: boolean;
  };
  if (c[REDACTED_TAG]) return;
  c[REDACTED_TAG] = true;

  for (const m of METHODS) {
    // Go through `c` (already cast via unknown): tsc won't cast Console straight to a Record.
    const original = c[m] as (...a: unknown[]) => void;
    if (typeof original !== "function") continue;
    c[m] = (...args: unknown[]) => {
      original(...args.map(redactArg));
    };
  }
}
