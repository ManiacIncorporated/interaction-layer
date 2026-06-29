// The conductor's RESEARCH brain — a tool-using sub-agent that builds
// "differentiated knowledge" the fast narrator lacks: it reads the actual
// literature and canonical reference implementations, then critiques the coding
// agent's current approach against them.
//
// Design points (hard-won):
// - It's a real `claude` process, so the caller MUST exclude its cwd-slug from the
//   MultiWatcher or the conductor will narrate its own research sub-agent.
// - INDEPENDENT-THEN-COMPARE: it forms its own view of canonical from fetched
//   sources BEFORE looking at the agent, so it critiques instead of validating.
// - GROUNDING is a hard rule: every claim from a fetched source, or marked
//   UNVERIFIED. Hallucinated citations are the signature failure of this feature.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A dedicated cwd per research run, so its transcript has a distinct slug the
// watcher can ignore. Caller computes slugFor(dir) and ignores it BEFORE spawning.
export function newResearchDir(id) {
  const dir = path.join(os.tmpdir(), `il-research-${id}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function buildPrompt(topic, context) {
  return [
    `You are a senior engineer doing a focused literature and reference-implementation review, to critically evaluate a teammate's current approach. The teammate is an AI coding agent.`,
    ``,
    `WHAT THE TEAMMATE IS CURRENTLY DOING:`,
    context || "(no context provided)",
    ``,
    `REVIEW TOPIC: ${topic}`,
    ``,
    `Do this, in order:`,
    `1. FIRST, independently establish the canonical / standard approach from PRIMARY SOURCES you actually fetch — the key paper(s) and the canonical reference implementation(s) on GitHub (fetch raw source files to see how it's really done). Form your OWN understanding before judging the teammate, so you don't just rubber-stamp their choices.`,
    `2. THEN compare the teammate's approach to canonical: what's consistent, what genuinely DIFFERS, and whether each difference is a known pitfall or a legitimate choice.`,
    `3. Be a critic, not a yes-man — but if the approach is consistent with the standard, SAY SO plainly. Do NOT manufacture a flaw to sound useful, and do NOT claim they're missing something they are actually doing.`,
    ``,
    `GROUNDING — HARD RULE: every paper, repo, arXiv ID, and factual claim MUST come from a source you actually fetched (WebSearch/WebFetch returned content). Anything from memory must be marked UNVERIFIED. Prefer saying "I couldn't verify this" over giving a plausible-sounding citation. Hallucinated citations are the worst possible outcome.`,
    ``,
    `OUTPUT — FIRST LINE EXACTLY one of:`,
    `  NOTABLE: yes   (the teammate's approach diverges from canonical in a way worth interrupting a busy teammate about)`,
    `  NOTABLE: no    (it's consistent with canonical, or only a minor/legitimate difference)`,
    `Then, on the following lines, a concise SPOKEN brief (read aloud; no markdown, ~4-6 sentences):`,
    `- the canonical approach and the source you grounded it in,`,
    `- how the teammate's approach compares (consistent, or differs — be specific),`,
    `- the single most important thing to double-check, if any.`,
  ].join("\n");
}

// Run a research pass. Calls onDone({ ok, brief } | { ok:false, error }) when the
// sub-agent finishes. Returns the child process (so the caller can kill it).
export function research({ topic, context, cwd, onDone }) {
  let out = "";
  let err = "";
  let child;
  try {
    child = spawn("claude", ["-p", buildPrompt(topic, context), "--allowedTools", "WebSearch WebFetch"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    onDone({ ok: false, error: "couldn't start the research agent" });
    return null;
  }
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", () => onDone({ ok: false, error: "couldn't start the research agent" }));
  child.on("close", (code) => {
    let brief = out.trim();
    if (code === 0 && brief) {
      // Split off the NOTABLE flag (gates asymmetric delivery); default to notable
      // if the model omitted it, so we don't silently swallow a real divergence.
      let notable = true;
      const m = brief.match(/^\s*NOTABLE:\s*(yes|no)\b[ \t]*\n?/i);
      if (m) {
        notable = /yes/i.test(m[1]);
        brief = brief.slice(m[0].length).trim();
      }
      onDone({ ok: true, brief, notable });
    } else {
      onDone({ ok: false, error: (err.split("\n").find(Boolean) || "research failed").slice(0, 120) });
    }
  });
  return child;
}
