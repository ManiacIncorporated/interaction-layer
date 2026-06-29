# Interaction Layer for Claude Code

A voice "awareness" sidecar for Claude Code, inspired by Thinking Machines'
[interaction models](https://thinkingmachines.ai/blog/interaction-models/).

It adapts the **two-tier pattern** from that work:

- **Background model** — your existing Claude Code coding agent. Unchanged. It
  emits a live trace (thinking, tool calls, edits, results).
- **Interaction model** — a lightweight, always-present layer (this tool) that
  observes that trace, narrates it aloud, and answers your questions about what
  the agent is doing and *why* — in real time, while it keeps working.

> This adapts the *architecture*, not the literal mechanism. There's no 200ms
> audio micro-turn fusion or co-training here — narration is template-driven and
> synthesis runs on a prompted Haiku.

## How it works

```
 claude (terminal A) ──writes──> session transcript (.jsonl)
                                        │ tail
                                        ▼
            ┌───────────────── interaction layer (terminal B) ──────────────┐
            │  templated narrator  → instant, free  → 🔊 say                 │
            │  interaction model   → Haiku, on demand → world-model + Q&A    │
            └───────────────────────────────────────────────────────────────┘
```

The mental model: **Claude Code is an engineer thinking alone** — dense, fast,
idiosyncratic (raw numbers, half-formed hypotheses, terms it coins mid-stream).
**This tool is a peer engineer watching over your shoulder** who translates that
private stream into how one engineer briefs another.

- **Voice = peer reasoning.** Every ~15s, if the agent has done something with
  substance (a hypothesis, a result, a decision), the interaction model decides —
  like a colleague — whether there's anything worth saying, and says it in a
  sentence or two ("it thinks the 401 is from the refresh path, not verify, so
  it's reordering the middleware"). If nothing's new, it stays quiet. This is the
  "talk to me while it works" loop; it never interrupts you mid-question.
- **Text feed = the play-by-play.** Low-level actions ("Reading auth.ts") scroll
  in the terminal but aren't spoken (use `--speak-actions` to voice them too).
- **Q&A** answers your spoken/typed questions, grounded in the same stream.

Tune the cadence with `IL_NARRATE_SECS` (default 15). The LLM is called a few
times per minute — for proactive updates and Q&A — never once per tool call.

## Usage

Run in a **second terminal**. With no argument it watches **every** active
Claude session at once (one voice for all of them); pass a project dir to watch
just that one:

```bash
node bin/interaction-layer.mjs              # multi: watch ALL active sessions
node bin/interaction-layer.mjs <projectDir> # single: watch just this project
```

It attaches to the live session(s) (see below) and starts narrating. Then:

- **Hold Right Option (⌥)** → narration stops, the mic turns on, it listens
- **Speak, then release ⌥** → your words are transcribed locally and answered aloud
- **Or tap an AirPod (play/pause)** → toggle-to-talk (opt-in: `IL_AIRPOD=1`). ⚠️ *Best-effort
  and unreliable on recent macOS.* AirPod taps reach only the *now-playing* app, so the
  sidecar tries to claim that slot (silent audio via the bundled helper) — but macOS 26
  often won't hand it over, so taps may not register. ⌥-hold is the dependable trigger.
- **Or type a question + Enter** → spoken answer (works from any dictation tool too)
- `/agents` `/focus <name>` `/research <topic>` `/guardrails` `/mute` `/unmute` `/quit`

### Watching multiple agents at once

One sidecar can follow many Claude sessions simultaneously — start `claude` in
three projects (or three cmux panes) and a **single** voice narrates all of them,
labelling each by project ("In webapp: it's now chasing the null deref…"). The
plugin auto-launches exactly one global sidecar; every later `claude` you start
just gets picked up by it.

When you talk back, your message goes to the **agent the voice last spoke about**
(it announces the target on a steer — *"Sent it to webapp"* — so you can correct
it). Switch deliberately with `/focus <name>`; see who's watched with `/agents`.

### Conductor mode — spawning agents

It can also *start* agents, not just watch them. Say **"spin up an agent to write
the integration tests"** (or "spawn / start a new agent to…") and it:

1. creates an isolated **git worktree** off the focused agent's repo on a new
   `il/<slug>` branch,
2. launches a fresh `claude` there seeded with the task, running
   `--permission-mode acceptEdits` so it works unattended (override with
   `IL_SPAWN_PERMISSION`),
3. auto-discovers the new session and narrates/steers it like any other.

Because a worktree + branch are durable, it **confirms first and names the repo**
("spin up in *mach* to add tests? say yes") so a wrong target is caught before
anything is created. The task text is staged to a file and never enters the shell
command (injection-safe). Spawn requires explicit phrasing — *"have it also…"* steers
the existing agent, it doesn't spawn. No auto-merge yet; `git worktree remove` undoes a spawn.

### Aware critic — autonomous research

For research-heavy work, the conductor critiques with **outside knowledge**. When the
agent makes a consequential, checkable technical choice (a named algorithm, a non-obvious
design decision), the conductor can ask *itself* a question and run a background **literature +
reference-implementation review** — a tool-using sub-agent (`claude -p` with web search) that
forms its own view of the canonical approach from sources it actually fetches, then compares
the agent's approach against it. It grounds every claim in a fetched source (no hallucinated
citations) and **speaks up only when it finds a real divergence** — a consistent approach is
noted silently, not announced. You can also ask directly ("how does this compare to the
canonical implementation?" / `/research <topic>`).

Cost is bounded: one research at a time, a per-session cap (`IL_RESEARCH_MAX`), it won't
re-research a topic it's already covered, and `IL_AUTO_RESEARCH=0` disables the autonomous
side (explicit `/research` still works). Every auto-research is logged even when it stays quiet.

### Voice interaction model

Two "interaction model" properties are built in:

- **Push-to-talk (interrupt by voice).** Hold **Right Option (⌥)** — a global
  hotkey, so it works while you're focused on the Claude terminal. Holding stops
  narration instantly and records; releasing transcribes locally via
  **whisper.cpp** (no API key) and answers. The mic process only runs *while you
  hold the key* — it's off otherwise.
- **Continuous perception.** While you talk, the transcript tail never pauses —
  the world-model keeps ingesting the agent's actions — so the answer is always
  current. Conversation mode suppresses the narration *voice*, never the watching.

> **Why a global key + Whisper?** Terminals can't detect a key being *held*
> (stdin delivers characters, never key-up), so push-to-talk needs an OS-level
> monitor — a tiny Swift binary ([bin/ptt-monitor.swift](bin/ptt-monitor.swift))
> watching the Right-Option modifier. Right Option is used because a global
> *spacebar* would fire every time you type a space.

**One-time macOS permission:** grant **Accessibility** to your terminal app
(System Settings → Privacy & Security → Accessibility), then **fully quit and
reopen the terminal** — the grant only takes effect on relaunch. Without it the
global ⌥ monitor silently receives nothing (it will warn `NOACCESS`). NSEvent key
monitors need Accessibility specifically, not Input Monitoring. Typed questions
work regardless.

Mic check (optional): `node bin/mic-calibrate.mjs` shows a live level meter so you
can confirm the mic hears you. Disable push-to-talk with `--no-voice-in`.

### A nicer voice

The default `say` voice (Samantha) is robotic. macOS has free **Enhanced/Premium**
neural voices that sound near-Siri:

1. System Settings → Accessibility → Spoken Content → System Voice → **Manage Voices…**
2. Expand **English**, download an Enhanced/Premium voice — good picks:
   **Ava (Premium)**, **Zoe (Premium)** (US female), **Evan/Nathan (Enhanced)** (US male),
   **Serena (Premium)** (UK).
3. Restart the sidecar — it **auto-picks** a Premium/Enhanced voice. Pin a specific
   one with `IL_VOICE="Ava (Premium)"`; adjust speed with `IL_RATE` (default 180).

Preview before committing: `say -v "Ava (Premium)" "here's where the agent is at"`.

### Cartesia (low-latency, natural) — recommended

Set a Cartesia key and the tool uses Sonic automatically (falls back to `say` if a
call fails, so you're never silent):

```bash
export CARTESIA_API_KEY="…"               # in ~/.zshrc so the auto-launched window inherits it
export IL_CARTESIA_VOICE="<voice-id>"      # optional: a voice ID from cartesia.ai
export IL_CARTESIA_MODEL="sonic-2"          # optional (default)
```

### ElevenLabs (alternative)

For ElevenLabs instead, set an ElevenLabs key — the tool then uses it
automatically (falls back to `say` if a call fails, so you're never silent):

```bash
export ELEVENLABS_API_KEY="…"            # in ~/.zshrc so the auto-launched window inherits it
export IL_ELEVEN_VOICE="21m00Tcm4TlvDq8ikWAM"   # optional: a voice ID from your ElevenLabs account
export IL_ELEVEN_MODEL="eleven_flash_v2_5"       # optional: fast + cheap (default)
```

Force which engine with `IL_TTS=cartesia|eleven|say`. Playback uses `afplay`
(built-in). Auto-selection prefers Cartesia, then ElevenLabs, then local `say`.

## How it knows Claude is running

It resolves which session to follow in priority order:

1. **Hook pointer (exact).** When installed as a plugin, a `SessionStart` hook
   writes `~/.claude/interaction-layer/<project>.json` with the live session's
   real `transcript_path`. The sidecar reads that and attaches to the *exact*
   file — no guessing. `SessionEnd` marks it ended.
2. **Freshest transcript (fallback).** Without the hook, it picks the
   most-recently-modified transcript for the project and checks liveness (recent
   mtime, or a running `claude` process).

It's resilient to ordering and lifecycle:

- Launched **before** Claude? It prints *"no active session — watching…"* and
  **auto-attaches** the moment a session starts.
- A **new session** begins? It **switches** to it automatically.
- Nothing live? It tells you, instead of silently tailing a dead transcript.

## Install

Clone it, install deps, and build the small Swift helpers:

```bash
git clone https://github.com/ManiacIncorporated/interaction-layer.git
cd interaction-layer
npm install
npm run build         # compiles the Swift helpers (⌥ monitor, audio player, AirPod now-playing)
```

Requirements: macOS, Node 18+, `brew install sox whisper-cpp`, and an LLM/TTS key
(set `BASETEN_API_KEY` or `ANTHROPIC_API_KEY`; optionally `CARTESIA_API_KEY` /
`ELEVENLABS_API_KEY` for a natural voice — otherwise it uses macOS `say`).

## Using it in any folder

Two ways, depending on whether you want it automatic.

### A. Manual — run it yourself in any project

```bash
npm link              # one time: puts `interaction-layer` on your PATH
```

Then in any project (a second terminal, same dir as `claude`):

```bash
interaction-layer     # attaches to that project's running Claude session
```

### B. Automatic — install as a plugin (auto-launches everywhere)

```bash
/plugin marketplace add /path/to/interaction-layer       # the cloned repo dir
/plugin install interaction-layer@interaction-layer      # scope: user → all folders
```

Now **the first `claude` you start auto-pops one sidecar** in a new Terminal; it
then watches every other `claude` you start too (via the `SessionStart` hook +
pointer files). A global single-instance lock — claimed atomically, so several
sessions starting at once can't race — guarantees exactly one sidecar window, no
matter how many projects or cmux panes you open.

Controls:
- `IL_AUTOLAUNCH=0` — disable auto-launch (still usable manually via `interaction-layer`)
- Per-project off: add `{"enabledPlugins": {"interaction-layer@interaction-layer": false}}` to that repo's `.claude/settings.json`
- `claude plugin uninstall interaction-layer@interaction-layer` — remove entirely
- The auto-launched terminal inherits your shell env, so export `BASETEN_API_KEY`
  (or `ANTHROPIC_API_KEY`) in `~/.zshrc` to get the fast backend automatically.

> The installed plugin is a snapshot. After editing the source, re-run
> `/plugin marketplace update interaction-layer` (or reinstall) to pick up changes.

## Inference backend

The interaction model (world-model + Q&A) is pluggable. Auto-selection probes in
order and uses the first that authenticates:

| Backend   | Model | Enable with | Latency |
|-----------|-------|-------------|---------|
| `baseten` | GLM 5.2 (`zai-org/GLM-5.2`) | `BASETEN_API_KEY` | fast |
| `api`     | Claude Haiku 4.5 | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ant auth login` | ~1s |
| `sdk`     | Claude Haiku 4.5 | nothing — reuses Claude Code auth | ~4–9s |

`sdk` always works out of the box but is heavy (it loads tool schemas we can't
strip). For snappy voice, set `BASETEN_API_KEY` (GLM 5.2, via Baseten's
OpenAI-compatible [Model API](https://www.baseten.co/library/glm-52/)) or an
Anthropic key. If the chosen backend errors mid-session, it degrades to `sdk`.

Force one with `IL_BACKEND=baseten|api|sdk`. Override models with `IL_MODEL`
(Claude backends) or `IL_BASETEN_MODEL` (Baseten slug).

## Status / roadmap

- [x] Live transcript tail + parse
- [x] Templated voice narration (instant, free)
- [x] Rolling world-model + Q&A (Haiku)
- [x] Push-to-talk (hold ⌥) + local Whisper STT + continuous perception
- [x] Exact session detection (SessionStart/End hook) + auto-attach + waiting/switch
- [x] Plugin: auto-launch sidecar on `claude` start (single-instance lock)
- [ ] Lean `api` backend as default once key handling is sorted
- [ ] Configurable PTT key / cross-platform (Linux/Windows) key monitor

## Requirements

- macOS (`say` TTS; `sox` mic — `brew install sox`; Swift for the ⌥ monitor)
- `whisper-cpp` + a model: `brew install whisper-cpp` and a `ggml-*.en.bin` in
  `~/.cache/interaction-layer/` (override path with `IL_WHISPER_MODEL`)
- Node 18+
- **Accessibility** permission for your terminal app (for the ⌥ push-to-talk key;
  relaunch the terminal after granting)
```
