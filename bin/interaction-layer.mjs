#!/usr/bin/env node
// Interaction layer for Claude Code — a voice "awareness" sidecar.
//
// One sidecar can watch MANY Claude Code sessions at once. Run it with no
// argument and it discovers every project where `claude` is running (via the
// SessionStart hook's pointer files) and narrates them all through one voice,
// labelling each by project. Pass a project dir to watch only that one.
//
//   node bin/interaction-layer.mjs            # watch ALL active sessions (multi)
//   node bin/interaction-layer.mjs <dir>      # watch only that project (single)
//
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { slugFor } from "../src/transcript.mjs";
import { SessionWatcher, MultiWatcher, POINTER_DIR } from "../src/session.mjs";
import { WatchedAgent } from "../src/agent.mjs";
import { Voice } from "../src/voice.mjs";
import { Mic } from "../src/mic.mjs";
import { transcribe, partial as sttPartial, warm as warmStt, sttAvailable, sttProblem, stop as stopStt } from "../src/stt.mjs";
import { sendToClaude } from "../src/inject.mjs";
import { spawnAgent, repoRootOf } from "../src/spawn.mjs";
import { research, newResearchDir } from "../src/research.mjs";
import { addGuardrail, forgetGuardrail, listGuardrails, applicableGuardrails } from "../src/guardrails.mjs";
import { InteractionModel, renderLog } from "../src/model.mjs";

// Push-to-talk: hold Right Option (⌥) to talk. The mic only runs while held.
const VOICE_IN = !process.argv.includes("--no-voice-in");
const HERE = path.dirname(fileURLToPath(import.meta.url));
// How long to let a burst of agent activity settle before the peer voice
// considers whether there's something worth saying. Short = responsive.
const NARRATE_MS = (Number(process.env.IL_NARRATE_SECS) || 1.5) * 1000;
// By default the spoken voice is reserved for peer-level reasoning; low-level
// actions ("reading X") show only in the text feed. --speak-actions voices them too.
const SPEAK_ACTIONS = process.argv.includes("--speak-actions");

// Mode: a project dir argument => single mode (legacy). No argument => multi
// mode: watch every active session and label each by project.
const ARG = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
const MULTI = !ARG;
const singleCwd = ARG ? path.resolve(ARG) : null;

// ---- single-instance lock (atomic) ----
// Multi mode: ONE global sidecar (sidecar.running). Single mode: one per project
// (so a per-project hook launch and a manual run never duplicate). Claimed with
// O_EXCL so simultaneous SessionStart hooks (e.g. three cmux panes at once) can't
// race two sidecars into existence.
fs.mkdirSync(POINTER_DIR, { recursive: true });
const LOCK = path.join(POINTER_DIR, MULTI ? "sidecar.running" : slugFor(singleCwd) + ".running");
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function claimLock() {
  for (let i = 0; i < 5; i++) {
    try {
      const fd = fs.openSync(LOCK, "wx"); // O_EXCL: fails if it exists
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let owner = 0;
      try {
        owner = Number(String(fs.readFileSync(LOCK, "utf8")).replace(/\D/g, ""));
      } catch {}
      if (owner && owner !== process.pid && alive(owner)) return false; // someone owns it
      try {
        fs.unlinkSync(LOCK); // stale (dead pid / launching marker) — take over
      } catch {}
    }
  }
  return false;
}
if (!claimLock()) {
  console.error(`Another interaction layer is already running${MULTI ? "" : ` for ${singleCwd}`}.`);
  process.exit(0);
}
// We own the run lock now; clear any stale launch marker the hook left for us.
try {
  fs.unlinkSync(path.join(POINTER_DIR, "sidecar.launching"));
} catch {}

const mic = VOICE_IN ? new Mic() : null;
const model = new InteractionModel();

// Conversation mode (GLOBAL): while true every agent keeps PERCEIVING but ALL
// narration voices are suppressed so nothing talks over you while you converse.
// Entered by barge-in or a typed/dictated line; left once the answer finishes
// (or after a quiet timeout if you never actually addressed us).
let conversing = false;
let awaitingAnswer = false; // an answer is queued/speaking; end when it finishes
let resumeTimer = null;
let conversingSince = 0;
let turnSeq = 0; // monotonic; each spoken/typed utterance supersedes the prior
let answerAbort = null; // aborts the in-flight answer generation
let pendingSpawn = null; // a spawn awaiting your spoken confirmation ({task, cwd})
let pendingAsk = null; // the original question, kept while we ask you "which agent?"
let pendingGuardrail = null; // a learned-preference candidate awaiting your confirm ({rule, cwd})
// Autonomous research throttle. in-flight=1 is the real cost cap (each run is
// 1-2 min, so one slot ≈ ≤1 research/1-2 min); a session ceiling backstops it.
const AUTO_RESEARCH = process.env.IL_AUTO_RESEARCH !== "0";
const RESEARCH_MAX = Number(process.env.IL_RESEARCH_MAX) || 15;
let researchInFlight = false;
let researchCount = 0;
function enterConversation() {
  conversing = true;
  awaitingAnswer = false;
  conversingSince = Date.now();
  voice.flush(); // barge-in: stop speaking immediately
  // Barge-in aborts in-flight generation too: every agent's narration, and any
  // answer currently being produced. (Correctness still rests on the post-await
  // guards; abort is the latency win.)
  for (const ag of agents.values()) ag.interrupt();
  answerAbort?.abort();
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(endConversation, 9000); // auto-resume if no question lands
}
function endConversation() {
  conversing = false;
  awaitingAnswer = false;
  clearTimeout(resumeTimer);
}
// Watchdog: narration must NEVER stay suppressed indefinitely; and check for
// agents that have gone quiet (the absence-of-events the event stream can't show).
setInterval(() => {
  if (conversing && !voice.isBusy() && Date.now() - conversingSince > 35_000) {
    endConversation();
  }
  if (!conversing) for (const ag of agents.values()) ag.checkStall();
}, 5_000);

