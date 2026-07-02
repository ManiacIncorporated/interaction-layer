// Send a prompt into the user's running interactive `claude`. Vanilla Claude Code
// has no injection API, so we target Claude's terminal and deliver the text:
//   1. cmux (Ghostty-based) — via its socket CLI `cmux send --surface <id>` (clean,
//      no keystroke simulation). Targets the surface whose cwd is the project.
//   2. Terminal.app — simulate keystrokes into the tab whose TTY runs claude.
// We match Claude to the project by working directory, so we only ever type into
// the real Claude terminal, never the sidecar. If we can't find it, we do nothing.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guiSend, APP_PROFILES } from "./gui-send.mjs";

const LOG_DIR = path.join(os.homedir(), ".claude", "interaction-layer");
function debug(name, data) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
  } catch {}
}

// ---------- cmux ----------
const CMUX = ["/Applications/cmux.app/Contents/Resources/bin/cmux",
              "/Applications/Cmux.app/Contents/Resources/bin/cmux"].find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

// cmux's control socket needs a password AND external access enabled
// (socketControlMode must not be "cmuxOnly"). cmux terminals don't auto-export the
// password, so an auto-launched sidecar won't inherit it. Resolve it from, in order:
// the env, a file the user can drop next to our logs, or cmux's own config.
const PW_FILE = path.join(LOG_DIR, "cmux-password.txt");

// Read cmux's configured socket password from its JSONC config, so once external
// socket control is enabled in cmux there's nothing to copy by hand.
function cmuxConfigPassword() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".config", "cmux", "cmux.json"), "utf8");
    const cleaned = raw
      .replace(/^\s*\/\/.*$/gm, "") // strip // comment lines
      .replace(/[\u0000-\u001f]+/g, " ") // tolerate stray control chars
      .replace(/,(\s*[}\]])/g, "$1"); // tolerate trailing commas
    const c = JSON.parse(cleaned);
    const pw = c && c.automation && c.automation.socketPassword;
    return pw ? String(pw) : null;
  } catch {
    return null;
  }
}
function cmuxPassword() {
  if (process.env.CMUX_SOCKET_PASSWORD) return process.env.CMUX_SOCKET_PASSWORD.trim();
  try {
    const p = fs.readFileSync(PW_FILE, "utf8").trim();
    if (p) return p;
  } catch {}
  return cmuxConfigPassword();
}
function cmuxArgs(args) {
  const pw = cmuxPassword();
  return pw ? ["--password", pw, ...args] : args;
}

// The CLI defaults to ~/.local/state/cmux/cmux.sock, which can be a STALE socket
// from a previous run; the live server writes its actual path to `last-socket-path`
// (e.g. cmux-501.sock). Point the CLI at the live one so we don't hit a dead pipe.
function cmuxEnv() {
  if (process.env.CMUX_SOCKET_PATH) return process.env;
  try {
    const sp = fs.readFileSync(path.join(os.homedir(), ".local", "state", "cmux", "last-socket-path"), "utf8").trim();
    if (sp) return { ...process.env, CMUX_SOCKET_PATH: sp };
  } catch {}
  return process.env;
}

function cmuxTree() {
  if (!CMUX) return null;
  try {
    const out = execFileSync(CMUX, cmuxArgs(["tree", "--all", "--json"]), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: cmuxEnv(),
    });
    return JSON.parse(out);
  } catch (e) {
    debug("cmux-error.log", `cmux tree failed (have password: ${!!cmuxPassword()}): ${e.message}\n${e.stderr || ""}`);
    return null;
  }
}

// cmux's tree nests terminal surfaces (windows→workspaces→panes→surfaces); each
// surface has a `ref` ("surface:N") and a `tty` ("ttysNNN") but NOT a cwd. So we
// map the project's claude TTY (resolved from cwd by findClaudeTty) to its surface
// ref, then `cmux send --surface <ref>`. (Verified against the live tree schema.)
function findSurfaceRefByTty(tty, tree) {
  const want = String(tty || "").replace(/^\/dev\//, "");
  if (!want) return null;
  let ref = null;
  (function walk(n) {
    if (ref) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (n.tty === want) {
        ref = n.ref || n.surface_ref || n.surfaceRef || null;
        if (ref) return;
      }
      for (const k in n) walk(n[k]);
    }
  })(tree);
  return ref;
}

