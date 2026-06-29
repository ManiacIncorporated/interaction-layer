#!/usr/bin/env node
// Claude Code hook: records which session is live for a project so the
// interaction-layer sidecar can attach to the EXACT transcript (no guessing).
// Wired to SessionStart ("start") and SessionEnd ("end") in hooks.json.
//
// Writes ~/.claude/interaction-layer/<cwd-slug>.json with the transcript path.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const mode = process.argv[2] === "end" ? "end" : "start";
const pluginRoot = process.argv[3] || ""; // passed from hooks.json

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// One global sidecar watches ALL projects (it discovers them from the pointer
// files we write). So the FIRST SessionStart launches it; every later one just
// drops its pointer and the running sidecar picks it up. Opt out with
// IL_AUTOLAUNCH=0. macOS-only (osascript + Terminal.app).
//
// Two locks coordinate this, both claimed atomically (O_EXCL) so several
// SessionStart hooks firing at once — e.g. three cmux panes starting `claude`
// together — produce exactly ONE window, not three:
//   sidecar.running   — owned by the live sidecar (its pid); present => don't launch.
//   sidecar.launching — short-lived marker a winning hook plants before spawning,
//                       so concurrent hooks back off during the cold-start window.
const LAUNCH_GRACE_MS = 20_000; // cold-start budget before a launch marker is stale
function maybeLaunch(dir, cwd) {
  if (process.env.IL_AUTOLAUNCH === "0" || !pluginRoot) return;
  // Already running?
  try {
    const pid = Number(String(fs.readFileSync(path.join(dir, "sidecar.running"), "utf8")).replace(/\D/g, ""));
    if (pid && alive(pid)) return;
  } catch {
    /* no run lock — maybe launch */
  }
  // Atomically win the right to launch (lose => another hook is already on it).
  const marker = path.join(dir, "sidecar.launching");
  let fd;
  try {
    fd = fs.openSync(marker, "wx");
  } catch (e) {
    if (e.code !== "EEXIST") return;
    let stale = true;
    try {
      stale = Date.now() - fs.statSync(marker).mtimeMs > LAUNCH_GRACE_MS;
    } catch {}
    if (!stale) return; // another hook is mid-launch
    try {
      fs.unlinkSync(marker);
      fd = fs.openSync(marker, "wx");
    } catch {
      return;
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {}

  const script = path.join(pluginRoot, "bin", "interaction-layer.mjs");
  // If Claude (and this hook) run inside cmux, pass the socket password through so
  // the sidecar can drive cmux (`cmux send`) to steer the agent. All cmux surfaces
  // share one socket password, so the first hook's value covers every project.
  const pw = process.env.CMUX_SOCKET_PASSWORD;
  const envPrefix = pw ? `CMUX_SOCKET_PASSWORD=${JSON.stringify(pw)} ` : "";
  // No project arg => MULTI mode: the sidecar watches every active session.
  const shell = `cd ${JSON.stringify(cwd)} && ${envPrefix}node ${JSON.stringify(script)}`;
  const osa = `tell application "Terminal" to do script ${JSON.stringify(shell)}`;
  try {
    spawn("osascript", ["-e", osa], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* never block the session */
  }
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let p = {};
  try {
    p = JSON.parse(input || "{}");
  } catch {
    /* tolerate empty/odd payloads */
  }
  const cwd = p.cwd || process.cwd();
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = path.join(os.homedir(), ".claude", "interaction-layer");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, slug + ".json"),
      JSON.stringify(
        {
          session_id: p.session_id || null,
          transcript_path: p.transcript_path || null,
          cwd,
          ts: new Date().toISOString(),
          ended: mode === "end",
        },
        null,
        2
      )
    );
  } catch {
    /* hooks must never block the session; fail silently */
  }
  if (mode === "start") maybeLaunch(dir, cwd);
  process.exit(0);
});