// When the *answer* finishes speaking, leave conversation mode (resume narrating).
const voice = new Voice({
  onSpeaking: (on) => {
    if (on) return;
    if (awaitingAnswer) endConversation();
    // MANDATORY retrigger: narration beats defer while the voice is busy (one
    // mouth). When it frees up, wake every agent still holding events — this is
    // the only thing that drains what piled up DURING speech, so they deliver one
    // consolidated update. Without it, those events would wait for a new event.
    if (!conversing) for (const ag of agents.values()) if (ag.pending.length) ag.scheduleNarrate();
  },
});

// ---- watched agents ----
const agents = new Map(); // slug -> WatchedAgent
let focused = null; // the agent the human is addressing (whoever we last spoke about)
let greeted = false; // gate the startup greeting so bulk discovery doesn't storm

// Shared context handed to every WatchedAgent.
const ctx = {
  narrateMs: NARRATE_MS,
  speakActions: SPEAK_ACTIONS,
  isConversing: () => conversing,
  isHolding: () => holding,
  log: (s) => console.log(s),
  onSpoke: (agent) => {
    focused = agent;
    agent.lastSpokeAt = Date.now();
  },
  requestResearch: (agent, question) => maybeAutoResearch(agent, question),
};

// The aware critic asked itself a question. Apply the guards: off-switch, the
// model-judged dedup (also a normalized string backstop), in-flight=1, and the
// session ceiling. Register the topic immediately so subsequent beats see it in
// [ALREADY RESEARCHED] and don't re-ask.
function maybeAutoResearch(ag, question) {
  if (!AUTO_RESEARCH || !question) return;
  const key = question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (ag._researchKeys?.has(key)) return; // backstop dedup
  if (researchInFlight) return; // one at a time — the real cost cap
  if (researchCount >= RESEARCH_MAX) {
    if (!ag._researchCapLogged) {
      ag._researchCapLogged = true;
      console.log(`   (auto-research session cap of ${RESEARCH_MAX} reached — pausing)`);
    }
    return;
  }
  (ag._researchKeys ||= new Set()).add(key);
  ag.researchedTopics.push(question); // model-judged dedup context
  researchInFlight = true;
  researchCount++;
  runResearch(ag, question, { auto: true });
}

function labelFor(cwd) {
  return MULTI ? cwd.split("/").filter(Boolean).pop() || cwd : "";
}

function addAgent({ slug, cwd, file, stale }) {
  let ag = agents.get(slug);
  if (!ag) {
    ag = new WatchedAgent({ slug, cwd, label: labelFor(cwd), voice, model, ctx });
    agents.set(slug, ag);
  }
  ag.attach(file, { stale });
  // Don't pin focus to discovery order — targetAgent()/pickFocus() chooses the
  // most-recently-active agent (lastSpokeAt is seeded from transcript mtime).
  announceAdd(ag, stale);
}

function announceAdd(ag, stale) {
  if (!MULTI) {
    voice.say("Interaction layer attached. I'm watching the agent now.");
    return;
  }
  if (!greeted) return; // initial bulk discovery → one summary greeting instead (below)
  voice.say(`Now also watching ${ag.label}.`, { priority: "low" });
}

function removeAgent(slug) {
  const ag = agents.get(slug);
  if (!ag) return;
  ag.close();
  agents.delete(slug);
  console.log(`\n👋 ${ag.label ? `[${ag.label}] ` : ""}session ended — stopped watching.`);
  if (focused === ag) focused = pickFocus();
  if (MULTI && greeted) voice.say(`${ag.label} finished — no longer watching it.`, { priority: "low" });
}

// Who do voice/typed messages address? Whoever we last spoke about; failing that,
// the most-recently-active watched agent. Never null unless nothing is watched.
function pickFocus() {
  let best = null;
  for (const ag of agents.values()) {
    if (!best || ag.lastSpokeAt > best.lastSpokeAt) best = ag;
  }
  return best;
}
function targetAgent() {
  if (focused && agents.has(focused.slug)) return focused;
  return (focused = pickFocus());
}

console.log(`🎧 Interaction layer`);
console.log(MULTI ? `   watching: all active Claude sessions` : `   project: ${singleCwd}`);
console.log(
  `   voice: ${voice.describe()}${
    voice.engine === "say" && voice.voice === "Samantha"
      ? "  (set ELEVENLABS_API_KEY or download a Premium voice for a nicer one)"
      : ""
  }`
);
console.log(
  `\nType or dictate a question + Enter. Any key hushes the narrator (barge-in); Esc just hushes.`
);
if (VOICE_IN) console.log(`Or hold Right Option (⌥) to push-to-talk — or tap an AirPod (play/pause) to toggle.`);
console.log(`Commands: /agents  /focus <name>  /research <topic>  /guardrails  /mute  /unmute  /quit\n`);

