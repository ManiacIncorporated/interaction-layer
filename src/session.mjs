// Figures out WHICH Claude Code session to attach to, and whether one is even
// running. Resolution order:
//   1. Hook pointer file (~/.claude/interaction-layer/<slug>.json) written by the
//      SessionStart hook — authoritative: exact transcript path, known live.
//   2. Newest transcript in the project dir — heuristic fallback.
//
// Emits:
//   "attach" {file, source, stale} — first session to follow
//   "switch" {file, source}        — a newer live session appeared; re-attach
//   "waiting"                      — nothing to attach to yet; watching for one
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { slugFor, projectDirFor, latestTranscript, activeTranscripts } from "./transcript.mjs";
import { activeCodexSessions, codexRunning } from "./sources/codex.mjs";

export const POINTER_DIR = path.join(os.homedir(), ".claude", "interaction-layer");
const FRESH_MS = 45_000; // a transcript touched this recently counts as "live"
const POLL_MS = 2000;

export class SessionWatcher extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
    this.current = null;
    this.timer = null;
    this.fsw = null;
    this.announcedWaiting = false;
  }

  pointerFile() {
    return path.join(POINTER_DIR, slugFor(this.cwd) + ".json");
  }

  readPointer() {
    try {
      const p = JSON.parse(fs.readFileSync(this.pointerFile(), "utf8"));
      if (p && !p.ended && p.transcript_path && fs.existsSync(p.transcript_path)) {
        return p;
      }
    } catch {
      /* no/invalid pointer */
    }
    return null;
  }

  claudeRunning() {
    try {
      // Best-effort liveness; the interactive CLI runs as a `claude` process.
      execFileSync("pgrep", ["-fl", "claude"], { stdio: ["ignore", "pipe", "ignore"] });
      return true;
    } catch {
      return false;
    }
  }

  resolve() {
    const ptr = this.readPointer();
    if (ptr) return { file: ptr.transcript_path, source: "hook" };
    const dir = projectDirFor(this.cwd);
    const file = dir ? latestTranscript(dir) : null;
    return { file, source: file ? "latest" : null };
  }

  isLive(file, source) {
    if (source === "hook") return true; // hook only writes for a started session
    if (!file) return false;
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < FRESH_MS) return true;
    } catch {
      return false;
    }
    return this.claudeRunning();
  }

  tick() {
    const { file, source } = this.resolve();
    if (!file) {
      if (!this.announcedWaiting) {
        this.announcedWaiting = true;
        this.emit("waiting");
      }
      return;
    }
    if (file === this.current) return;

    if (this.current === null) {
      this.current = file;
      this.currentSource = source;
      this.announcedWaiting = false;
      this.emit("attach", { file, source, stale: !this.isLive(file, source) });
      return;
    }

    // Already following a session. Only SWITCH for a genuinely new one — i.e. the
    // hook pointer now names a different transcript. A merely-newer file under the
    // heuristic is almost always noise (e.g. transcripts written by our own
    // sdk-backend sub-sessions in the same project), so we stay put.
    if (source === "hook") {
      this.current = file;
      this.currentSource = source;
      this.emit("switch", { file, source });
    }
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    const dir = projectDirFor(this.cwd);
    if (dir) {
      try {
        this.fsw = fs.watch(dir, () => this.tick());
      } catch {
        /* dir may not exist yet; poll covers it */
      }
    }
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.fsw?.close();
  }
}

// Watches ALL projects at once. Two discovery sources, unioned:
//   1. Hook pointer files in POINTER_DIR — authoritative for sessions that
//      registered via the SessionStart hook (cwd, transcript_path, ended).
//   2. A one-shot deep scan at startup of every project's newest transcript, so
//      a `claude` that was ALREADY running before the sidecar (or before the
//      plugin was even installed — no pointer) is seen immediately. After
//      startup, new sessions arrive via their hook pointers, so the deep scan
//      runs once.
//
// One sidecar drives many sessions. Emits, keyed by project slug:
//   "add"    {slug, cwd, file, stale} — a new live session to follow
//   "switch" {slug, cwd, file}        — same project, new transcript (re-attach)
//   "remove" {slug, cwd}              — session ended / disappeared (stop following)
const STALE_MS = 5 * 60_000; // a transcript untouched this long, with no claude alive, is dead

// Codex spawns many non-project sessions (desktop, computer-use, automations) in
// the home dir or temp dirs — don't auto-watch those, only real project work.
const HOME = os.homedir();
function isNoiseCwd(cwd) {
  if (!cwd || cwd === HOME) return true;
  return /^\/(tmp|private|var)\b/.test(cwd) || /\/var\/folders\//.test(cwd) || /il-research/.test(cwd);
}

// Is transcript `a` newer than `b`? (Missing/unreadable a => not newer.)
function newer(a, b) {
  try {
    return fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs;
  } catch {
    return false;
  }
}

export class MultiWatcher extends EventEmitter {
  constructor() {
    super();
    this.known = new Map(); // slug -> { file, cwd, viaPointer }
    this.ignored = new Set(); // slugs to never watch (e.g. our own research sub-agents)
    this.timer = null;
    this.fsw = null;
  }

  // Exclude a project slug from discovery — the conductor spawns `claude`
  // sub-agents (research) and must not narrate its own helpers.
  ignore(slug) {
    this.ignored.add(slug);
  }

