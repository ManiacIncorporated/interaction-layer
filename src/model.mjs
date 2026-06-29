// The "interaction model": a lightweight observer that maintains a rolling
// world-model of what the coding agent is doing and answers the user's
// questions about it. Called infrequently (synthesis + Q&A), never per event.
//
// Backend is pluggable:
//   - "api": raw Anthropic Messages API (lean, fast, ~$0.001/call) if a key is
//            present in the environment.
//   - "sdk": Claude Agent SDK, reusing whatever auth Claude Code already has
//            (zero setup, heavier per call). Default.

const SYSTEM = `You are an experienced software engineer pair-watching a teammate work. The teammate is an AI coding agent, and you can see its private working stream — its thinking, the commands it runs, and the results. You speak to your human teammate sitting beside you, turning that raw stream into how one engineer briefs another.

You are watching LIVE and you receive the stream in chunks. EVERY reply you make has TWO parts: a private THINK line that is NEVER spoken aloud, then exactly one public line. Reply in EXACTLY this shape, nothing before or after:
  THINK: <one brief line of private reasoning — never spoken>
  <then exactly ONE of:>
  SAY: <one short spoken sentence, or PASS to stay silent>
  PROMPT: <a direct instruction to the coding agent>

How to choose the public line depends on the message tag:
- A message tagged [FEED] is NEW agent activity (NOT your teammate talking). THINK about how it relates to what you LAST said — does it continue, change, make your last point moot, or CONTRADICT it? Then SAY one short reaction — if it contradicts what you said, correct yourself out loud ("actually, scratch that — the real cause is…"); otherwise build on it. Use SAY: PASS for routine continuation with nothing genuinely new.
  You may instead reply RESEARCH: <a specific question> when the agent makes a CONSEQUENTIAL, checkable technical choice about a named algorithm or a non-obvious approach that has canonical papers / reference implementations — especially when getting it wrong would matter (e.g. "is reusing one Hessian across all layers how GPTQ actually works?", "does the canonical speculative-decoding accept step use this criterion?"). For these, PREFER RESEARCH over asserting from memory — the whole point is grounding in the real paper/reference code; your memory can be wrong or out of date. In particular, BEFORE you SAY that the agent's approach is wrong, non-standard, or a mistake on a consequential technical point, RESEARCH to ground that critique first — an unfounded critique can cause bad steering, so verify before you criticize (then deliver the grounded verdict). Like a sharp teammate who says "wait, let me check how the reference implementation does this." BUT only for genuinely consequential, checkable choices you have NOT already checked ([ALREADY RESEARCHED]); NEVER for routine work (renames, tests, plumbing, standard CRUD, config) or vague/taste matters with no canonical reference — there, SAY or PASS. (A [FEED] never produces a PROMPT.)
- A message tagged [ME] is your teammate speaking to you, with the whole live picture as context. THINK about what they want, then:
  • SAY: <your spoken answer> — when they're asking about THE AGENT'S WORK or the project: status, approach, "what's the fix?", "is it on track?", "what's the original goal", "how would you handle that?". You EXPLAIN. (These become part of the running commentary.)
  • ASIDE: <your spoken answer> — when the question is NOT about the agent's current work: the time, general knowledge, a tangent, chit-chat, or a question about you. Answer it the same, but it's a side note that should NOT be woven into your commentary about the agent. When unsure between SAY and ASIDE, prefer SAY.
  • PROMPT: <the instruction to deliver to the agent> — when they want the EXISTING agent to DO or CHANGE something ("fix it", "tell it to…", "have it…", "add…", "also…"). Your PROMPT is genuinely DELIVERED to the agent. Rewrite their words into a clear, SCOPED, SHORT instruction. The research on coding agents is clear: terse GUARDRAILS beat elaborate guidance, and prompt complexity HURTS — so never produce a role/checklist/"comprehensive" prompt. Rules:
    – SIZE-GATE: already specific ("rename getUser to fetchUser") → relay almost verbatim, no padding. Only expand the part that's genuinely vague.
    – When you expand, prefer in order: an imperative; the specific file/function IF it appears in the context above; a GUARDRAIL ("keep it focused — don't refactor unrelated code or weaken tests to make it pass"); a VERIFY step ("then run the narrowest relevant test"); for risky changes, "handle the obvious error/edge cases." Guardrails + a real verification step are the high-leverage moves users skip. Do NOT add positive style pep-talk ("follow the existing style") — evidence says it doesn't help.
    – GROUNDING (hard rule): never state a specific the user didn't say and you can't see — no invented file paths, test commands, acceptance criteria, or requirements. If unknown, stay general and let the agent (it has the repo) work it out.
    – FAITHFUL: sharpen HOW/WHERE, never add WHAT/WHY. "add error handling" → "add error handling to the fetch in api.js it's editing; keep it focused; then run the relevant test" — good. Bolting on retries/logging/etc they never asked — not.
  • SPAWN: <the task for a brand-new agent> — ONLY when they explicitly ask to create a NEW or SEPARATE agent: "spawn…", "spin up…", "start a new/separate agent to…", "kick off an agent on…", "fire up an agent for…". This launches a fresh coding agent in its own worktree. It is NOT for steering the existing one.
  • RESEARCH: <the topic/question to research> — when they want you to look something up to critique the work with outside knowledge: "research…", "how does this compare to the canonical/standard implementation", "what does the literature/paper say", "find the reference implementation", "is this the right approach". This runs a background literature + reference-code review.
  Distinguish by GRAMMAR, not topic: a question is SAY; a command to the current agent is PROMPT; only an explicit "new/separate agent" request is SPAWN. When unsure between PROMPT and SPAWN, choose PROMPT (steering the existing agent is cheaper than spawning a wrong one). When unsure between SAY and a command, prefer SAY.
LEARNED GUARDRAILS: if [ME] also expresses a DURABLE preference for how the agent should work — ESPECIALLY a correction or objection to something just done ("no, don't touch the config", "why'd you add a dependency", "stop refactoring everything", "don't ever force-push"), or an explicit "always/never/from now on" — then IN ADDITION to your normal reply, append a FINAL separate line in the form GUARDRAIL: <the preference as a concise negative constraint>. Only for genuinely durable preferences a teammate would want applied to FUTURE tasks — never for one-off task details ("rename this"). Most turns have NO GUARDRAIL line. (A line tagged [GUARDRAILS] in the context is the user's standing preferences — fold the relevant ones into any PROMPT you relay; never recite them.) If instead [ME] CONTRADICTS or overrides one of the [GUARDRAILS] (they now want exactly what a standing guardrail forbids), RELAY WHAT THEY ACTUALLY ASKED — a direct current instruction overrides a standing guardrail — and append a FINAL line in the form UNGUARDRAIL: <the standing guardrail it contradicts, copied closely> so the now-stale rule can be dropped. Never emit both GUARDRAIL and UNGUARDRAIL for the same thing.

Because it's live, newer activity will keep arriving and will interrupt you constantly. Work WITH that, don't fight it:
- Never try to be complete or to summarize everything. Say the single most useful NEW thing right now in ONE short spoken sentence, then stop — you'll get another turn in a moment. Only add a second sentence if it's genuinely essential; never a third. Brevity is what lets you pivot smoothly as new things happen.
- NEVER promise a future follow-up or announce intent to speak — no "let me see the full breakdown before I translate", "I'll explain in a moment", "I'll get back to you", "hold on", "let me read this first". You can't count on a clean next turn (newer activity, or another agent you're also watching, may take it), so the promise goes unfulfilled and you sound like you dropped it. Instead: if you have something useful NOW, say it now; if you're waiting for more output, just PASS silently and say it on a later beat once you actually have it. Don't narrate that you're about to do something — only narrate the thing itself, when it's ready.
- Build on what you've already said (it's in the conversation above). Never repeat a point you've already made.
- If newer data changes or contradicts what you said, just correct it naturally on your next turn ("actually, that test did fail").
- Default to staying quiet. For a [FEED] chunk that's only routine continuation — opening a file, a command running, nothing genuinely new — use SAY: PASS. Speak only for a real development: a new hypothesis, a decision it made, a surprising result, a change of direction, or a blocker.
- A [METRICS] line is AMBIENT reference about pace and iteration (edits, test runs, errors, churn). Don't recite it. Mention pace only when it's genuinely notable as a teammate would — real churn (same file edited many times, failures piling up) or a [note] saying it's gone quiet. Steady varied progress is NOT worth a "you're spending a while" remark; lots of test runs during normal TDD is fine. When in doubt, PASS.
- You ALSO get ambient grounding you must NOT recite: [GOAL] is the original task (use it to keep the bigger objective in mind and to answer "what were we trying to do" — but discovering the real problem lies elsewhere is good engineering, so only remark on drifting from the goal if it's genuinely worth flagging, never as scolding); [CLOCK] is relational time (use "this build's been running a while" or "an hour in and still on the first part" only when it matters — never announce the wall-clock or "47 minutes in" as a readout); [STORY SO FAR] is the longer arc of what you've already said, so you can speak to long horizons and not repeat yourself; [ALREADY RESEARCHED] lists topics you've already investigated — do NOT RESEARCH these again, just use what you learned. Like the others: these inform your judgment, they are not things to read out.

Translate, don't transcribe. Decode the agent's private jargon and bare numbers into plain language a colleague would actually say out loud. You don't write the code yourself — your job is to watch and explain, and to relay your teammate's intent to the agent (via PROMPT) when they want something changed. Voice: natural, spoken, concise. Never use markdown, lists, or headings.`;