// ---- session discovery ----
let watcher;
if (MULTI) {
  watcher = new MultiWatcher();
  watcher.on("add", (info) => addAgent(info));
  watcher.on("switch", ({ slug, cwd, file }) => {
    const ag = agents.get(slug);
    if (ag) ag.attach(file, { switched: true });
    else addAgent({ slug, cwd, file });
  });
  watcher.on("remove", ({ slug }) => removeAgent(slug));
  watcher.start();
  if (!agents.size) {
    console.log(`⏳ No active Claude session yet — watching…\n   (start \`claude\` anywhere and I'll attach automatically)`);
  }
  // One settled greeting after the initial bulk discovery, then per-add chatter.
  setTimeout(() => {
    greeted = true;
    const n = agents.size;
    if (n === 0) return;
    voice.say(
      n === 1
        ? `Interaction layer up. Watching ${[...agents.values()][0].label}.`
        : `Interaction layer up. Watching ${n} agents.`
    );
  }, 1500);
} else {
  const slug = slugFor(singleCwd);
  watcher = new SessionWatcher(singleCwd);
  watcher.on("waiting", () =>
    console.log(
      `⏳ No active Claude session for this project yet — watching…\n   (start \`claude\` in ${singleCwd} and I'll attach automatically)`
    )
  );
  watcher.on("attach", ({ file, stale }) => addAgent({ slug, cwd: singleCwd, file, stale }));
  watcher.on("switch", ({ file }) => {
    const ag = agents.get(slug);
    if (ag) ag.attach(file, { switched: true });
    else addAgent({ slug, cwd: singleCwd, file });
  });
  watcher.start();
  greeted = true;
}

// Resolve the interaction-model backend (auto: baseten/GLM → api/Haiku → sdk).
const BACKEND_LABEL = {
  baseten: "baseten · GLM 5.2 (fast)",
  api: "Claude Haiku via API (fast, ~1s)",
  sdk: "Claude Haiku via Agent SDK (~4-9s)",
};
model
  .init()
  .then((backend) => {
    console.log(`🧠 interaction model: ${BACKEND_LABEL[backend] || backend}`);
    if (model.fellBack) {
      console.log(`   for ~1s replies: set BASETEN_API_KEY (GLM 5.2) or ANTHROPIC_API_KEY, then restart`);
    }
  })
  .catch((e) => logErr("init", e));

function humanList(xs) {
  if (xs.length <= 1) return xs[0] || "";
  return xs.slice(0, -1).join(", ") + " or " + xs[xs.length - 1];
}

// Resolve WHICH watched agent an utterance addresses. Single agent → that one.
// Otherwise: a label named outright wins (fast-path); else a content-based model
// call maps topic→agent ("the quantization agent" → llm-compression), with STAY
// for follow-ups and "ASK" when genuinely ambiguous.
async function resolveTarget(q) {
  const list = [...agents.values()];
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const u = norm(q);
  const named = list.filter((a) => a.label && norm(a.label).length >= 3 && u.includes(norm(a.label)));
  if (named.length === 1) return named[0];
  const roster = list.map((a) => ({ label: a.label, gist: a.gist() }));
  const focusLabel = focused && agents.has(focused.slug) ? focused.label : null;
  let res;
  try {
    res = await model.resolveAgent(q, roster, focusLabel);
  } catch {
    res = "STAY";
  }
  if (res === "ASK" || res === "NONE") return res;
  if (res === "STAY") return targetAgent();
  return list.find((a) => a.label === res) || targetAgent();
}

