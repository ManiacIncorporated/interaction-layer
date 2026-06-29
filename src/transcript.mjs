// Locate and live-tail a Claude Code session transcript, emitting structured
// TraceEvents. The transcript is appended in real time, so we watch the file
// and parse newly-appended JSONL lines.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Claude Code derives the per-project dir by replacing non-alphanumerics in the
// absolute cwd with "-". Same slug is reused for our pointer-file naming.
export function slugFor(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Match a project's transcript dir by listing candidates and picking the freshest.
export function projectDirFor(cwd) {
  const slug = slugFor(cwd);
  const exact = path.join(PROJECTS_DIR, slug);
  if (fs.existsSync(exact)) return exact;
  // Fallback: fuzzy match on trailing path segment.
  if (!fs.existsSync(PROJECTS_DIR)) return null;
  const tail = path.basename(cwd);
  const hit = fs
    .readdirSync(PROJECTS_DIR)
    .filter((d) => d.includes(tail))
    .map((d) => path.join(PROJECTS_DIR, d))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  return hit || null;
}

// Newest .jsonl in a project dir = the active/most-recent session.
export function latestTranscript(projectDir) {
  const files = fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(projectDir, f));
  if (!files.length) return null;
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

// Recover the project cwd from a transcript by scanning the head for a "cwd"
// field (user/assistant records carry it; the first line may not). Bounded read
// so we don't slurp a multi-MB transcript just for one field.
export function cwdFromTranscript(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString("utf8", 0, n).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch {
    return null;
  }
}

// Discover every project whose newest transcript was touched within `freshMs` —
// i.e. sessions that are active RIGHT NOW, even if no hook pointer exists for
// them (e.g. a `claude` started before the plugin was installed). Returns
// [{ file, cwd, mtimeMs }]. Used for a thorough one-shot scan at sidecar startup.
export function activeTranscripts(freshMs) {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    let latest;
    try {
      latest = latestTranscript(dir);
    } catch {
      continue; // not a dir / unreadable
    }
    if (!latest) continue;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(latest).mtimeMs;
    } catch {
      continue;
    }
    if (Date.now() - mtimeMs > freshMs) continue;
    const cwd = cwdFromTranscript(latest);
    if (cwd) out.push({ file: latest, cwd, mtimeMs });
  }
  return out;
}

// Parse a single JSONL line into TraceEvents (exported for testing/reuse).
export function parseLine(line) {
  if (!line || !line.trim()) return [];
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return [];
  }
  return [...parseRecord(rec)];
}

// Distill one raw JSONL record into zero or more high-level TraceEvents.
function* parseRecord(rec) {
  const msg = rec?.message;
  if (rec?.type === "assistant" && Array.isArray(msg?.content)) {
    // stop_reason "end_turn" → the agent finished and is awaiting input; "tool_use"
    // → it's mid-work and will continue after the result. Lets the conductor tell
    // "done, waiting for you" from "still working" instead of guessing.
    const stopReason = msg.stop_reason || null;
    for (const block of msg.content) {
      if (block.type === "thinking" && block.thinking) {
        yield { kind: "thinking", text: block.thinking, ts: rec.timestamp };
      } else if (block.type === "text" && block.text?.trim()) {
        yield { kind: "assistant_say", text: block.text, ts: rec.timestamp, stopReason };
      } else if (block.type === "tool_use") {
        yield {
          kind: "tool_use",
          id: block.id,
          tool: block.name,
          input: block.input || {},
          ts: rec.timestamp,
        };
      }
    }
  } else if (rec?.type === "user" && Array.isArray(msg?.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c.text || "").join("\n")
          : typeof block.content === "string"
          ? block.content
          : "";
        yield {
          kind: "tool_result",
          id: block.tool_use_id,
          isError: !!block.is_error,
          text,
          ts: rec.timestamp,
        };
      } else if (block.type === "text" && block.text?.trim()) {
        yield { kind: "user_say", text: block.text, ts: rec.timestamp };
      }
    }
  } else if (rec?.type === "user" && typeof msg?.content === "string") {
    yield { kind: "user_say", text: msg.content, ts: rec.timestamp };
  }
}