  claudeRunning() {
    // Exclude our own pid: the sidecar runs from a path containing ".claude"
    // (plugin cache), so a bare `pgrep -f claude` always matches itself, which
    // would keep the generous-liveness branch permanently true and never let a
    // crashed-without-SessionEnd session get cleaned up.
    try {
      const out = execFileSync("pgrep", ["-f", "claude"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out
        .split(/\s+/)
        .map(Number)
        .some((pid) => pid && pid !== process.pid);
    } catch {
      return false;
    }
  }

  // Pre-existing active sessions with no hook pointer (e.g. `claude` started
  // before the sidecar). Add each as a transcript-sourced agent; the pointer
  // scan later "adopts" any that gain a pointer.
  deepScan() {
    for (const { file, cwd } of activeTranscripts(STALE_MS)) {
      const slug = slugFor(cwd);
      if (this.ignored.has(slug) || this.known.has(slug)) continue;
      this.known.set(slug, { file, cwd, viaPointer: false, source: "claude" });
      this.emit("add", { slug, cwd, file, stale: false, source: "claude" });
    }
    this.scanCodex();
  }

  // Codex sessions have no hook pointers (and may run in the desktop/VSCode app),
  // so they're discovered purely by their rollout files — newest active one per cwd.
  // Keyed "codex:<slug>" so a Codex and a Claude session in the same dir coexist.
  scanCodex() {
    const byCwd = new Map();
    for (const s of activeCodexSessions(STALE_MS)) {
      if (isNoiseCwd(s.cwd)) continue; // skip home/tmp/background codex sessions
      let m = 0;
      try {
        m = fs.statSync(s.file).mtimeMs;
      } catch {}
      const prev = byCwd.get(s.cwd);
      if (!prev || m > prev.m) byCwd.set(s.cwd, { ...s, m });
    }
    for (const { file, cwd } of byCwd.values()) {
      const slug = slugFor(cwd);
      if (this.ignored.has(slug)) continue;
      const key = "codex:" + slug;
      const prev = this.known.get(key);
      if (!prev) {
        this.known.set(key, { file, cwd, viaPointer: false, source: "codex" });
        this.emit("add", { slug: key, cwd, file, stale: false, source: "codex" });
      } else if (prev.file !== file && newer(file, prev.file)) {
        prev.file = file;
        this.emit("switch", { slug: key, cwd, file, source: "codex" });
      }
    }
  }

  scan() {
    let names = [];
    try {
      names = fs.readdirSync(POINTER_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      return; // dir not created yet
    }
    let claudeUp = null; // computed lazily, once per scan
    const pointered = new Set();
    for (const name of names) {
      let p;
      try {
        p = JSON.parse(fs.readFileSync(path.join(POINTER_DIR, name), "utf8"));
      } catch {
        continue;
      }
      if (!p || p.ended || !p.cwd || !p.transcript_path) continue;
      if (!fs.existsSync(p.transcript_path)) continue;
      // Liveness, erring generous: keep unless the transcript is long-stale AND no
      // claude is running anywhere (an idle-while-thinking session isn't dead).
      let fresh = false;
      try {
        fresh = Date.now() - fs.statSync(p.transcript_path).mtimeMs < STALE_MS;
      } catch {
        continue;
      }
      if (!fresh) {
        if (claudeUp === null) claudeUp = this.claudeRunning();
        if (!claudeUp) continue;
      }
      const slug = slugFor(p.cwd);
      if (this.ignored.has(slug)) continue; // our own research sub-agent
      pointered.add(slug);
      const prev = this.known.get(slug);
      if (!prev) {
        this.known.set(slug, { file: p.transcript_path, cwd: p.cwd, viaPointer: true, source: "claude" });
        this.emit("add", { slug, cwd: p.cwd, file: p.transcript_path, stale: !fresh, source: "claude" });
      } else {
        prev.viaPointer = true; // adopt a transcript-sourced agent that now has a pointer
        // Switch only to a genuinely NEWER transcript. A pointer can name an
        // older session than the one actively being written (e.g. deepScan found
        // the live transcript first); don't switch back to the stale one.
        if (prev.file !== p.transcript_path && newer(p.transcript_path, prev.file)) {
          prev.file = p.transcript_path;
          this.emit("switch", { slug, cwd: p.cwd, file: p.transcript_path, source: "claude" });
        }
      }
    }
    this.scanCodex(); // discover/refresh Codex sessions (keyed codex:<slug>)
    // Removals. Pointer-sourced agents drop when they leave the live pointer set
    // (ended / stale-dead). Transcript-sourced agents (no pointer — incl. all Codex)
    // have no such signal, so keep them until their transcript itself goes stale-dead.
    for (const [slug, info] of [...this.known]) {
      if (pointered.has(slug)) continue;
      let dead = !info.viaPointer ? this.transcriptDead(info.file, info.source) : true;
      if (dead) {
        this.known.delete(slug);
        this.emit("remove", { slug, cwd: info.cwd, source: info.source });
      }
    }
  }

  transcriptDead(file, source = "claude") {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < STALE_MS) return false; // still active
    } catch {
      return true; // gone
    }
    // stale: dead only if no agent of that kind is alive anywhere
    return source === "codex" ? !codexRunning() : !this.claudeRunning();
  }

  start() {
    this.deepScan(); // catch sessions already running before us
    this.scan();
    this.timer = setInterval(() => this.scan(), POLL_MS);
    try {
      this.fsw = fs.watch(POINTER_DIR, () => this.scan());
    } catch {
      /* dir may not exist yet; poll covers it */
    }
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.fsw?.close();
  }
}