// Answer a spoken/typed message. Resolves which agent it's about, appends it to
// THAT agent's live conversation as a [ME] turn, and replies (ANSWER spoken, or
// PROMPT relayed to Claude) grounded in the agent's full convo.
//
// Interactivity guards (the load-bearing part): each call takes a monotonic
// `turnSeq`; a newer utterance aborts the prior one's generation AND invalidates
// its commit/speech via a post-await `mySeq === turnSeq` recheck. So talking over
// yourself supersedes cleanly instead of double-speaking or corrupting the convo.
async function answer(q, forcedAgent = null) {
  const mySeq = ++turnSeq;
  if (!conversing) enterConversation();
  answerAbort?.abort(); // supersede any prior in-flight answer
  const ac = (answerAbort = new AbortController());
  clearTimeout(resumeTimer);

  // Awaiting confirmation for a spawn? A clear yes runs it; a clear no cancels;
  // anything else drops the pending spawn and is handled as a normal message.
  if (pendingSpawn) {
    const ps = pendingSpawn;
    pendingSpawn = null;
    if (/^\s*(yes|yeah|yep|yup|sure|ok|okay|go|go ahead|do it|confirm|spawn it|please|y)\b/i.test(q)) {
      return void doSpawn(ps);
    }
    if (/^\s*(no|nope|nah|cancel|never ?mind|stop|don'?t|do not|wait)\b/i.test(q)) {
      speakAnswer("Okay, cancelled — no agent spawned.", { priority: "high" });
      return;
    }
    // unclear → fall through and treat q as a fresh message
  }

  // Awaiting confirmation of a learned guardrail. add: yes+scope persists; remove:
  // a contradiction-revoke (drop/keep). Anything unclear drops the pending and is
  // handled fresh. (Propose-don't-auto-persist; same for revoke.)
  if (pendingGuardrail) {
    const pg = pendingGuardrail;
    pendingGuardrail = null;
    if (pg.mode === "remove") {
      const dropIt = /\b(yes|yeah|yep|sure|ok|okay|drop|remove|delete|forget|get rid)\b/i.test(q);
      const keepIt = /\b(no|nope|nah|keep|leave|never ?mind|don'?t)\b/i.test(q);
      if (dropIt && !keepIt) {
        const n = forgetGuardrail(pg.match, pg.cwd);
        speakAnswer(n ? "Dropped that guardrail." : "Couldn't find that one to drop.", { priority: "high" });
        return;
      }
      if (keepIt) {
        speakAnswer("Okay — keeping it.", { priority: "high" });
        return;
      }
      // unclear → fall through, treat q fresh
    } else {
      const yes = /\b(yes|yeah|yep|sure|ok|okay|please|do|remember|every|all|global|always|here|this|project|local)\b/i.test(q);
      const no = /\b(no|nope|nah|never ?mind|skip|forget|don'?t)\b/i.test(q);
      if (yes && !no) {
        const scope = /\b(every|everywhere|all|global|always)\b/i.test(q) ? "global" : "project";
        if (addGuardrail(pg.rule, scope, pg.cwd))
          speakAnswer(`Got it — I'll keep that in mind ${scope === "global" ? "everywhere" : "for this project"}.`, { priority: "high" });
        else speakAnswer("Already had that one.", { priority: "high" });
        return;
      }
      if (no) {
        speakAnswer("No problem — won't remember it.", { priority: "high" });
        return;
      }
      // unclear → fall through, treat q fresh
    }
  }

  // Awaiting a "which agent?" answer: a SHORT reply is the pick ("mach", "the
  // compression one") → answer the ORIGINAL question for that agent so the thread
  // isn't lost. A longer reply is a new request → treat it fresh.
  if (pendingAsk && agents.size > 1) {
    const orig = pendingAsk;
    pendingAsk = null;
    if (q.trim().split(/\s+/).length <= 4) {
      const picked = await resolveTarget(q);
      if (mySeq !== turnSeq) return;
      if (picked && picked !== "ASK" && picked !== "NONE") {
        console.log(`   ↳ got it: ${picked.label}`);
        // Answer the ORIGINAL question for the picked agent DIRECTLY — don't
        // re-resolve it (the original was ambiguous, so it would just ASK again).
        return void answer(orig, picked);
      }
    }
    // not a clear pick → treat q as a fresh message
  }

  if (!agents.size) {
    speakAnswer("No Claude session is being watched yet.", { priority: "normal" });
    return;
  }

  // Which agent are they addressing?
  let ag;
  if (forcedAgent) {
    ag = forcedAgent; // resolved already (e.g. a "which agent?" pick) — don't re-ask
  } else if (q && agents.size > 1) {
    const target = await resolveTarget(q);
    if (mySeq !== turnSeq) return; // superseded during resolution
    if (target === "ASK" || target === "NONE") {
      const labels = humanList([...agents.values()].map((a) => a.label));
      const msg =
        target === "NONE" ? `I'm not watching that one. I've got ${labels}.` : `Which agent — ${labels}?`;
      if (target === "ASK") pendingAsk = q; // remember the question; re-answer it once they pick
      console.log(`\n❓ ${msg}\n`); // show it in the feed, not just aloud
      speakAnswer(msg, { priority: "high" });
      return;
    }
    ag = target;
  } else {
    ag = targetAgent();
  }
  if (!ag) return void endConversation();

  const announce = MULTI && focused?.slug !== ag.slug;
  focused = ag;
  ag.lastSpokeAt = Date.now();

  const utterance = q || "Give me a quick status — what's the agent doing right now and why?";
  // Send the question enriched with the latest raw activity (the convo only holds
  // what we've NARRATED — sparse right after boot, and never the un-narrated
  // "happening now"). But COMMIT only the clean question, so the convo stays lean.
  const recentTail = ag.recent.slice(-80);
  const header = ag.ambientHeader(); // goal + clock + story + metrics
  // Standing guardrails the user taught over time — folded into any PROMPT relay.
  const gr = applicableGuardrails(ag.cwd);
  const grBlock = gr.length
    ? `[GUARDRAILS] (the user's standing preferences — fold the relevant ones into any PROMPT, don't recite)\n${gr.map((g) => "- " + g).join("\n")}\n\n`
    : "";
  const enriched = {
    role: "user",
    content:
      (header ? header + "\n\n" : "") +
      grBlock +
      (recentTail.length ? `(latest agent activity, for context:\n${renderLog(recentTail)}\n)\n\n` : "") +
      `[ME] ${utterance}`,
  };
  const candidate = { role: "user", content: `[ME] ${utterance}` };
  try {
    const route = await model.converse([...ag.convo, enriched], { signal: ac.signal });
    if (mySeq !== turnSeq) return; // a newer utterance won → don't commit or speak
    if (route.think) console.log(`   🧠 ${ag.label ? `[${ag.label}] ` : ""}${route.think}`);

    if (route.action === "research") {
      ctx.onSpoke(ag);
      ag.commit(candidate, `(you asked me to research: ${route.text})`);
      runResearch(ag, route.text);
      return;
    }

    if (route.action === "spawn") {
      // Durable side-effect (new branch + worktree) gated behind a spoken confirm
      // that NAMES the repo — so a wrong target is caught before anything is created.
      const task = route.text;
      const root = repoRootOf(ag.cwd);
      const repoName = (root || ag.cwd).split("/").filter(Boolean).pop();
      pendingSpawn = { task, cwd: ag.cwd };
      ag.commit(candidate, `(you asked me to spawn a new agent in ${repoName} to: ${task})`);
      ctx.onSpoke(ag);
      const where = root ? `a fresh worktree off ${repoName}` : `${repoName} — heads up, it's not a git repo so no isolation`;
      console.log(`\n🚀 ${ag.label ? `[${ag.label}] ` : ""}spawn? ${repoName}: ${task}`);
      speakAnswer(`Want me to spin up a new agent in ${where} to ${task}? Say yes to go.`, { priority: "high" });
      return;
    }

    if (route.action === "prompt") {
      console.log(`\n➡️  ${ag.label ? `[${ag.label}] ` : ""}Claude: ${route.text}`);
      const r = await sendToClaude(route.text, ag.cwd);
      if (mySeq !== turnSeq) return;
      // Record the relay as a plain first-person past-tense statement (not the raw
      // PROMPT: control token, which the model would mimic; and not a tentative
      // parenthetical, which it reads as "not done"). Only logged as done if it
      // actually landed.
      ag.commit(
        candidate,
        r === "OK"
          ? `I sent this instruction to the agent on your behalf: "${route.text}"`
          : `I tried to relay an instruction to the agent but couldn't reach it.`
      );
      ctx.onSpoke(ag);
      const who = MULTI ? ag.label : "Claude";
      let spoken;
      if (r === "OK") {
        // Speak the EXPANDED instruction that was actually sent, so an over-reach
        // (a scope you didn't intend) is audible and you can correct it.
        spoken =
          process.env.IL_STEER_CONFIRM === "0"
            ? null
            : `Sent${MULTI ? ` to ${ag.label}` : ""}: ${route.text}`;
      } else if (r === "NOTTY") {
        spoken = `I don't see Claude running in ${ag.cwd.split("/").pop()}. Run it there, in the same folder as me.`;
        console.error(`   ⚠️  no claude process with cwd ${ag.cwd}`);
      } else if (r === "CMUXAUTH") {
        spoken = "I can't reach cmux to steer it — I need its socket password. Drop it in the interaction-layer folder, then restart me.";
        console.error(
          `   ⚠️  cmux is installed but its control socket is unreachable (no password).\n` +
          `      Fix: put your cmux socket password in ~/.claude/interaction-layer/cmux-password.txt\n` +
          `      (or export CMUX_SOCKET_PASSWORD before launching the sidecar), then restart it.`
        );
      } else if (r === "NOTFOUND") {
        spoken = `I found ${who}'s session but not its window — only cmux and Terminal.app are supported for now.`;
        console.error(`   ⚠️  claude tty found but no targetable window (cmux/Terminal.app only)`);
      } else {
        spoken = `I couldn't reach the ${who} window.`;
        console.error(`   ⚠️  ${r}`);
      }
      speakAnswer(spoken, { priority: "high" });
      offerGuardrail(ag, route);
      return;
    }

    if (route.action === "aside") {
      // Side/meta question (the time, general knowledge, a tangent). Answer and
      // speak it, but do NOT commit it to the agent's convo — that's what keeps an
      // off-topic exchange from derailing every future narration beat. Focus is
      // untouched (the resolver STAYs for no-agent questions).
      const text = route.text?.trim() || "Hmm — not sure about that one.";
      console.log(`\n💬 ${ag.label ? `[${ag.label}] ` : ""}(aside) ${text}\n`);
      if (ag.pending.length) ag.bridgePending = true; // agent moved meanwhile → bridge back next beat
      speakAnswer(announce ? `In ${ag.label}: ${text}` : text);
      offerGuardrail(ag, route);
      return;
    }

    // ANSWER — commit the [ME]→reply pair and speak it. Never let a real question
    // produce silence (which would feel like it ignored you and a narration then
    // fills the gap) — fall back to an explicit "not sure".
    const text = route.text?.trim() || "I heard you, but I'm not sure how to answer that — can you rephrase?";
    ag.commit(candidate, text);
    ctx.onSpoke(ag);
    console.log(`\n💬 ${ag.label ? `[${ag.label}] ` : ""}${text}\n`);
    speakAnswer(announce && route.text ? `In ${ag.label}: ${text}` : text);
    offerGuardrail(ag, route);
  } catch (e) {
    if (ac.signal.aborted || mySeq !== turnSeq) return; // superseded — the newer turn owns the flow
    console.error("model error:", e.message);
    speakAnswer("Sorry — I hit an error answering that. Try again?", { priority: "high" });
  }
}

// Speak a reply (or end the turn if there's nothing/we're muted). Keeps
// conversation mode on until the answer finishes, so narration can't talk over it.
function speakAnswer(text, { priority = "normal" } = {}) {
  if (text && voice.enabled) {
    awaitingAnswer = true; // endConversation fires when the answer finishes speaking
    resumeTimer = setTimeout(endConversation, 30_000); // safety net
    voice.say(text, { priority });
  } else {
    endConversation();
  }
}

// Research brain: a tool-using sub-agent reads the literature + canonical repos and
// critiques the coding agent's approach. Runs in the background (~1-2 min) — we
// acknowledge now and deliver the grounded brief when it lands, attributed to the
// agent. The sub-agent is itself a `claude` process, so we exclude its slug from
// the watcher first (or the conductor would narrate its own helper).
function runResearch(ag, topic, { auto = false } = {}) {
  const tag = ag.label ? `[${ag.label}] ` : "";
  const id = Date.now().toString(36);
  const cwd = newResearchDir(id);
  if (typeof watcher.ignore === "function") watcher.ignore(slugFor(cwd));
  // Audit-log EVERY auto-research (even ones that come back consistent and are
  // never spoken), so autonomous spend is always scrollable.
  console.log(`\n🔬 ${tag}${auto ? "auto-" : ""}researching: ${topic}`);
  if (auto) {
    // Rare (gated by in-flight=1) — a short cue makes the autonomy legible.
    voice.say(`${MULTI ? `On ${ag.label}: ` : ""}let me quickly check the literature on that.`, { priority: "low" });
  } else {
    speakAnswer(`Let me dig into the literature and reference implementations on that — give me a minute.`, { priority: "high" });
  }
  const context = `Goal: ${ag.goal || "(unknown)"}\n\nRecent activity:\n${renderLog(ag.recent.slice(-40))}`;
  research({
    topic,
    context,
    cwd,
    onDone: (r) => {
      if (auto) researchInFlight = false; // free the single slot
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      if (r.ok) {
        ag.research.push({ topic, brief: r.brief, notable: r.notable });
        ag.commit({ role: "user", content: `[ME] (research result for: ${topic})` }, r.brief);
        console.log(`\n🔬 ${tag}research — ${topic} (notable: ${r.notable}):\n${r.brief}\n`);
        // Asymmetric delivery: on-request always speaks; AUTO speaks only when the
        // finding diverges (notable). "Consistent with canonical" is stored+logged,
        // not spoken — a critic that says "it's standard" every few minutes is noise.
        if (!auto || r.notable) {
          const lead = auto ? `${MULTI ? `On ${ag.label}: ` : ""}heads up — ` : `${MULTI ? `On ${ag.label}: ` : ""}Here's what I found on ${topic}. `;
          voice.say(lead + r.brief);
        }
      } else {
        console.error(`   ⚠️  research failed: ${r.error}`);
        if (!auto) voice.say(`I couldn't finish researching ${topic} — ${r.error}.`); // stay quiet on auto failures
      }
    },
  });
}

// A learned-guardrail candidate the model flagged (a correction/durable preference).
// Propose it — never auto-persist — and let the user confirm + scope it next turn.
function offerGuardrail(ag, route) {
  if (pendingSpawn) return;
  if (route.unguardrail) {
    // The user just overrode a standing guardrail — offer to drop the stale rule.
    pendingGuardrail = { match: route.unguardrail, cwd: ag.cwd, mode: "remove" };
    console.log(`   💡 drop stale guardrail? "${route.unguardrail}"`);
    voice.say(`That goes against a standing guardrail — want me to drop "${route.unguardrail}"? Yes or no.`, {
      priority: "normal",
    });
    return;
  }
  if (route.guardrail) {
    pendingGuardrail = { rule: route.guardrail, cwd: ag.cwd, mode: "add" };
    console.log(`   💡 learn guardrail? "${route.guardrail}"`);
    voice.say("Want me to remember that for next time — just this project, or everywhere? Or never mind.", {
      priority: "normal",
    });
  }
}

// Actually create the worktree + launch the agent (after spoken confirmation). The
// MultiWatcher discovers the new session on its own and starts narrating it.
function doSpawn({ task, cwd }) {
  const r = spawnAgent({ task, cwd, stamp: Date.now() });
  if (r.ok) {
    console.log(`\n🚀 spawned: ${r.dir}${r.branch ? `  (branch ${r.branch})` : ""}`);
    const where = r.isolated ? `on a new branch, ${r.branch}` : "in its folder";
    speakAnswer(`On it — spinning up an agent ${where}. I'll watch it and let you know how it goes.`, { priority: "high" });
  } else {
    console.error(`   ⚠️  spawn failed: ${r.error}`);
    speakAnswer(`I couldn't spawn it — ${r.error}.`, { priority: "high" });
  }
}

// Push-to-talk: hold Right Option (⌥) anywhere to talk; release to send. The mic
// runs ONLY between hold and release. Words are transcribed locally (Whisper).
let pttProc = null;
function startPushToTalk() {
  warmStt(); // preload Whisper so the first hold transcribes fast
  if (!sttAvailable()) {
    console.error(`   ⚠️  speech-to-text unavailable: ${sttProblem()}\n      (typed questions still work)`);
  }
  const compiled = path.join(HERE, "ptt-monitor");
  pttProc = process.env.IL_PTT_CMD
    ? spawn("sh", ["-c", process.env.IL_PTT_CMD]) // override (testing / custom key tool)
    : fs.existsSync(compiled)
    ? spawn(compiled)
    : spawn("swift", [path.join(HERE, "ptt-monitor.swift")]);

  let holding = false;
  pttProc.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      const s = line.trim();
      if (s === "NOACCESS") {
        console.error(
          `   ⚠️  push-to-talk needs INPUT MONITORING permission.\n` +
            `      System Settings → Privacy & Security → Input Monitoring → enable your terminal app,\n` +
            `      then FULLY QUIT and reopen the terminal (the grant only applies on relaunch).\n` +
            `      (typed questions work meanwhile)`
        );
      } else if (s === "READY") {
        console.log("   🎙️  push-to-talk ready — hold Right Option (⌥) to talk");
      } else if (s === "DOWN" && !holding) {
        holding = true;
        onHoldStart();
      } else if (s === "UP" && holding) {
        holding = false;
        onHoldEnd().catch((e) => logErr("onHoldEnd", e));
      }
    }
  });
  pttProc.on("error", () =>
    console.error("   ⚠️  push-to-talk monitor failed to start; typed questions still work")
  );

  // AirPod tap-to-talk via the now-playing helper. OPT-IN (IL_AIRPOD=1) because it
  // claims the macOS now-playing slot (plays silent audio) — invasive enough not to
  // run by default. AirPod taps are delivered to the now-playing app by MediaRemote.
  if (process.env.IL_AIRPOD === "1") startAirpod();
}