// Scan a transcript for long-horizon anchors (one full read at attach): the
// original goal (first substantive user message), the true session start, and
// ACTIVE work time. Active time sums the gaps between consecutive events but caps
// each gap at `gapCapMs` — so a session parked for hours/overnight (or resumed
// days later) counts the working stretches, not the wall-clock span.
export function sessionTiming(file, gapCapMs = 300_000) {
  let goal = null;
  let startedAt = 0;
  let activeMs = 0;
  let lastTs = 0;
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = rec.timestamp ? Date.parse(rec.timestamp) || 0 : 0;
      if (ts) {
        if (!startedAt) startedAt = ts;
        if (lastTs && ts > lastTs) activeMs += Math.min(ts - lastTs, gapCapMs);
        lastTs = ts;
      }
      if (!goal) {
        for (const ev of parseRecord(rec)) {
          if (ev.kind === "user_say" && isGoalLike(ev.text)) {
            goal = ev.text.trim();
            break;
          }
        }
      }
    }
  } catch {}
  return { goal, startedAt, activeMs, lastTs };
}

// The first *substantive* user message is the goal; skip slash commands, local
// command wrappers, interrupt caveats, and trivially short lines.
function isGoalLike(text) {
  const t = String(text || "").trim();
  if (t.length < 12) return false;
  if (t.startsWith("/")) return false;
  if (/^<(command-name|local-command|command-message|user-prompt-submit)/i.test(t)) return false;
  if (/^\[Request interrupted/i.test(t)) return false;
  if (/Caveat: The messages below/i.test(t)) return false;
  return true;
}

// Read the last `n` TraceEvents already in the file, so the sidecar has context
// the moment it attaches (otherwise early questions see an empty buffer).
export function seedEvents(file, n = 40) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) out.push(...parseLine(line));
  return out.slice(-n);
}

// Tail a file: emit "event" for each parsed TraceEvent on appended lines.
// If fromStart is false (default) we skip existing content and only follow new
// activity — the live experience.
export function tail(file, { fromStart = false } = {}) {
  const em = new EventEmitter();
  let offset = fromStart ? 0 : fs.statSync(file).size;
  let buf = "";
  let reading = false;
  let closed = false;

  const drain = () => {
    if (reading || closed) return;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // file vanished mid-flight
    }
    if (size <= offset) return; // nothing new (e.g. a non-append fs.watch tick)
    reading = true;
    // Read into a LOCAL buffer and advance offset by exactly what we read, so a
    // partial line retained in `buf` is never re-read on the next drain.
    const stream = fs.createReadStream(file, { start: offset, encoding: "utf8" });
    let data = "";
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => {
      offset += Buffer.byteLength(data, "utf8");
      buf += data;
      const lines = buf.split("\n");
      buf = lines.pop() || ""; // keep partial (un-terminated) last line for later
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        for (const ev of parseRecord(rec)) em.emit("event", ev);
      }
      reading = false;
      // More may have been appended while we were reading.
      try {
        if (fs.statSync(file).size > offset) drain();
      } catch {}
    });
    stream.on("error", (e) => {
      reading = false;
      em.emit("error", e);
    });
  };

  // Event-driven (FSEvents/inotify) → reacts to an append in ~milliseconds,
  // instead of waiting on a poll. A slow fs.watchFile poll stays as a backstop
  // for the cases fs.watch can miss (some editors/network filesystems).
  let fsw = null;
  try {
    fsw = fs.watch(file, () => drain());
  } catch {
    /* fall back to polling only */
  }
  fs.watchFile(file, { interval: 1000 }, (cur, prev) => {
    if (cur.size !== prev.size) drain();
  });
  em.close = () => {
    closed = true;
    try {
      fsw?.close();
    } catch {}
    fs.unwatchFile(file);
  };
  return em;
}
