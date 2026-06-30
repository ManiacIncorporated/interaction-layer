// Codex CLI source adapter. Codex stores each session as a JSONL "rollout" file at
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. This maps Codex's records
// onto the conductor's shared TraceEvent model (thinking / assistant_say / user_say
// / tool_use / tool_result / turn_end) so the narration model needs no changes.
//
// Notes from the real format:
//  - the user's ACTUAL text is event_msg:user_message (response_item message role=user
//    is injected AGENTS.md / environment context — skipped).
//  - assistant text is duplicated (event_msg:agent_message AND response_item message
//    role=assistant); we take the response_item one and skip the event_msg dup.
//  - event_msg:task_complete / turn_aborted marks the turn end → awaiting input.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

// Codex tool names → the canonical names the conductor's metrics/narration expect.
const TOOL_MAP = {
  apply_patch: "Edit",
  exec_command: "Bash",
  shell: "Bash",
  local_shell: "Bash",
  read_file: "Read",
  web_search: "WebSearch",
};

const textOf = (content) =>
  Array.isArray(content) ? content.map((c) => c.text || "").join("") : String(content || "");
const outText = (o) =>
  typeof o === "string" ? o : o && typeof o === "object" ? o.output || o.text || JSON.stringify(o) : String(o || "");

export function parseLine(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return [];
  }
  return [...parseRecord(rec)];
}

function* parseRecord(rec) {
  const ts = rec?.timestamp;
  const p = rec?.payload || {};
  if (rec?.type === "event_msg") {
    if (p.type === "user_message" && p.message && p.message.trim()) {
      yield { kind: "user_say", text: p.message, ts };
    } else if (p.type === "task_complete" || p.type === "turn_aborted") {
      yield { kind: "turn_end", ts }; // control signal → agent sets awaitingInput
    }
    return;
  }
  if (rec?.type !== "response_item") return;
  switch (p.type) {
    case "message": {
      // Only the assistant's words; user/developer items are context wrappers.
      if (p.role === "assistant") {
        const text = textOf(p.content);
        if (text.trim()) yield { kind: "assistant_say", text, ts };
      }
      return;
    }
    case "reasoning": {
      const text = [...(p.summary || []), ...(p.content || [])].map((s) => s.text || "").join(" ").trim();
      if (text) yield { kind: "thinking", text, ts };
      return;
    }
    case "function_call":
    case "custom_tool_call": {
      const tool = TOOL_MAP[p.name] || p.name || "tool";
      let input = {};
      try {
        input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments || p.input || {};
      } catch {
        input = { raw: p.arguments };
      }
      // normalize a shell command into input.command so test/edit metrics fire
      if (tool === "Bash" && (input.cmd || input.command)) input = { command: input.cmd || input.command };
      yield { kind: "tool_use", id: p.call_id || p.id, tool, input, ts };
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const text = outText(p.output);
      yield { kind: "tool_result", id: p.call_id, isError: /exited with code [1-9]|^error:|\berror\b:/i.test(text), text, ts };
      return;
    }
    case "web_search_call": {
      yield { kind: "tool_use", tool: "WebSearch", input: { query: p.action?.query || "" }, ts };
      return;
    }
  }
}

// cwd lives early in the first (session_meta) line, before the huge base_instructions
// blob — regex it out of the first chunk instead of parsing the whole giant line.
export function cwdOf(file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(16384);
    const n = fs.readSync(fd, b, 0, 16384, 0);
    fs.closeSync(fd);
    const m = b.toString("utf8", 0, n).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse('"' + m[1] + '"') : null;
  } catch {
    return null;
  }
}

const subdirs = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
};

// Active Codex sessions: rollout files touched within staleMs, with their cwd. Only
// scans the few most-recent day directories (sessions are foldered by date).
export function activeCodexSessions(staleMs) {
  const days = [];
  for (const y of subdirs(SESSIONS_DIR))
    for (const m of subdirs(path.join(SESSIONS_DIR, y)))
      for (const d of subdirs(path.join(SESSIONS_DIR, y, m))) days.push(path.join(SESSIONS_DIR, y, m, d));
  const now = Date.now();
  const out = [];
  for (const dir of days.slice(-3)) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let m;
      try {
        m = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (now - m > staleMs) continue;
      const cwd = cwdOf(file);
      if (cwd) out.push({ file, cwd });
    }
  }
  return out;
}

export function codexRunning() {
  try {
    const out = execFileSync("pgrep", ["-f", "codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\s+/).map(Number).some((pid) => pid && pid !== process.pid);
  } catch {
    return false;
  }
}