// Tap-to-talk (AirPod play-pause): each tap toggles recording — tap to start,
// tap again to send. Reuses the hold pipeline (recording state = `holding`).
function togglePtt() {
  if (holding) onHoldEnd().catch((e) => logErr("onHoldEnd", e));
  else onHoldStart(true); // tap-toggle → "(tap to send)" hint
}

let airpodPoll = null;
const AIRPOD_BUNDLE = path.join(HERE, "nowplaying-monitor.app");
const AIRPOD_EVENTS = path.join(os.homedir(), ".cache", "interaction-layer", "airpod.events");
function startAirpod() {
  if (!fs.existsSync(AIRPOD_BUNDLE)) {
    console.error("   ⚠️  AirPod tap-to-talk: helper not built — run `npm run build` (needs bin/nowplaying-monitor.app).");
    return;
  }
  // The helper must be LAUNCHED via LaunchServices (open) to be eligible for media
  // remote commands — a directly-spawned binary isn't. It detaches stdout, so it
  // signals taps by appending to AIRPOD_EVENTS, which we tail here.
  try { execFileSync("pkill", ["-f", "nowplaying-monitor.app"]); } catch {} // clear any stale instance
  fs.mkdirSync(path.dirname(AIRPOD_EVENTS), { recursive: true });
  fs.writeFileSync(AIRPOD_EVENTS, ""); // fresh channel
  console.log(`   🎧 AirPod: launching helper… (${AIRPOD_BUNDLE})`);
  const op = spawn("open", [AIRPOD_BUNDLE], { stdio: ["ignore", "ignore", "pipe"] });
  op.stderr?.on("data", (d) => console.error(`   ⚠️  AirPod open: ${d.toString().trim()}`));
  op.on("error", (e) => console.error(`   ⚠️  AirPod open failed to spawn: ${e.message}`));
  op.on("exit", (code) => { if (code) console.error(`   ⚠️  AirPod: open exited with code ${code}`); });

  let offset = 0;
  let readySeen = false;
  const drain = () => {
    let buf;
    try { buf = fs.readFileSync(AIRPOD_EVENTS); } catch { return; }
    if (buf.length <= offset) { if (buf.length < offset) offset = 0; return; }
    const fresh = buf.toString("utf8", offset);
    offset = buf.length;
    for (const line of fresh.split("\n")) {
      const s = line.trim();
      if (s === "READY") { readySeen = true; console.log("   🎧 AirPod tap-to-talk ready — tap play/pause to talk (works when no other media is playing)"); }
      else if (s === "TOGGLE") togglePtt();
    }
  };
  try { fs.watch(AIRPOD_EVENTS, { persistent: false }, drain); } catch {}
  airpodPoll = setInterval(drain, 400); // backstop in case fs.watch misses appends
  setTimeout(() => { if (!readySeen) console.error("   ⚠️  AirPod: helper never signaled READY — it may have failed to launch or stay alive."); }, 3000);
}