// Render recent events into a compact textual log for the model.
export function renderLog(events) {
  return events
    .map((e) => {
      switch (e.kind) {
        case "thinking":
          return `[thinking] ${trunc(e.text, 700)}`;
        case "assistant_say":
          // The agent's message TO THE USER is the prime thing we translate — give it
          // real headroom. Clipping it to a sentence made the narrator think a long
          // explanation was still mid-generation ("let me see the full breakdown…").
          return `[agent→user] ${trunc(e.text, 2000)}`;
        case "user_say":
          return `[user→agent] ${trunc(e.text, 300)}`;
        case "tool_use":
          return `[action] ${e.tool} ${trunc(JSON.stringify(e.input), 200)}`;
        case "tool_result":
          return `[result${e.isError ? " ERROR" : ""}] ${trunc(e.text, 200)}`;
        case "meta":
          return `[note] ${trunc(e.text, 200)}`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function trunc(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Parse a think-then-(say|prompt) reply used by BOTH narration and Q&A. Returns
// { action: "answer"|"prompt", text, think } — text "" with action "answer" means
// stay quiet (PASS / nothing to say).
// FAIL-SAFE: the private THINK reasoning must NEVER reach the speaker. We only
// ever return as `text` the content AFTER a SAY:/PROMPT:/ANSWER: marker. If the
// model reasoned (THINK present) but marked no surface line, we say nothing. A
// reply with no markers at all has nothing private to leak, so it's spoken as-is.
export function parseReply(out) {
  const s = (out || "").trim();
  // guardrail (learn) / unguardrail (revoke) are side-channels alongside the action.
  return { ..._parseAction(s), guardrail: guardrailOf(s), unguardrail: unguardrailOf(s) };
}
function _parseAction(s) {
  // Spawn / steer markers take precedence — capture everything after the marker.
  const spawnM = s.match(/(?:^|\n)\s*SPAWN:\s*([\s\S]*)$/i);
  if (spawnM) return { action: "spawn", text: stripTrailingMarkers(spawnM[1]), think: thinkOf(s) };
  const researchM = s.match(/(?:^|\n)\s*RESEARCH:\s*([\s\S]*)$/i);
  if (researchM) return { action: "research", text: stripTrailingMarkers(researchM[1]), think: thinkOf(s) };
  const asideM = s.match(/(?:^|\n)\s*ASIDE:\s*([\s\S]*)$/i);
  if (asideM) {
    const t = stripTrailingMarkers(asideM[1]);
    return { action: "aside", text: !t || /^PASS\b/i.test(t) ? "" : t, think: thinkOf(s) };
  }
  const prompt = s.match(/(?:^|\n)\s*PROMPT:\s*([\s\S]*)$/i);
  if (prompt) return { action: "prompt", text: stripTrailingMarkers(prompt[1]), think: thinkOf(s) };
  // Spoken surface: SAY: (narration/answer) or ANSWER: (legacy alias).
  const say = s.match(/(?:^|\n)\s*(?:SAY|ANSWER):\s*([\s\S]*)$/i);
  if (say) {
    const text = stripTrailingMarkers(say[1]);
    return { action: "answer", text: !text || /^PASS\b/i.test(text) ? "" : text, think: thinkOf(s) };
  }
  // No surface marker. If it reasoned but didn't mark the line, stay silent rather
  // than risk speaking the reasoning.
  if (/\bTHINK:/i.test(s)) return { action: "answer", text: "", think: s };
  // No markers at all → nothing private to leak; speak it unless it's PASS.
  // (strip a trailing GUARDRAIL line if the model appended one bare.)
  const bare = stripTrailingMarkers(s);
  return { action: "answer", text: !bare || /^PASS\b/i.test(bare) ? "" : bare, think: "" };
}

// A durable-preference candidate the model may append (one line). Extracted only
// from the user's own [ME] turn — never persisted without confirmation.
function guardrailOf(s) {
  const m = String(s || "").match(/(?:^|\n)\s*GUARDRAIL:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}
// A standing guardrail the user just contradicted/overrode → offer to drop it.
function unguardrailOf(s) {
  const m = String(s || "").match(/(?:^|\n)\s*UNGUARDRAIL:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}
function thinkOf(s) {
  const m = s.match(/THINK:\s*([\s\S]*?)(?=\n\s*(?:SAY|ANSWER|PROMPT|SPAWN|RESEARCH|ASIDE|GUARDRAIL|UNGUARDRAIL):|$)/i);
  return (m?.[1] || "").trim();
}
function stripTrailingMarkers(t) {
  // If a marker body accidentally runs into a later one, keep only the first
  // (so e.g. a trailing GUARDRAIL line never bleeds into the spoken/relayed text).
  return t.split(/\n\s*(?:SAY|ANSWER|PROMPT|SPAWN|RESEARCH|ASIDE|GUARDRAIL|UNGUARDRAIL):/i)[0].trim();
}

import os from "node:os";

const MODEL = process.env.IL_MODEL || "claude-haiku-4-5";
// Output ceiling. Narration is one short line (bounded by the prompt), but a relayed
// PROMPT — the research-backed expansion with file refs, a guardrail, and a verify
// step — runs longer; 200 truncated those mid-sentence and sent the partial. 600
// gives the relay ample headroom without making narration verbose.
const MAX_TOKENS = Number(process.env.IL_MAX_TOKENS) || 600;

// Combine an external abort signal with a hard timeout, so generation can be
// cancelled by barge-in/supersede AND never hangs forever.
function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// The sdk backend spawns a Claude Code sub-session per call; keep its transcript
// OUT of the user's project dir (else it pollutes the dir and the session watcher
// mistakes it for a new session). Belt: also skip history writes.
process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY ||= "1";

// Each backend takes a conversation (array of {role, content}) plus the shared
// SYSTEM and returns the reply. A multi-turn convo lets the narrator see its own
// prior turns (continuity, no self-repeat) and lets servers reuse the KV cache
// for the shared prefix where they support it.

// --- raw API backend (lean + fast: ~1s) ---
let _client; // reuse one client across calls
async function apiClient() {
  if (_client !== undefined) return _client;
  const { default: Anthropic } = await import("@anthropic-ai/sdk").catch(() => ({}));
  _client = Anthropic ? new Anthropic() : null;
  return _client;
}
async function respondApi(messages, { signal } = {}) {
  const client = await apiClient();
  if (!client) throw new Error("@anthropic-ai/sdk not installed");
  const r = await client.messages.create(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Cache the (stable) system prompt; the growing convo prefix is reused by
      // the server's prefix cache where available.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    },
    { signal }
  );
  return r.content.map((b) => b.text || "").join("").trim();
}

// --- Baseten backend: GLM 5.2 via the OpenAI-compatible Model API (needs BASETEN_API_KEY) ---
async function respondBaseten(messages, { signal } = {}) {
  const key = process.env.BASETEN_API_KEY;
  if (!key) throw new Error("BASETEN_API_KEY not set");
  const res = await fetch("https://inference.baseten.co/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.IL_BASETEN_MODEL || "zai-org/GLM-5.2",
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
    }),
    signal: withTimeout(signal, 20000),
  });
  if (!res.ok) throw new Error(`baseten ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

// --- Agent SDK backend (reuses Claude Code auth; heavier ~4-9s) ---
// No native multi-turn here — flatten the convo into one prompt (fallback only).
function flatten(messages) {
  return messages
    .map((m) => (m.role === "assistant" ? `[you, earlier]\n${m.content}` : m.content))
    .join("\n\n");
}
async function respondSdk(messages, { signal } = {}) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const q = query({
    prompt: flatten(messages),
    options: {
      model: MODEL,
      systemPrompt: SYSTEM,
      settingSources: [],
      allowedTools: [],
      maxTurns: 1,
      abortController: ac,
      cwd: os.tmpdir(), // keep sub-session transcripts out of the user's project
    },
  });
  for await (const m of q) {
    if (m.type === "result") return (m.result || "").trim();
  }
  return "";
}

const RESPONDERS = { api: respondApi, baseten: respondBaseten, sdk: respondSdk };

// --- Streaming variants: yield text deltas as they generate, so the caller can
// speak the first sentence before the rest is written. ---
async function* streamBaseten(messages, { signal } = {}) {
  const key = process.env.BASETEN_API_KEY;
  if (!key) throw new Error("BASETEN_API_KEY not set");
  const res = await fetch("https://inference.baseten.co/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.IL_BASETEN_MODEL || "zai-org/GLM-5.2",
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
    }),
    signal: withTimeout(signal, 20000),
  });
  if (!res.ok) throw new Error(`baseten ${res.status}`);
  let buf = "";
  for await (const part of res.body) {
    buf += Buffer.from(part).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d === "[DONE]") return;
      try {
        const t = JSON.parse(d).choices?.[0]?.delta?.content;
        if (t) yield t;
      } catch {}
    }
  }
}

async function* streamApi(messages, { signal } = {}) {
  const client = await apiClient();
  if (!client) throw new Error("@anthropic-ai/sdk not installed");
  const stream = client.messages.stream(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    },
    { signal }
  );
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield ev.delta.text;
  }
}

// The Agent SDK has no easy token stream here — yield the full result once.
async function* streamSdk(messages, { signal } = {}) {
  yield await respondSdk(messages, { signal });
}

const STREAMERS = { api: streamApi, baseten: streamBaseten, sdk: streamSdk };

export class InteractionModel {
  constructor({ backend } = {}) {
    // Resolved lazily by init(): forced via arg/IL_BACKEND, else "auto".
    this.forced = backend || process.env.IL_BACKEND || null;
    this.backend = this.forced || "auto";
    this.fellBack = false;
    // Note: the "what the human's been told" brief is per-watched-agent state,
    // owned by each WatchedAgent's persistent convo (narrate()/converse()), so one
    // shared model can serve many agents without cross-talk.
  }

  // Decide which backend to use. Order in auto mode: baseten (GLM 5.2) if a
  // Baseten key is configured → api (Claude Haiku, needs Anthropic auth) → sdk
  // (always available, reuses Claude Code auth). Each candidate is probed once;
  // the first that succeeds wins.
  async init() {
    if (this.forced) {
      this.backend = this.forced;
      return this.backend;
    }
    const candidates = [];
    if (process.env.BASETEN_API_KEY) candidates.push("baseten");
    candidates.push("api");
    for (const c of candidates) {
      try {
        await RESPONDERS[c]([{ role: "user", content: "Reply with: ok" }]);
        this.backend = c;
        return this.backend;
      } catch {
        /* try next */
      }
    }
    this.backend = "sdk";
    this.fellBack = true;
    return this.backend;
  }

  // Send a full conversation (array of {role, content}). SYSTEM is added by the
  // backend. Degrades to the always-available sdk on a mid-session failure — but
  // NOT on a deliberate abort (barge-in / supersede), or the cancelled work would
  // just re-run on the slow backend.
  async _sendMessages(messages, { signal } = {}) {
    if (this.backend === "auto") await this.init();
    if (this.backend === "sdk") return respondSdk(messages, { signal });
    try {
      return await RESPONDERS[this.backend](messages, { signal });
    } catch (e) {
      if (signal?.aborted || this.forced) throw e;
      this.backend = "sdk";
      this.fellBack = true;
      return respondSdk(messages, { signal });
    }
  }

  // Convenience for single-shot string prompts (resolveAgent).
  _send(userMessage) {
    return this._sendMessages([{ role: "user", content: userMessage }]);
  }

  // Proactive narration as a LIVE conversation. The caller (WatchedAgent) owns
  // the running `convo` and passes the whole thing — its prior [FEED]/narration
  // turns plus a candidate [FEED] turn of the newest events — so the model sees
  // what it already said (continuity, no self-repeat) instead of a lossy brief.
  // Returns the spoken line, or "" to stay quiet (PASS). The caller decides
  // whether to commit the candidate+reply pair (only on a real line).
  async narrate(messages, { signal } = {}) {
    const out = (await this._sendMessages(messages, { signal })).trim();
    // {action: "answer"|"research", text, think}. "answer" text "" = PASS.
    return parseReply(out);
  }

  // Stream text deltas for a full conversation from the active backend.
  async *stream(messages, { signal } = {}) {
    if (this.backend === "auto") await this.init();
    const gen = STREAMERS[this.backend] || streamSdk;
    yield* gen(messages, { signal });
  }

  // Resolve WHICH watched agent the user is addressing. `roster` is
  // [{ label, gist }] — one line of what each agent was last doing. Matches on
  // CONTENT/topic, not just names ("the quantization agent" → the project whose
  // work is about quantization). Returns the chosen label, or "STAY" (a follow-up
  // about the current focus), or "ASK" (genuinely ambiguous — caller should ask).
  async resolveAgent(utterance, roster, focusLabel) {
    const list = roster.map((r) => `- ${r.label}: ${r.gist}`).join("\n");
    const msg =
      `Several coding agents are being watched. Here's the latest each was doing:\n${list}\n\n` +
      (focusLabel ? `The user is currently focused on: ${focusLabel}\n\n` : "") +
      `The user just said: "${utterance}"\n\n` +
      `Which agent are they talking about? Match on topic/content, not just the name — ` +
      `e.g. "the quantization agent" means whichever project's work is about quantization. ` +
      `Reply with EXACTLY one of:\n` +
      `- the agent's label (copy it verbatim) if they single out a specific one\n` +
      `- STAY if they don't single out a different agent — a follow-up about the current focus, ` +
      `OR a generic question that names no agent at all ("what's the status?")\n` +
      `- ASK only if they clearly DO mean a specific agent but it's unclear which one (their words fit two or more)\n` +
      `- NONE if they clearly name a specific agent that is NOT in the list above\n` +
      `Reply with only the label, STAY, ASK, or NONE — nothing else.`;
    const out = (await this._send(msg)).trim().replace(/^["'`]|["'`.]$/g, "");
    const hit = roster.find((r) => r.label.toLowerCase() === out.toLowerCase());
    if (hit) return hit.label;
    if (/^stay$/i.test(out)) return "STAY";
    if (/^none$/i.test(out)) return "NONE";
    return "ASK";
  }

  // Respond to a [ME] turn already appended to `messages` (the full live convo).
  // The SYSTEM protocol makes the model reply THINK then SAY: (speak) or PROMPT:
  // (relay to the agent). We collect the full reply, then parse — so the private
  // THINK reasoning is stripped and can NEVER be spoken, even if the model leads
  // with it. Abortable via `signal` (barge-in / a newer utterance superseding).
  // Returns { action: "answer"|"prompt", text, think }.
  async converse(messages, { signal } = {}) {
    let full = "";
    try {
      for await (const delta of this.stream(messages, { signal })) full += delta;
    } catch (e) {
      if (signal?.aborted) throw e; // superseded/barged — don't fall back, let caller drop it
      if (!full.trim()) {
        // Stream errored before producing anything → non-streaming fallback.
        try {
          full = await this._sendMessages(messages, { signal });
        } catch (e2) {
          if (signal?.aborted) throw e2;
        }
      }
    }
    return parseReply(full);
  }
}
