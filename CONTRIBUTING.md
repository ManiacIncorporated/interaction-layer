# Contributing

Thanks for your interest in interaction-layer. It's a voice "awareness" sidecar
for Claude Code — a peer-engineer voice that narrates the coding agent's work,
answers questions, steers and spawns agents, and critiques with grounded research.

## Setup

```bash
npm install
npm run build          # compile the Swift helpers (ptt-monitor, audio-stream, nowplaying-monitor)
brew install sox whisper-cpp
```

Run it (no arg = watch every active Claude session; a dir = just that project):

```bash
node bin/interaction-layer.mjs
```

Useful env vars: `IL_BACKEND` (baseten|api|sdk), `BASETEN_API_KEY` /
`ANTHROPIC_API_KEY`, `CARTESIA_API_KEY` / `ELEVENLABS_API_KEY`, `IL_NARRATE_SECS`,
`IL_STALL_SECS`, `IL_AUTO_RESEARCH`, `IL_SPAWN_PERMISSION`. macOS only for now
(uses `say`/CoreAudio, AppleScript/cmux for steering, whisper.cpp for STT).

## Layout

- `bin/interaction-layer.mjs` — orchestrator (discovery, voice loop, conversation/turn arbitration).
- `src/agent.mjs` — `WatchedAgent`: per-session tail, buffers, metrics, narration beat.
- `src/model.mjs` — the LLM interaction model (narration protocol, `converse`, `resolveAgent`, backends).
- `src/session.mjs` — `MultiWatcher` / `SessionWatcher` (which sessions to follow).
- `src/transcript.mjs` — tail + parse Claude Code JSONL transcripts.
- `src/voice.mjs` `src/mic.mjs` `src/stt.mjs` — TTS, mic capture, whisper STT.
- `src/inject.mjs` — steering (cmux socket / Terminal.app).
- `src/spawn.mjs` `src/research.mjs` — conductor: spawn agents, grounded research critic.

## Design principle: guardrails over guidance, grounded over clever

When the layer rewrites a vague spoken instruction into a prompt for the coding
agent (and when it spawns one), it follows what the research actually shows works
for coding agents — not "magic wording":

- **Guardrails beat guidance.** Negative constraints ("don't refactor unrelated
  code", "don't weaken tests to pass") help; positive style pep-talk tends to hurt.
- **Complexity hurts.** Terse, scoped instructions beat elaborate role/checklist
  prompts. Only expand the part of an instruction that's actually underspecified.
- **Defensive + verify.** Emphasize edge cases and a real test/verification loop
  (run the narrowest relevant test) over abstract "be careful".
- **Grounded, never fabricated.** Only reference files/tests/constraints that are
  actually in context; never invent specifics or add requirements the user didn't
  state. Same rule for the research critic: every claim cites a fetched source.

If you change the prompting in `src/model.mjs`, keep these in mind, and test the
**false-positive direction** (a precise instruction must stay terse; a vague one
must not invent scope).

## PRs

- Keep changes focused; match the surrounding code's style and comment density.
- This project itself was built incrementally with heavy verification — please
  test your change end-to-end (the modules have no formal test suite yet; a small
  Node harness against `src/*.mjs` is the norm).
- By contributing you agree your contributions are licensed under Apache-2.0.