// Live partial transcription: while recording, re-transcribe the audio so far
// (~every 0.6s, resident server only) into `lastPartial`, which the recording
// indicator renders — so your words appear AS you speak.
let holding = false;
let partialTimer = null;
let partialBusy = false;
let lastPartial = "";
function startPartials() {
  stopPartials();
  partialTimer = setInterval(async () => {
    if (partialBusy || !partialTimer) return;
    const pcm = mic?.currentRecording?.() || Buffer.alloc(0);
    if (pcm.length < 6000) return; // <~0.2s, nothing to show yet
    partialBusy = true;
    try {
      const t = await sttPartial(pcm);
      if (partialTimer && t) lastPartial = t;
    } finally {
      partialBusy = false;
    }
  }, 600);
}
function stopPartials() {
  if (partialTimer) clearInterval(partialTimer);
  partialTimer = null;
}

// A live, pulsing "recording" line: red dot + elapsed time + your words so far, so
// it's unmistakable that the mic is hot (and that the agent feed is paused).
const REC_MAX_MS = 60_000; // hard cap — auto-send so a forgotten toggle can't record forever
let recRenderTimer = null;
let recStartedAt = 0;
let recStopHint = "";
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function renderRec(frame) {
  const dot = frame % 2 ? "\x1b[2m●\x1b[0m" : "\x1b[31m●\x1b[0m"; // pulse
  const elapsedMs = Date.now() - recStartedAt;
  const left = Math.ceil((REC_MAX_MS - elapsedMs) / 1000);
  const warn = left <= 10 ? `  \x1b[33m(auto-send in ${left}s)\x1b[0m` : "";
  const tail = lastPartial ? `  ${lastPartial}` : `  listening… ${recStopHint}`;
  process.stdout.write(`\r\x1b[2K${dot} \x1b[31mREC\x1b[0m ${fmtElapsed(elapsedMs)}${warn}${tail}`);
}
function startRecIndicator() {
  recStartedAt = Date.now();
  lastPartial = "";
  process.stdout.write("\n");
  let frame = 0;
  renderRec(frame);
  recRenderTimer = setInterval(() => renderRec(++frame), 400);
}
function stopRecIndicator() {
  if (recRenderTimer) clearInterval(recRenderTimer);
  recRenderTimer = null;
  process.stdout.write("\r\x1b[2K"); // wipe the live line
}

