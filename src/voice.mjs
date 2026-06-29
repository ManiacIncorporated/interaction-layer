// Spoken output via macOS `say`, serialized through a queue so lines don't
// overlap. Low-priority narration can be flushed when something important
// (an answer to a question) needs to speak now.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Low-latency streaming player binary (compiled from bin/audio-stream.swift).
const PLAYER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "audio-stream");

// ElevenLabs cloud TTS (natural voice). Fetches mp3 for one line; aborts via
// signal so barge-in can cancel an in-flight request. Throws on any failure so
// the caller can fall back to `say`.
let _ttsSeq = 0;
async function elevenFetch(text, signal) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  const voice = process.env.IL_ELEVEN_VOICE || "21m00Tcm4TlvDq8ikWAM"; // Rachel
  const model = process.env.IL_ELEVEN_MODEL || "eleven_flash_v2_5"; // fast + cheap
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: model }),
      signal,
    }
  );
  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const file = path.join(os.tmpdir(), `il-tts-${process.pid}-${_ttsSeq++ % 4}.mp3`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// Cartesia (Sonic) — fetch the full WAV and play the complete file with afplay.
// (Streaming raw into sox was unreliable: sox treated the slow pipe as ended and
// cut the clip off mid-sentence.)
async function cartesiaFetch(text, signal) {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error("CARTESIA_API_KEY not set");
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Cartesia-Version": "2025-04-16",
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      transcript: text,
      model_id: process.env.IL_CARTESIA_MODEL || "sonic-2",
      voice: { mode: "id", id: process.env.IL_CARTESIA_VOICE || "694f9389-aac1-45b6-b726-9d9369183238" },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 44100 },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`cartesia ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const file = path.join(os.tmpdir(), `il-tts-${process.pid}-${_ttsSeq++ % 4}.raw`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// Cartesia SSE: yield raw PCM chunks via onChunk as they synthesize, for the
// streaming player (first audio in ~0.3-0.4s instead of waiting for full synth).
async function cartesiaStream(text, signal, onChunk) {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error("CARTESIA_API_KEY not set");
  const res = await fetch("https://api.cartesia.ai/tts/sse", {
    method: "POST",
    headers: { "Cartesia-Version": "2025-04-16", authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      transcript: text,
      model_id: process.env.IL_CARTESIA_MODEL || "sonic-2",
      voice: { mode: "id", id: process.env.IL_CARTESIA_VOICE || "694f9389-aac1-45b6-b726-9d9369183238" },
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 44100 },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`cartesia ${res.status}: ${(await res.text()).slice(0, 120)}`);
  let buf = "";
  for await (const part of res.body) {
    if (signal.aborted) return;
    buf += Buffer.from(part).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
      buf = buf.slice(i + 2);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (o.type === "chunk" && o.data) onChunk(Buffer.from(o.data, "base64"));
    }
  }
}

// Pick the nicest installed voice: a downloaded Premium/Enhanced English voice if
// present, else fall back to Samantha. Override with IL_VOICE="Ava (Premium)".
function listVoices() {
  try {
    const out = spawnSync("say", ["-v", "?"], { encoding: "utf8" }).stdout || "";
    return out
      .split("\n")
      .map((l) => l.match(/^(.*?)\s{2,}([a-z]{2}_[A-Z]{2})/))
      .filter(Boolean)
      .map((m) => ({ name: m[1].trim(), locale: m[2] }));
  } catch {
    return [];
  }
}
export function bestVoice() {
  if (process.env.IL_VOICE) return process.env.IL_VOICE;
  const en = listVoices().filter((v) => v.locale.startsWith("en"));
  const premium = en.find((v) => /\(Premium\)/i.test(v.name));
  const enhanced = en.find((v) => /\(Enhanced\)/i.test(v.name));
  return (premium || enhanced)?.name || "Samantha";
}

// Strip markdown/code noise so `say` doesn't read "asterisk asterisk" etc.
function speakable(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*\*|__|[*_#>]/g, "") // emphasis / headings / quotes
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links -> text
    .replace(/^\s*[-•]\s+/gm, "") // list bullets
    .replace(/^\s*\d+\.\s+/gm, "") // numbered list markers
    .replace(/\s+/g, " ")
    .trim();
}

export class Voice {
  constructor({ voice, rate, enabled = true, onSpeaking } = {}) {
    this.voice = voice || bestVoice();
    // Playback speed multiplier (IL_SPEED). Applies to cloud TTS via `afplay -r`
    // and to `say` via words-per-minute. Default a touch brisk.
    this.speed = Number(process.env.IL_SPEED) || 1.3;
    this.rate = rate || Number(process.env.IL_RATE) || Math.round(175 * this.speed);
    this.enabled = enabled;
    this.onSpeaking = onSpeaking; // (isSpeaking: boolean) => void
    this.queue = [];
    this.current = null;
    // Engine: "cartesia" / "eleven" (cloud, natural) or "say" (macOS, local).
    this.engine =
      process.env.IL_TTS ||
      (process.env.CARTESIA_API_KEY
        ? "cartesia"
        : process.env.ELEVENLABS_API_KEY
        ? "eleven"
        : "say");
  }

  // Human-readable description of the active voice, for the banner.
  describe() {
    if (this.engine === "cartesia") return `Cartesia · ${process.env.IL_CARTESIA_MODEL || "sonic-2"}`;
    if (this.engine === "eleven") return `ElevenLabs (${process.env.IL_ELEVEN_VOICE || "Rachel"})`;
    return `say · ${this.voice}`;
  }

  isSpeaking() {
    return !!this.current?.proc;
  }

  _setSpeaking(v) {
    this.onSpeaking?.(v);
  }

  _next() {
    if (this.current || !this.queue.length) return;
    const item = (this.current = this.queue.shift());
    const clean = speakable(item.text);
    if (!this.enabled || !clean) {
      this.current = null;
      return this._next();
    }
    this._setSpeaking(true);
    const done = () => {
      if (this.current !== item) return; // superseded by flush()
      this.current = null;
      if (!this.queue.length) this._setSpeaking(false);
      this._next();
    };
    if (this.engine === "cartesia" && fs.existsSync(PLAYER)) this._playStream(clean, item, done);
    else if (this.engine === "cartesia") this._playCloud(clean, item, done, cartesiaFetch);
    else if (this.engine === "eleven") this._playCloud(clean, item, done, elevenFetch);
    else this._playSay(clean, item, done);
  }

  // Stream Cartesia audio into the CoreAudio player as it synthesizes — lowest
  // time-to-first-audio. Barge-in (flush) aborts the SSE and kills the player.
  _playStream(text, item, done) {
    const ac = new AbortController();
    item.abort = ac;
    let finished = false;
    let dead = false;
    let wrote = false;
    const player = spawn(PLAYER, [], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, IL_SPEED: String(this.speed) },
    });
    item.proc = player;
    const finish = () => {
      if (finished) return;
      finished = true;
      dead = true;
      ac.abort();
      done();
    };
    player.stdin.on("error", () => {}); // swallow EPIPE if killed mid-write
    player.on("exit", () => { dead = true; finish(); });
    player.on("error", () => { dead = true; finish(); }); // spawn failed
    cartesiaStream(text, ac.signal, (pcm) => {
      if (dead || ac.signal.aborted || this.current !== item) return;
      if (player.stdin.writable) {
        try { player.stdin.write(pcm); wrote = true; } catch {}
      }
    })
      .then(() => {
        if (!dead && player.stdin.writable) {
          try { player.stdin.end(); } catch {} // player drains then exits → finish()
        }
      })
      .catch((e) => {
        if (ac.signal.aborted || dead) return finish();
        try { player.kill(); } catch {}
        if (!wrote) {
          if (!this._ttsWarned) {
            this._ttsWarned = true;
            console.error(`   ⚠️  Cartesia stream failed (${e.message}); using local voice`);
          }
          this._playSay(text, item, done); // nothing played → fall back
        } else {
          finish();
        }
      });
  }

  _playSay(text, item, done) {
    const p = spawn("say", ["-v", this.voice, "-r", String(this.rate), text]);
    item.proc = p;
    p.on("exit", done);
    p.on("error", done);
  }

  // Fetch audio from a cloud TTS then play the complete file. On any failure,
  // fall back to `say` so we're never silent. AbortController lets barge-in cancel
  // the in-flight fetch. Raw PCM (.raw) plays via sox `play` (fast startup ~0.1s,
  // pitch-preserving `tempo`); other formats (mp3) via afplay.
  _playCloud(text, item, done, fetcher) {
    const ac = new AbortController();
    item.abort = ac;
    fetcher(text, ac.signal)
      .then((file) => {
        if (ac.signal.aborted || this.current !== item) return done();
        const p = file.endsWith(".raw")
          ? spawn(
              "play",
              ["-q", "-t", "raw", "-r", "44100", "-e", "signed", "-b", "16", "-c", "1",
               file, "tempo", String(this.speed)],
              { stdio: ["ignore", "ignore", "ignore"] }
            )
          : spawn("afplay", ["-q", "1", "-r", String(this.speed), file]);
        item.proc = p;
        const cleanup = () => {
          try { fs.unlinkSync(file); } catch {}
          done();
        };
        p.on("exit", cleanup);
        p.on("error", cleanup);
      })
      .catch((e) => {
        if (ac.signal.aborted) return done();
        if (!this._ttsWarned) {
          this._ttsWarned = true;
          console.error(`   ⚠️  ${this.engine} TTS failed (${e.message}); using local voice`);
        }
        this._playSay(text, item, done); // fallback
      });
  }

  isBusy() {
    return this.isSpeaking() || this.queue.length > 0;
  }

  // priority "high" = barge in (flush + front). "low" = coalescible chatter
  // (narration). "normal" (default) = queue in order, never dropped (answers).
  say(text, { priority = "normal" } = {}) {
    if (!text) return;
    if (priority === "high") {
      this.flush();
      this.queue.unshift({ text, priority });
    } else {
      if (priority === "low" && this.queue.length >= 3) this.queue.shift();
      this.queue.push({ text, priority });
    }
    this._next();
  }

  // Stop everything currently queued/speaking (barge-in).
  flush() {
    this.queue = [];
    if (this.current) {
      this.current.abort?.abort(); // cancel in-flight ElevenLabs fetch
      this.current.proc?.kill(); // stop afplay / say
      this.current = null;
    }
    this._setSpeaking(false);
  }
}
