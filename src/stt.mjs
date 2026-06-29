// Local speech-to-text via whisper.cpp. Takes raw PCM captured during a
// push-to-talk hold and returns the transcribed text. No API key.
//
// PERF: we run whisper.cpp in SERVER mode (whisper-server) so the model stays
// RESIDENT in RAM. Spawning `whisper-cli` fresh per utterance reloads the ~140MB
// model each time, and under the memory pressure of an active coding agent the OS
// page cache gets evicted — so every transcription went cold (~seconds). A
// resident server is immune to that (~0.1-0.3s regardless). Falls back to
// whisper-cli if the server can't start.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const MODEL =
  process.env.IL_WHISPER_MODEL ||
  path.join(os.homedir(), ".cache", "interaction-layer", "ggml-base.en.bin");
const PORT = Number(process.env.IL_WHISPER_PORT) || 8178;
const THREADS = process.env.IL_WHISPER_THREADS || "8";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bin(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return name;
  } catch {
    return null;
  }
}
function whisperBin() {
  return bin("whisper-cli") || bin("whisper-cpp");
}

// Minimal 44-byte WAV header for mono 16-bit PCM.
export function wav(pcm, rate = 16000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function clean(s) {
  return String(s)
    .replace(/\[[^\]]*\]/g, "") // stray timestamp/tag artifacts
    .replace(/\s+/g, " ")
    .trim();
}

export function sttAvailable() {
  return !!whisperBin() && fs.existsSync(MODEL);
}
export function sttProblem() {
  if (!whisperBin()) return "whisper-cli not found (brew install whisper-cpp)";
  if (!fs.existsSync(MODEL)) return `model missing at ${MODEL}`;
  return null;
}

// ---- resident server ----
let server = null;
let serverUp = false;
function ensureServer() {
  if (server || process.env.IL_WHISPER_NOSERVER) return;
  if (!bin("whisper-server") || !fs.existsSync(MODEL)) return;
  server = spawn(
    "whisper-server",
    ["-m", MODEL, "--host", "127.0.0.1", "--port", String(PORT), "-l", "en", "-t", THREADS, "-nt"],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
  server.on("exit", () => { server = null; serverUp = false; });
  server.on("error", () => { server = null; });
}

async function transcribeViaServer(pcm) {
  const fd = new FormData();
  fd.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "a.wav");
  fd.append("response_format", "text");
  fd.append("language", "en");
  fd.append("temperature", "0");
  const res = await fetch(`http://127.0.0.1:${PORT}/inference`, {
    method: "POST",
    body: fd,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("whisper-server " + res.status);
  return clean(await res.text());
}

function transcribeViaCli(pcm) {
  return new Promise((resolve) => {
    const b = whisperBin();
    if (!b || !pcm?.length) return resolve("");
    const file = path.join(os.tmpdir(), `il-ptt-${process.pid}.wav`);
    try {
      fs.writeFileSync(file, wav(pcm));
    } catch {
      return resolve("");
    }
    const p = spawn(b, ["-m", MODEL, "-f", file, "-nt", "-l", "en", "-t", THREADS], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      try { fs.unlinkSync(file); } catch {}
      resolve(clean(out));
    });
    p.on("error", () => resolve(""));
  });
}

// Transcribe raw PCM (s16le mono 16k). Prefers the resident server; falls back to
// a fresh whisper-cli if the server isn't up or errors.
export async function transcribe(pcm) {
  if (!pcm?.length) return "";
  if (serverUp) {
    try {
      return await transcribeViaServer(pcm);
    } catch {
      /* fall through to cli */
    }
  }
  return transcribeViaCli(pcm);
}

// Start the resident server and wait until it answers, so the FIRST real
// transcription is already fast. Fire-and-forget at startup. Falls back to
// priming the cli page-cache if the server never comes up.
export async function warm() {
  ensureServer();
  const dummy = Buffer.alloc(16000 * 2); // 1s silence
  for (let i = 0; i < 40 && server; i++) {
    try {
      await transcribeViaServer(dummy);
      serverUp = true;
      return;
    } catch {
      await sleep(500);
    }
  }
  if (!serverUp) transcribeViaCli(dummy).catch(() => {}); // server unavailable → prime cli
}

// Fast, server-only transcription for LIVE partials while the key is held. No cli
// fallback (partials must be cheap); returns "" if the server isn't up.
export async function partial(pcm) {
  if (!serverUp || !pcm?.length) return "";
  try {
    return await transcribeViaServer(pcm);
  } catch {
    return "";
  }
}

export function stop() {
  try {
    server?.kill();
  } catch {}
  server = null;
  serverUp = false;
}
