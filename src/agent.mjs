// One watched Claude Code session: its own transcript tail, event buffers, and
// proactive-narration state. Many of these run inside a single sidecar (multi
// mode), all sharing one Voice and one InteractionModel. The per-agent "brief"
// (what the human's already been told) lives here, not on the shared model, so
// the agents never cross-talk.
//
// Both single-project mode and multi mode drive THIS class — there is no second
// narrate code path to keep in sync.
import fs from "node:fs";
import { tail, seedEvents, sessionTiming } from "./transcript.mjs";
import { narrateToolUse, narrateResult, narrateAssistantSay } from "./narrate.mjs";
import { renderLog } from "./model.mjs";

const MAX_RECENT = 100;
const MAX_PENDING = 60; // cap un-narrated events kept across PASS beats
const CONVO_PAIRS = 8; // sliding window of committed narration turns (×2 messages)
// "Stuck / taking a long time" is the ABSENCE of events — event-driven narration
// can't see it, so a deterministic timer flags it. Conservative by default.
const STALL_MS = (Number(process.env.IL_STALL_SECS) || 180) * 1000;
// Gaps longer than this don't count as active work (parked / overnight / resumed).
const ACTIVE_GAP_MS = (Number(process.env.IL_ACTIVE_GAP_SECS) || 300) * 1000;