let maxRecTimer = null;
function onHoldStart(viaTap = false) {
  enterConversation();
  holding = true; // suppress the agent action-feed so the live line stays clean
  recStopHint = viaTap ? "(tap to send)" : "(release ⌥ to send)";
  // Hard cap: auto-send after REC_MAX_MS so a forgotten release/second-tap can't
  // record indefinitely (especially the AirPod toggle).
  clearTimeout(maxRecTimer);
  maxRecTimer = setTimeout(() => {
    onHoldEnd().catch((e) => logErr("onHoldEnd", e));
  }, REC_MAX_MS);
  mic?.startRecording();
  startRecIndicator();
  startPartials();
}

// Whisper hallucinates these on silence/noise — treat as "didn't catch that"
// rather than feeding garbage into answer(). Keep tight so real short replies
// ("yes", "no", "ok") still go through (e.g. spawn confirmation).
function isNoiseTranscript(t) {
  const s = t.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (s.length < 2) return true;
  return ["you", "thank you", "thank you so much", "thanks for watching", "bye", "the", "uh", "um"].includes(s);
}

async function onHoldEnd() {
  if (!holding) return; // already ended (e.g. 60s cap fired, then ⌥-release/tap) — don't double-process
  holding = false;
  clearTimeout(maxRecTimer);
  stopPartials();
  stopRecIndicator();
  const pcm = mic?.stopRecording() || Buffer.alloc(0);
  if (pcm.length < 8000) {
    // < ~0.25s — a genuine stray tap; stay silent.
    endConversation();
    return;
  }
  process.stdout.write("   transcribing…\n");
  const text = (await transcribe(pcm)).trim();
  // A real attempt that we couldn't make out: SAY SO (don't silently drop it and
  // let a narration fill the gap — that's what makes it feel like it ignored you).
  if (!text || isNoiseTranscript(text)) {
    console.log(`   ⚠️  didn't catch that${text ? ` (heard: "${text}")` : ""}`);
    awaitingAnswer = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(endConversation, 10_000);
    voice.say("Sorry, I didn't catch that — say it again?", { priority: "high" });
    return;
  }
  console.log(`🗨️  you: ${text}`);
  await answer(text);
}

