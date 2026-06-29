// Conductor capability: spawn a NEW Claude Code agent to work on a task, isolated
// in its own git worktree, launched in a Terminal window. The running sidecar
// auto-discovers it (its SessionStart hook writes a pointer / its transcript is
// fresh) and narrates + steers it like any other agent.
//
// Safety notes:
// - The task text is LLM-rewritten free text. It NEVER goes into the shell command
//   string — we write it to a temp file and the launched shell reads it with a
//   quoted command-substitution, so no backtick/$()/quote can break out.
// - Spawned agents run with a permission mode (default acceptEdits) so they don't
//   stall on the first edit in a window nobody's watching. Override via IL_SPAWN_PERMISSION.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PERMISSION_MODE = process.env.IL_SPAWN_PERMISSION || "acceptEdits";

// Resolve the git repo root for a directory (null if not a git work tree).
export function repoRootOf(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function slugify(task) {
  return (
    String(task)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

// Single-quote for the shell (handles any character including spaces/quotes).
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Spawn an agent. Returns { ok, dir, branch, isolated } or { ok:false, error }.
export function spawnAgent({ task, cwd, stamp }) {
  const t = String(task || "").trim();
  if (!t) return { ok: false, error: "no task given" };

  // Injection-safe: the task lives in a file, never in the command string.
  let taskFile;
  try {
    taskFile = path.join(os.tmpdir(), `il-spawn-${stamp || "x"}-${slugify(t)}.txt`);
    fs.writeFileSync(taskFile, t);
  } catch (e) {
    return { ok: false, error: "couldn't stage the task" };
  }

  const root = repoRootOf(cwd);
  let workdir = cwd;
  let branch = null;
  if (root) {
    const slug = slugify(t);
    const id = (stamp ? String(stamp) : "0").toString(36).slice(-4);
    branch = `il/${slug}-${id}`;
    workdir = path.join(path.dirname(root), `${path.basename(root)}-${slug}-${id}`);
    try {
      execFileSync("git", ["-C", root, "worktree", "add", workdir, "-b", branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return { ok: false, error: `git worktree failed: ${(e.stderr || e.message || "").split("\n")[0]}` };
    }
  }

  // Launch `claude` seeded with the task in a new Terminal window. Only the
  // (sanitized) paths are interpolated; the task is read from the file at runtime.
  const cmd =
    `cd ${shq(workdir)} && claude --permission-mode ${shq(PERMISSION_MODE)} ` +
    `"$(cat ${shq(taskFile)})"`;
  // IL_SPAWN_DRYRUN: do everything except open the window (returns the command).
  if (process.env.IL_SPAWN_DRYRUN) {
    return { ok: true, dir: workdir, branch, isolated: !!root, cmd, taskFile, dryrun: true };
  }
  const osa = `tell application "Terminal" to do script ${JSON.stringify(cmd)}`;
  try {
    spawn("osascript", ["-e", osa], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    return { ok: false, error: "couldn't open a Terminal window" };
  }
  return { ok: true, dir: workdir, branch, isolated: !!root };
}
