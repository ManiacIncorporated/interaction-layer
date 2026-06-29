// Learned guardrails: the user's durable preferences, inferred over time from how
// they steer and CORRECT the agent ("no, don't touch the config", "stop adding
// deps"), then auto-applied to future relayed prompts so they never repeat them.
//
// Two tiers: global (apply everywhere — "always run tests") and per-project (this
// repo only — "don't touch the config here"). Kept small and deduped; the research
// says complexity hurts, so only a tiny, relevant slice ever reaches a prompt.
//
// SAFETY: guardrails are only ever extracted from what the USER said in chat, never
// from the agent's transcript/output (the caller enforces this — detection runs on
// the [ME] turn only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(os.homedir(), ".claude", "interaction-layer", "guardrails.json");
const CAP = 20; // per tier; drop oldest beyond this

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { global: Array.isArray(o.global) ? o.global : [], projects: o.projects && typeof o.projects === "object" ? o.projects : {} };
  } catch {
    return { global: [], projects: {} };
  }
}
function save(o) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(o, null, 2));
  } catch {}
}
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

// Add a guardrail. scope: "global" | "project" (needs cwd). Deduped, capped.
export function addGuardrail(rule, scope, cwd) {
  const r = String(rule || "").trim();
  if (!r) return false;
  const o = load();
  const list = scope === "global" ? o.global : (o.projects[cwd] ||= []);
  if (list.some((x) => norm(x) === norm(r))) return false; // dedup
  list.push(r);
  if (list.length > CAP) list.splice(0, list.length - CAP);
  save(o);
  return true;
}

// Remove any guardrail matching (substring, case-insensitive) from both tiers.
export function forgetGuardrail(match, cwd) {
  const m = norm(match);
  if (!m) return 0;
  const o = load();
  let n = 0;
  const filt = (list) => list.filter((x) => (norm(x).includes(m) ? (n++, false) : true));
  o.global = filt(o.global);
  if (o.projects[cwd]) o.projects[cwd] = filt(o.projects[cwd]);
  save(o);
  return n;
}

export function listGuardrails(cwd) {
  const o = load();
  return { global: o.global, project: o.projects[cwd] || [] };
}

// The guardrails applicable to a project: global + this project's. Capped to a
// small slice (most-recent) so what reaches any single prompt stays tiny.
export function applicableGuardrails(cwd, limit = 6) {
  const o = load();
  const all = [...o.global, ...(o.projects[cwd] || [])];
  return all.slice(-limit);
}