if (mic && VOICE_IN) startPushToTalk();

// Switch which agent voice/typed messages address.
function focusByName(q) {
  if (!agents.size) return console.log("   (no agents watched)");
  const hit = [...agents.values()].find((a) => a.label.toLowerCase().includes(q.toLowerCase()));
  if (hit) {
    focused = hit;
    hit.lastSpokeAt = Date.now();
    console.log(`   🎯 focused on ${hit.label}`);
    voice.say(`Okay, focused on ${hit.label}.`, { priority: "high" });
  } else {
    console.log(`   no watched agent matches "${q}"`);
  }
}
function listAgents() {
  if (!agents.size) return console.log("   (no agents watched)");
  for (const a of agents.values()) {
    console.log(`   ${a === targetAgent() ? "▶" : " "} ${a.label || a.cwd}`);
  }
}

// Handle a completed line (typed, or dictated by a tool like Wispr Flow).
async function handleLine(raw) {
  const q = raw.trim();
  if (!q) return; // ignore blank lines (e.g. the \n half of a CRLF, or a stray Enter)
  if (q === "/quit") return shutdown();
  if (q === "/mute") return void (voice.enabled = false);
  if (q === "/unmute") return void (voice.enabled = true);
  if (q === "/agents") return listAgents();
  if (q.startsWith("/focus")) return focusByName(q.slice(6).trim());
  if (q.startsWith("/research")) {
    const topic = q.slice(9).trim();
    const ag = targetAgent();
    if (!ag) return console.log("   (no agent to research for)");
    if (!topic) return console.log("   usage: /research <topic>");
    return void runResearch(ag, topic);
  }
  if (q.startsWith("/guardrails")) {
    const rest = q.slice(11).trim();
    const cwd = targetAgent()?.cwd || singleCwd || process.cwd();
    if (rest.startsWith("forget")) {
      const n = forgetGuardrail(rest.slice(6).trim(), cwd);
      return console.log(`   forgot ${n} guardrail(s)`);
    }
    const { global, project } = listGuardrails(cwd);
    console.log("   guardrails — global:");
    global.forEach((g) => console.log(`     • ${g}`));
    console.log(`   guardrails — this project:`);
    project.forEach((g) => console.log(`     • ${g}`));
    if (!global.length && !project.length) console.log("     (none yet — they're learned from your corrections)");
    return;
  }
  await answer(q);
}

// Raw-mode input so we get EVERY keystroke: any key instantly hushes the
// narrator (barge-in) — including the first character a dictation tool types —
// then the line is assembled and submitted on Enter. Esc just hushes.
const input = process.stdin;
if (input.isTTY) input.setRawMode(true);
input.setEncoding("utf8");
let lineBuf = "";
let lastCR = false; // collapse CRLF into a single Enter
input.on("data", (chunk) => {
  enterConversation(); // ANY input = barge-in: stop talking, listen
  if (chunk === "") return shutdown(); // Ctrl-C
  if (chunk.startsWith("")) return; // Esc / arrow / escape seq: hush only
  for (const ch of chunk) {
    if (ch === "\n" && lastCR) {
      lastCR = false;
      continue; // second half of a CRLF — already handled on the \r
    }
    lastCR = ch === "\r";
    if (ch === "\r" || ch === "\n") {
      const line = lineBuf;
      lineBuf = "";
      process.stdout.write("\n");
      handleLine(line).catch((e) => logErr("handleLine", e));
    } else if (ch === "" || ch === "\b") {
      if (lineBuf) {
        lineBuf = lineBuf.slice(0, -1);
        process.stdout.write("\b \b");
      }
    } else if (ch >= " ") {
      lineBuf += ch;
      process.stdout.write(ch); // echo
    }
  }
});
input.on("end", shutdown); // stdin closed (e.g. terminal closed)

function shutdown() {
  watcher.stop();
  for (const ag of agents.values()) ag.close();
  mic?.stop();
  pttProc?.kill();
  if (airpodPoll) clearInterval(airpodPoll);
  try { execFileSync("pkill", ["-f", "nowplaying-monitor.app"]); } catch {} // stop the now-playing helper
  stopStt(); // kill the resident whisper server
  try {
    if (Number(fs.readFileSync(LOCK, "utf8")) === process.pid) fs.unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Resilience: NEVER let a stray error (incl. unhandled promise rejections, which
// crash Node by default) take down the long-running sidecar. Ignore benign pipe
// errors; log everything else to a file we can inspect, and keep running.
const ERR_LOG = path.join(POINTER_DIR, (MULTI ? "sidecar" : slugFor(singleCwd)) + ".log");
function logErr(tag, e) {
  if (e?.code === "EPIPE" || e?.code === "ECONNRESET") return;
  const stamp = new Date().toISOString();
  const detail = e?.stack || e?.message || String(e);
  try {
    fs.appendFileSync(ERR_LOG, `[${stamp}] ${tag}: ${detail}\n`);
  } catch {}
  console.error(`⚠️  ${tag} (continuing): ${e?.message || e}`);
}
process.on("uncaughtException", (e) => logErr("uncaughtException", e));
process.on("unhandledRejection", (e) => logErr("unhandledRejection", e));