function trunc(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Worth waking the narrator for? Reasoning/results/prose carry the story;
// a lone file read does not.
function hasSubstance(events) {
  return (
    events.some(
      (e) =>
        e.kind === "thinking" ||
        e.kind === "tool_result" ||
        e.kind === "assistant_say" ||
        e.kind === "meta" // a stall/observer note is worth a beat on its own
    ) || events.length >= 4
  );
}

// "Breaking news" — purely syntactic, so deciding it never needs the LLM call it
// would trigger: a failed command, or the human typing a new instruction to the
// agent. Used to supersede an in-flight narration.
function isSalient(ev) {
  return (ev.kind === "tool_result" && ev.isError) || ev.kind === "user_say";
}

export class WatchedAgent {
  // ctx (shared, from the orchestrator):
  //   narrateMs, speakActions, isConversing(), log(s), onSpoke(agent)
  constructor({ slug, cwd, label, voice, model, ctx }) {
    this.slug = slug;
    this.cwd = cwd;
    this.label = label || ""; // short project name for prefixing; "" = single mode
    this.voice = voice;
    this.model = model;
    this.ctx = ctx;

    this.recent = []; // ring buffer of recent TraceEvents
    this.toolNames = new Map(); // tool_use id -> tool name, for result narration
    this.pending = []; // events not yet narrated (kept across PASS beats)
    this.convo = []; // persistent narration conversation: committed [FEED]→reply pairs
    this.evCount = 0; // monotonic event counter, to detect activity during a beat

    this.narrating = false;
    this.narrateTimer = null;
    this.genAbort = null; // aborts the in-flight narration (barge-in / breaking news)
    this._beatHadError = false; // does the in-flight beat already include an error?
    this.t = null; // tail handle
    this.lastSpokeAt = 0; // when the sidecar last narrated/answered ABOUT this agent

    this.resetMetrics();
  }

  // Whole-session AGGREGATES (O(signals), not a log) — the observer tier. Lets the
  // conductor see pace/iteration over a span longer than the event window without
  // storing it. Reset per session (attach).
  resetMetrics() {
    this.startedAt = 0;
    this.lastEventAt = 0;
    this.stallFlagged = false; // fire the stall notice once per idle stretch
    this.awaitingInput = false; // agent's last turn ended (end_turn) → done, waiting for you
    this.m = { tools: 0, edits: 0, bash: 0, tests: 0, errors: 0, consecErrors: 0 };
    this.editsByFile = new Map(); // file -> edit count (churn signal)
    this.goal = null; // original task (transcript HEAD) — persistent, never windowed
    this.sessionStartedAt = 0; // true session start (HEAD), for elapsed time
    this.activeMs = 0; // active work time (gaps capped) — not wall-clock span
    this._lastTs = 0; // last event time, for incrementing activeMs live
    this.arc = []; // one line per past narration — long-horizon "story so far"
    this.research = []; // [{topic, brief}] grounded research briefs (recall)
    this.researchedTopics = []; // questions already researched/in-flight (model-judged dedup)
    this.bridgePending = false; // just answered a side question — bridge back next beat
  }

  recordMetrics(ev) {
    this.lastEventAt = Date.now();
    if (!this.startedAt) this.startedAt = this.lastEventAt;
    this.stallFlagged = false; // any activity = progress; re-arm the stall check
    // Accrue active work time: the gap since the last event, capped (a long pause
    // between events is a break, not work).
    const ts = ev.ts ? Date.parse(ev.ts) || this.lastEventAt : this.lastEventAt;
    if (this._lastTs && ts > this._lastTs) this.activeMs += Math.min(ts - this._lastTs, ACTIVE_GAP_MS);
    this._lastTs = ts;
    if (ev.kind === "tool_use") {
      this.m.tools++;
      if (ev.tool === "Edit" || ev.tool === "Write" || ev.tool === "NotebookEdit") {
        this.m.edits++;
        const f = ev.input?.file_path || ev.input?.path || ev.input?.notebook_path;
        if (f) this.editsByFile.set(f, (this.editsByFile.get(f) || 0) + 1);
      } else if (ev.tool === "Bash") {
        this.m.bash++;
        if (/\btest(s)?\b|pytest|jest|vitest|go test|cargo test|npm (run )?test|rspec/i.test(ev.input?.command || ""))
          this.m.tests++;
      }
    } else if (ev.kind === "tool_result") {
      if (ev.isError) {
        this.m.errors++;
        this.m.consecErrors++;
      } else this.m.consecErrors = 0;
    }
    // Track whether the agent's turn ENDED (awaiting your input) vs is mid-work, so
    // the stall note can say "done, waiting for you" instead of guessing "thinking".
    if (ev.kind === "assistant_say") this.awaitingInput = ev.stopReason === "end_turn";
    else if (ev.kind === "tool_use" || ev.kind === "tool_result" || ev.kind === "user_say") this.awaitingInput = false;
  }

  // Compact AMBIENT metrics line for the [FEED] payload — only notable bits, and
  // framed as optional so the model (not a threshold) decides if it's worth saying.
  metricsLine() {
    const m = this.m;
    const bits = [];
    if (m.edits) bits.push(`${m.edits} edits`);
    if (m.tests) bits.push(`tests run ${m.tests}×`);
    if (m.errors) bits.push(`${m.errors} errors`);
    const hot = [...this.editsByFile.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1])[0];
    if (hot) bits.push(`${hot[0].split("/").pop()} edited ${hot[1]}×`);
    if (m.consecErrors >= 3) bits.push(`${m.consecErrors} failures in a row`);
    if (!bits.length) return "";
    return `[METRICS] (ambient — mention only if genuinely notable) ${bits.join(" · ")}`;
  }

  // Relational time, NOT a readout: elapsed + idle, which are deterministic and
  // trustworthy (task boundaries are fuzzy, so we don't claim per-task durations).
  clockLine() {
    if (!this.sessionStartedAt) return "";
    const now = Date.now();
    const activeMin = Math.max(0, Math.round(this.activeMs / 60000));
    let idle = "";
    if (this.lastEventAt) {
      const s = Math.round((now - this.lastEventAt) / 1000);
      idle = s >= 90 ? ` · ${Math.round(s / 60)}m since last activity` : s >= 20 ? ` · ${s}s since last activity` : "";
    }
    // Active work time (idle gaps excluded), not wall-clock span — relational use only.
    return `[CLOCK] (ambient — relational, don't recite) ~${activeMin}m of active work so far${idle}`;
  }

  goalLine() {
    return this.goal ? `[GOAL] (the original task — for grounding, don't repeat it) ${trunc(this.goal, 220)}` : "";
  }

  // Long-horizon "story so far": narration one-liners OLDER than the convo window
  // (the convo already carries the recent ones, so don't double-send).
  storyLine() {
    const older = this.arc.slice(0, -CONVO_PAIRS).slice(-10);
    return older.length ? `[STORY SO FAR]\n${older.map((l) => "· " + l).join("\n")}` : "";
  }

  researchedLine() {
    return this.researchedTopics.length
      ? `[ALREADY RESEARCHED] (don't re-research these) ${this.researchedTopics.slice(-8).join("; ")}`
      : "";
  }

  // The always-on ambient header (all small) prepended to a [FEED] beat or a
  // question, so the conductor stays grounded in goal + time + arc + pace.
  ambientHeader() {
    return [this.goalLine(), this.clockLine(), this.storyLine(), this.researchedLine(), this.metricsLine()]
      .filter(Boolean)
      .join("\n");
  }

  // Deterministic stall trigger: if the agent has gone quiet past the threshold,
  // push ONE synthetic note so the normal beat can comment (the model judges
  // whether it's stuck, on a long step, or just done). Re-arms on the next event.
  checkStall() {
    if (this.stallFlagged || !this.lastEventAt) return;
    const idle = Date.now() - this.lastEventAt;
    if (idle < STALL_MS) return;
    this.stallFlagged = true;
    const mins = Math.round(idle / 60000);
    this.pending.push({
      kind: "meta",
      // Deterministic: if the last turn ended (end_turn), it's DONE and waiting for
      // you — say that, don't guess "still thinking". Otherwise it's quiet mid-work.
      text: this.awaitingInput
        ? `The agent finished its turn about ${mins} minute${mins === 1 ? "" : "s"} ago and is waiting for your input — it is NOT still working.`
        : `No new activity for about ${mins} minute${mins === 1 ? "" : "s"} — it may be stuck, on a long-running step, or finished.`,
    });
    this.evCount++;
    this.scheduleNarrate();
  }

  // Commit one conversational turn-pair (a [FEED]→narration or [ME]→reply) and
  // keep the convo to a sliding window. Single place the cap lives.
  commit(userTurn, assistantText) {
    this.convo.push(userTurn, { role: "assistant", content: assistantText });
    if (this.convo.length > CONVO_PAIRS * 2) this.convo = this.convo.slice(-CONVO_PAIRS * 2);
  }

  // Abort any in-flight narration generation (called on barge-in).
  interrupt() {
    this.genAbort?.abort();
  }

  tag() {
    return this.label ? `[${this.label}] ` : "";
  }

  // (Re)attach to a transcript: reset state, seed context, tail it.
  attach(file, { stale = false, switched = false } = {}) {
    if (this.t) this.t.close();
    this.toolNames.clear();
    this.recent.length = 0;
    this.pending.length = 0;
    this.resetMetrics(); // new session → fresh aggregates
    this.file = file;
    // One-time HEAD read: the goal + true session start live at the start of the
    // transcript and are long gone from the tail window (esp. for sessions the
    // sidecar attached to mid-flight).
    const ti = sessionTiming(file, ACTIVE_GAP_MS);
    this.goal = ti.goal;
    this.sessionStartedAt = ti.startedAt || Date.now();
    this.activeMs = ti.activeMs;
    this._lastTs = ti.lastTs || this.sessionStartedAt;
    for (const ev of seedEvents(file, MAX_RECENT)) {
      this.recent.push(ev);
      if (ev.id) this.toolNames.set(ev.id, ev.tool);
    }
    const name = file.split("/").pop();
    if (switched) {
      this.ctx.log(`\n🔄 ${this.tag()}switched to a new session: ${name}`);
      this.voice.say(this.label ? `${this.label} started a new session.` : "Switched to a new session.", {
        priority: "low",
      });
    } else {
      this.ctx.log(
        `✅ ${this.tag()}watching session ${name}${stale ? "  (idle — will narrate when it resumes)" : ""}`
      );
    }
    // Seed recency from the transcript's mtime, so a cold-start question with no
    // named agent targets the most-recently-active session (not discovery order).
    try {
      this.lastSpokeAt = fs.statSync(file).mtimeMs;
    } catch {}
    this.t = tail(file);
    this.t.on("event", (ev) => this.onEvent(ev));
    this.t.on("error", (e) => this.ctx.log(`tail error (${this.slug}): ${e.message}`));
  }

  // One-line summary of what this agent was last doing — for the addressing
  // resolver's roster. Prefers prose (thinking/say); falls back to last action.
  // Drawn from `recent` (seeded at attach), so it's populated even for idle
  // sessions that haven't narrated yet — unlike `brief`.
  gist() {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const e = this.recent[i];
      if (e.kind === "thinking" || e.kind === "assistant_say" || e.kind === "user_say") {
        return trunc(e.text, 150);
      }
    }
    for (let i = this.recent.length - 1; i >= 0; i--) {
      if (this.recent[i].kind === "tool_use") {
        const e = this.recent[i];
        return trunc(`${e.tool} ${JSON.stringify(e.input)}`, 150);
      }
    }
    return "(no activity captured yet)";
  }

  remember(ev) {
    this.recent.push(ev);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
  }

  // Low-level action feed (scrolling text). Voice is reserved for peer-level
  // reasoning narration below, unless --speak-actions is set.
  feed(line) {
    if (!line) return;
    // While the user is holding to talk, keep the console quiet so the live
    // partial-transcription line isn't garbled by the action feed.
    if (!this.ctx.isHolding?.()) this.ctx.log(`· ${this.tag()}${line}`);
    if (this.ctx.speakActions && !this.ctx.isConversing()) {
      this.voice.say(this.label ? `In ${this.label}: ${line}` : line, { priority: "low" });
    }
  }

  onEvent(ev) {
    this.evCount++;
    this.recordMetrics(ev);
    this.remember(ev);
    this.pending.push(ev); // kept until narrated; bounded so PASS streaks can't grow it
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    switch (ev.kind) {
      case "tool_use":
        this.toolNames.set(ev.id, ev.tool);
        this.feed(narrateToolUse(ev));
        break;
      case "tool_result":
        this.feed(narrateResult(ev, this.toolNames.get(ev.id)));
        break;
      case "assistant_say":
        this.feed(narrateAssistantSay(ev));
        break;
    }
    // Breaking news: a fresh error or new instruction-to-the-agent should
    // supersede an in-flight narration so it re-runs WITH this event — unless the
    // current beat already covers an error (avoids machine-gunning restarts).
    if (this.narrating && !this._beatHadError && isSalient(ev)) this.genAbort?.abort();
    if (hasSubstance(this.pending)) this.scheduleNarrate();
  }

  // Proactive peer narration, debounced per agent. Never interrupts the human
  // (skips while conversing — a shared flag, so a chatty agent B stays quiet
  // while you talk about agent A).
  scheduleNarrate() {
    // Defer while the one voice is busy (a narration or answer is playing); the
    // orchestrator's speech-end hook re-calls this when it frees up.
    if (this.narrateTimer || this.narrating || this.ctx.isConversing() || this.voice.isBusy()) return;
    this.narrateTimer = setTimeout(() => this.runNarrate(), this.ctx.narrateMs);
  }

  async runNarrate() {
    this.narrateTimer = null;
    if (this.narrating || this.ctx.isConversing() || !this.pending.length || !hasSubstance(this.pending))
      return;
    // One mouth: never generate/speak a new narration while one is still playing.
    // Let the events accumulate in pending; the speech-end retrigger (in the
    // orchestrator's onSpeaking) wakes us when the voice frees up, and we then
    // narrate ONE consolidated update over everything that piled up — a smooth
    // pivot instead of talking over the previous line.
    if (this.voice.isBusy()) return;
    this.narrating = true;
    const mark = this.evCount; // to detect activity that arrives during the call
    const batch = this.pending.slice(); // evaluate without removing yet (atomic-commit rule)
    this._beatHadError = batch.some((e) => e.kind === "tool_result" && e.isError);
    const header = this.ambientHeader();
    // One-shot bridge-back after a side conversation — model decides if it's worth a
    // "anyway, back to it"; if nothing notable happened it just continues normally.
    const resume = this.bridgePending
      ? `[RESUMING] You just answered a brief side question from your teammate. If the agent did something worth mentioning while you were away, bridge back naturally ("anyway, back to it — …"); if nothing notable, just continue.\n`
      : "";
    this.bridgePending = false;
    const candidate = { role: "user", content: `${header ? header + "\n\n" : ""}${resume}[FEED]\n${renderLog(batch)}` };
    const ac = (this.genAbort = new AbortController());
    try {
      const { action, text: line, think } = await this.model.narrate([...this.convo, candidate], { signal: ac.signal });
      // Surface the private reasoning to the console only (behind the voice) — it
      // is the "thinking mode" that decided how to relate this to the last line.
      if (think && !ac.signal.aborted) this.ctx.log(`   🧠 ${this.tag()}${think}`);
      // Correctness lives in these post-await rechecks, not the abort: only act if
      // we weren't superseded and the human didn't start talking.
      if (line && !ac.signal.aborted && !this.ctx.isConversing()) {
        // Either way the evaluated events are handled — drop them from pending. On
        // PASS/abort/suppressed we commit nothing and leave them, so a slow-building
        // development gets re-presented next beat (and PASS never bloats the convo).
        const done = new Set(batch);
        this.pending = this.pending.filter((e) => !done.has(e));
        if (action === "research") {
          // The aware critic asked itself a question — hand off to the conductor,
          // which applies the throttle/dedup/audit. No commit/speak here; the
          // grounded result is delivered later (and only if notable).
          this.ctx.requestResearch?.(this, line);
        } else {
          this.ctx.log(`\n🗣️  ${this.tag()}${line}\n`);
          this.voice.say(this.label ? `In ${this.label}: ${line}` : line, { priority: "low" });
          this.commit(candidate, line); // commit the [FEED]→reply pair atomically
          this.arc.push(line); // long-horizon story (text-only, bounded)
          if (this.arc.length > 30) this.arc = this.arc.slice(-30);
        }
        this.ctx.onSpoke(this); // focus follows what we just acted on
      }
    } catch {
      /* abort or transient → commit nothing, events stay pending */
    } finally {
      this.narrating = false;
      this.genAbort = null;
      this._beatHadError = false;
      // Re-run only if NEW activity arrived during the call — otherwise we'd
      // re-PASS the same static events forever. A fresh event also reschedules
      // via onEvent's scheduleNarrate.
      if (this.evCount !== mark && this.pending.length) this.scheduleNarrate();
    }
  }

  close() {
    clearTimeout(this.narrateTimer);
    this.narrateTimer = null;
    this.t?.close();
    this.t = null;
  }
}
