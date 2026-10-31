/**
 * Web Audio notification sounds for the live-visitors map, so there are no
 * audio files to ship. playDing() fires on "buy-clicked", playKaching() on
 * "purchased".
 *
 * Autoplay needs a prior user gesture; the mute toggle click counts. If playback
 * is still blocked we swallow the error, since sounds are optional.
 */

let cachedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (cachedCtx) return cachedCtx;
  type WindowWithWebkit = Window &
    typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    };
  const win = window as WindowWithWebkit;
  const Ctor = window.AudioContext ?? win.webkitAudioContext;
  if (!Ctor) return null;
  try {
    cachedCtx = new Ctor();
    return cachedCtx;
  } catch {
    return null;
  }
}

/** Single bell tone, ~0.4s. */
export function playDing(): void {
  const ctx = getCtx();
  if (!ctx) return;
  // Some browsers keep the context suspended until a gesture.
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.25;
  master.connect(ctx.destination);

  // C#6 (1108Hz) fundamental; the quiet partial below adds the bell shimmer.
  voiceTone({ ctx, dest: master, frequency: 1108, startAt: now, duration: 0.4 });
  voiceTone({ ctx, dest: master, frequency: 2217, startAt: now, duration: 0.35, gain: 0.12 });
}

/** Two short bright tones ~120ms apart, with a noise click on the first. */
export function playKaching(): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;
  const master = ctx.createGain();
  // Slightly louder than ding; purchases matter more.
  master.gain.value = 0.32;
  master.connect(ctx.destination);

  // Perfect fourth: D6 then G6.
  voiceTone({ ctx, dest: master, frequency: 1175, startAt: now, duration: 0.18 });
  voiceTone({ ctx, dest: master, frequency: 1568, startAt: now + 0.12, duration: 0.32 });
  // Bandpassed noise burst for the mechanical strike.
  noiseClick({ ctx, dest: master, startAt: now, duration: 0.04 });
}

interface ToneParams {
  ctx: AudioContext;
  dest: AudioNode;
  frequency: number;
  startAt: number;
  duration: number;
  /** Multiplier on top of the master gain. Default 1. */
  gain?: number;
}

function voiceTone({ ctx, dest, frequency, startAt, duration, gain = 1 }: ToneParams) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = frequency;
  const env = ctx.createGain();
  // 5ms attack, exponential decay. A linear ramp can clip and sounds less bell-like.
  env.gain.setValueAtTime(0.0001, startAt);
  env.gain.exponentialRampToValueAtTime(gain, startAt + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(env).connect(dest);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

function noiseClick({
  ctx,
  dest,
  startAt,
  duration,
}: {
  ctx: AudioContext;
  dest: AudioNode;
  startAt: number;
  duration: number;
}) {
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;

  // Bandpass around 4kHz so it's a tick, not hiss.
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 4000;
  bp.Q.value = 1.8;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, startAt);
  env.gain.exponentialRampToValueAtTime(0.3, startAt + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  noise.connect(bp).connect(env).connect(dest);
  noise.start(startAt);
  noise.stop(startAt + duration + 0.02);
}