// All ttys of claude processes whose cwd is the project (there can be several —
// the cmux pane plus sub-processes; only the pane's tty is a real cmux surface).
function findClaudeTtys(cwd, proc = "claude") {
  const script = `
    for pid in $(pgrep -f "$2"); do
      cmd=$(ps -o command= -p "$pid" 2>/dev/null)
      case "$cmd" in *interaction-layer*|*ptt-monitor*|*nowplaying-monitor*) continue;; esac
      pcwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
      if [ "$pcwd" = "$1" ]; then
        t=$(ps -o tty= -p "$pid" | tr -d ' ')
        [ -n "$t" ] && [ "$t" != "??" ] && echo "$t"
      fi
    done`;
  try {
    return execFileSync("bash", ["-c", script, "_", cwd, proc], { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function sendViaCmux(text, cwd, proc = "claude") {
  const tree = cmuxTree();
  if (!tree) return null; // socket unreachable / not installed
  // Pick the agent tty that's actually a cmux surface (disambiguates when several
  // processes share the cwd).
  let ref = null;
  for (const tty of findClaudeTtys(cwd, proc)) {
    ref = findSurfaceRefByTty(tty, tree);
    if (ref) break;
  }
  if (!ref) {
    debug("cmux-tree.json", tree); // save so targeting can be fixed
    return "NOSURFACE";
  }
  try {
    const opts = { stdio: ["ignore", "ignore", "pipe"], env: cmuxEnv() };
    // Send the text, then a SEPARATE real Enter keypress. A trailing "\n" in the
    // text gets pasted as a literal newline — Claude's TUI inserts a line break
    // instead of submitting — so the Enter must be its own key event (send-key).
    execFileSync(CMUX, cmuxArgs(["send", "--surface", ref, text]), opts);
    await new Promise((r) => setTimeout(r, 150)); // let the TUI ingest the paste first
    execFileSync(CMUX, cmuxArgs(["send-key", "--surface", ref, "enter"]), opts);
    return "OK";
  } catch (e) {
    debug("cmux-error.log", `cmux send failed: ${e.message}\n${e.stderr || ""}`);
    return null;
  }
}

// ---------- Terminal.app ----------
export function findClaudeTty(cwd, proc = "claude") {
  const script = `
    for pid in $(pgrep -f "$2"); do
      cmd=$(ps -o command= -p "$pid" 2>/dev/null)
      case "$cmd" in *interaction-layer*|*ptt-monitor*|*nowplaying-monitor*) continue;; esac
      pcwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
      if [ "$pcwd" = "$1" ]; then
        t=$(ps -o tty= -p "$pid" | tr -d ' ')
        [ -n "$t" ] && [ "$t" != "??" ] && echo "/dev/$t" && exit 0
      fi
    done
    exit 1`;
  try {
    return execFileSync("bash", ["-c", script, "_", cwd, proc], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const OSA = `
on run argv
  set targetTTY to item 1 of argv
  set theText to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if tty of t is targetTTY then
            set selected of t to true
            set frontmost of w to true
            activate
            delay 0.15
            tell application "System Events"
              keystroke theText
              delay 0.05
              key code 36
            end tell
            return "OK"
          end if
        end try
      end repeat
    end repeat
  end tell
  return "NOTFOUND"
end run`;

function sendViaTerminal(text, cwd, proc = "claude") {
  return new Promise((resolve) => {
    const tty = findClaudeTty(cwd, proc);
    if (!tty) return resolve("NOTTY");
    execFile("osascript", ["-e", OSA, tty, text], (err, stdout) => {
      if (err) return resolve("ERROR:" + (err.message || "").split("\n")[0]);
      resolve((stdout || "").trim() || "NOTFOUND");
    });
  });
}

// Try cmux first (clean socket API), then Terminal.app keystrokes.
// Returns "OK" | "NOTTY" | "NOTFOUND" | "CMUXAUTH" | "ERROR:<msg>".
export async function sendToClaude(text, cwd, source = "claude") {
  const proc = source === "codex" ? "codex" : "claude";
  let cmuxUnreachable = false;
  if (CMUX) {
    const r = await sendViaCmux(text, cwd, proc);
    if (r === "OK") return "OK";
    if (r === null) cmuxUnreachable = true; // socket/auth failure (not just "no matching pane")
    // r === "NOSURFACE" (cmux reachable but no matching surface) → try Terminal.app.
  }
  const t = await sendViaTerminal(text, cwd, proc);
  if (t === "OK") return "OK";
  // No terminal for this agent (it's the desktop/IDE app — Claude/Codex Desktop,
  // VSCode). Best-effort GUI fallback: type into the app window whose title matches
  // this project (AX title-guard refuses if no window matches → never wrong-window).
  if (t === "NOTTY" && APP_PROFILES[source]) {
    const hint = cwd.split("/").filter(Boolean).pop() || "";
    const g = await guiSend(text, source, hint);
    if (g === "OK") return "OK";
    if (g === "NOMATCH") return "GUINOMATCH"; // app open but no window titled for this project
    if (g === "NOAPP") return t; // app not running → fall through to the plain no-terminal message
    // ERROR → report the terminal failure (more actionable)
  }
  // Both failed. If cmux is installed but we couldn't reach its socket, that's the
  // actionable cause (external socket control disabled / no password) — surface it.
  if (cmuxUnreachable) return "CMUXAUTH";
  return t; // NOTTY / NOTFOUND / ERROR
}
