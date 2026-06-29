// Continuous mic capture + energy-based voice-activity detection (VAD).
// Streams raw PCM from `sox` and emits:
//   "speechstart" — the instant the user starts talking (barge-in trigger)
//   "speechend"   — Buffer of the captured utterance (16kHz mono s16le) for STT
//   "rms"         — per-frame level (for calibration/debugging)
//
// Requires `sox` (brew install sox) and Microphone permission for the terminal.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const RATE = 16000; // Hz, mono — what most STT wants
const FRAME_BYTES = 2048; // ~64ms at 16kHz s16le

function rms(buf) {
  let sum = 0;
  const n = buf.length / 2;
  for (let i = 0; i < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export class Mic extends EventEmitter {
  constructor({ onsetFrames = 2, hangoverMs = 600, sensitivity = 1 } = {}) {
    super();
    this.onsetFrames = onsetFrames; // consecutive loud frames to declare speech
    this.hangoverFrames = Math.round(hangoverMs / 64);
    this.sensitivity = sensitivity; // >1 = easier to trigger (lower bar)
    this.proc = null;
    this.floor = null; // adaptive noise floor (null until first calibration)
    this.calibFrames = [];
    this.speaking = false;
    this.loud = 0;
    this.quiet = 0;
    this.utter = []; // accumulated speech buffers
    this.pending = Buffer.alloc(0);
    this.boost = 1; // multiplier on threshold (raised while our TTS plays)
  }

  // Raise the bar while we're speaking so our own audio echo (over speakers)
  // doesn't read as user speech. Headphone users can leave this at 1.
  setBoost(mult) {
    this.boost = mult;
  }

  start() {
    // -d default device, -q quiet, raw 16-bit signed mono @16k to stdout.
    this.proc = spawn("sox", [
      "-d", "-q",
      "-t", "raw", "-e", "signed", "-b", "16", "-c", "1", "-r", String(RATE),
      "-",
    ]);
    this.proc.stdout.on("data", (chunk) => this._onAudio(chunk));
    this.proc.on("error", (e) => this.emit("error", e));
    this.proc.stderr.on("data", (d) => {
      const s = d.toString();
      if (/no default|cannot open|permission/i.test(s)) {
        this.emit("error", new Error("mic capture failed: " + s.trim()));
      }
    });
    return this;
  }

  _onAudio(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= FRAME_BYTES) {
      const frame = this.pending.subarray(0, FRAME_BYTES);
      this.pending = this.pending.subarray(FRAME_BYTES);
      this._onFrame(frame);
    }
  }

  _threshold() {
    return (Math.max(this.floor * 3.5, this.floor + 350) * this.boost) / this.sensitivity;
  }

  _onFrame(frame) {
    const level = rms(frame);
    this.emit("rms", level);
    const weSpeak = this.boost > 1; // our TTS is playing — don't let it pollute the floor

    // Initial calibration: only over genuine ambient (skip our own audio).
    if (this.floor === null) {
      if (weSpeak) return;
      this.calibFrames.push(level);
      if (this.calibFrames.length >= 16) {
        this.floor =
          this.calibFrames.reduce((a, b) => a + b, 0) / this.calibFrames.length;
        this.emit("ready", { floor: this.floor, threshold: this._threshold() });
      }
      return;
    }

    const isLoud = level > this._threshold();
    // Adapt the floor on quiet frames (not during speech or our own audio), so a
    // bad initial estimate self-corrects and ambient drift is tracked.
    if (!isLoud && !this.speaking && !weSpeak) {
      this.floor = 0.97 * this.floor + 0.03 * level;
    }

    if (!this.speaking) {
      this.loud = isLoud ? this.loud + 1 : 0;
      if (this.loud >= this.onsetFrames) {
        this.speaking = true;
        this.quiet = 0;
        this.utter = [frame];
        this.emit("speechstart");
      }
    } else {
      this.utter.push(frame);
      if (isLoud) {
        this.quiet = 0;
      } else if (++this.quiet >= this.hangoverFrames) {
        this.speaking = false;
        this.loud = 0;
        const audio = Buffer.concat(this.utter);
        this.utter = [];
        this.emit("speechend", audio);
      }
    }
  }

  stop() {
    if (this.proc) this.proc.kill();
    this.proc = null;
  }

  // --- Push-to-talk recorder: capture raw PCM only between start/stop, so the
  // mic is physically off (no sox process) except while you hold the key. ---
  startRecording() {
    this.recChunks = [];
    this.recProc = spawn("sox", [
      "-d", "-q",
      "-t", "raw", "-e", "signed", "-b", "16", "-c", "1", "-r", String(RATE),
      "-",
    ]);
    this.recProc.stdout.on("data", (c) => this.recChunks.push(c));
    this.recProc.on("error", (e) => this.emit("error", e));
  }

  // Snapshot the audio captured so far WITHOUT stopping — for live partial
  // transcription while the key is still held.
  currentRecording() {
    return Buffer.concat(this.recChunks || []);
  }

  stopRecording() {
    const p = this.recProc;
    this.recProc = null;
    if (p) p.kill();
    const pcm = Buffer.concat(this.recChunks || []);
    this.recChunks = [];
    return pcm;
  }
}

export const MIC_RATE = RATE;
