// Turn TraceEvents into short spoken lines WITHOUT an LLM. This is the always-on
// stream: instant and free. The LLM is reserved for synthesis (world-model + Q&A).
import path from "node:path";

const base = (p) => (p ? path.basename(String(p)) : "");

// Compress a shell command to something speakable.
function speakCmd(cmd = "") {
  const first = cmd.trim().split(/\s+/).slice(0, 4).join(" ");
  return first.length > 50 ? first.slice(0, 50) + "…" : first;
}

// Map a tool_use event to a spoken phrase, or null to stay silent.
export function narrateToolUse(ev) {
  const i = ev.input || {};
  switch (ev.tool) {
    case "Read":
      return `Reading ${base(i.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${base(i.file_path)}`;
    case "Write":
      return `Writing ${base(i.file_path)}`;
    case "NotebookEdit":
      return `Editing notebook ${base(i.notebook_path)}`;
    case "Bash":
      return `Running ${speakCmd(i.command)}`;
    case "Grep":
      return `Searching for ${i.pattern ?? "a pattern"}`;
    case "Glob":
      return `Looking for files matching ${i.pattern ?? ""}`;
    case "Task":
      return `Delegating to a sub-agent`;
    case "WebFetch":
      return `Fetching a web page`;
    case "WebSearch":
      return `Searching the web for ${i.query ?? ""}`;
    case "TodoWrite":
      return `Updating its task list`;
    default:
      return null; // unknown/low-value tools stay quiet
  }
}

// Only speak results when they carry signal (failures). Success is implied by
// the next action, so we don't narrate every OK.
export function narrateResult(ev, toolName) {
  if (!ev.isError) {
    // Surface test/build failures even when not flagged as a hard error.
    if (/\b(\d+) (failed|failing|error[s]?)\b/i.test(ev.text || "")) {
      const m = ev.text.match(/\b(\d+) (failed|failing|error[s]?)\b/i);
      return `Heads up — ${m[0]}`;
    }
    return null;
  }
  return `${toolName || "That"} failed`;
}

export function narrateAssistantSay(ev) {
  // The agent's own prose to the user — speak the first sentence as a checkpoint.
  const first = (ev.text || "").trim().split(/(?<=[.!?])\s/)[0];
  if (!first || first.length < 8) return null;
  return first.length > 160 ? first.slice(0, 160) + "…" : first;
}
