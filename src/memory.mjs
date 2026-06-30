// The conductor's OWN persistent memory, per project — so on restart (or returning
// tomorrow) it isn't amnesiac. Distinct from the coding agent's CLAUDE.md/MEMORY.md.
//
// Two tiers, deliberately:
//  - research findings: durable, project-independent, expensive to recompute → keep.
//  - arc (story-so-far one-liners): past-tense narration history → reload into the
//    EXISTING [STORY SO FAR]/[ALREADY RESEARCHED] channels, which already say "don't
//    recite, just stay grounded". We do NOT persist the goal or "current blocker" as
//    assertable facts — those are session-local and recomputed from the live
//    transcript; persisting them is how memory becomes worse than no memory.
//
// Keyed by REPO ROOT (so a Codex/Claude restart in the same repo, and spawned
// worktrees, all share one memory). Atomic writes (temp + rename).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = path.join(os.homedir(), ".claude", "interaction-layer", "memory");
const ARC_CAP = 40;
const RESEARCH_CAP = 30;

// Map any cwd (incl. a linked worktree) to its main repo root, so memory persists
// across sessions and worktrees of the same project. Falls back to the cwd.
export function memoryKeyFor(cwd) {
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common) return path.dirname(common); // dirname of <repo>/.git → <repo>
  } catch {}
  return cwd;
}

const slug = (s) => String(s).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-90) || "root";
const fileForKey = (key) => path.join(DIR, slug(key) + ".json");

export function loadMemory(cwd) {
  try {
    const o = JSON.parse(fs.readFileSync(fileForKey(memoryKeyFor(cwd)), "utf8"));
    return {
      arc: Array.isArray(o.arc) ? o.arc : [],
      research: Array.isArray(o.research) ? o.research : [],
      researchedTopics: Array.isArray(o.researchedTopics) ? o.researchedTopics : [],
      updatedAt: o.updatedAt || 0,
    };
  } catch {
    return null;
  }
}

export function saveMemory(cwd, { arc = [], research = [], researchedTopics = [] }) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const f = fileForKey(memoryKeyFor(cwd));
    const tmp = `${f}.${process.pid}.tmp`;
    const data = {
      arc: arc.slice(-ARC_CAP),
      research: research.slice(-RESEARCH_CAP),
      researchedTopics: researchedTopics.slice(-RESEARCH_CAP),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, f); // atomic — never a half-written file clobbering a concurrent session
    return true;
  } catch {
    return false;
  }
}

export function forgetMemory(cwd) {
  try {
    fs.rmSync(fileForKey(memoryKeyFor(cwd)), { force: true });
    return true;
  } catch {
    return false;
  }
}
