// GUI keystroke fallback for desktop agent apps that expose no API or TTY — Claude
// desktop, Codex desktop, Cursor. This is deliberately BEST-EFFORT and comes with two
// hard safety rules (see the advisor notes in the write-path design):
//
//  1. NEVER blind-send. GUI keystroke can only reach a window, and the wrong window
//     means typing project A's steer into project B. So we use the Accessibility API
//     to find the app window whose TITLE contains the target project, raise THAT
//     window, and only then type. No title match → refuse (return "NOMATCH").
//  2. EXPLICIT-SEND ONLY. Activating an app steals the user's focus, so this is wired
//     only into user-initiated relays, never the ambient auto-narration loop.
//
// Focus shortcut (to move keyboard focus into the agent's input after raising the
// window) is app-specific and unverified across versions — configurable via env.
import { execFile } from "node:child_process";

// bundleId is informational; automation targets by process/app name. focus is the
// keystroke that focuses the chat/agent input: "<modifier>:<key>" (e.g. "command:l").
// submit: how to SEND after typing. Enter sends in terminals and most chat inputs,
// but some composers use Cmd+Enter (Enter = newline there). "return" | "command:return"
// | "shift:return", overridable per app via env.
export const APP_PROFILES = {
  claude: { app: "Claude", bundleId: "com.anthropic.claudefordesktop", focus: process.env.IL_CLAUDE_FOCUS ?? "", submit: process.env.IL_CLAUDE_SUBMIT ?? "return" },
  codex: { app: "Codex", bundleId: "com.openai.codex", focus: process.env.IL_CODEX_FOCUS ?? "", submit: process.env.IL_CODEX_SUBMIT ?? "return" },
  cursor: { app: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92", focus: process.env.IL_CURSOR_FOCUS ?? "command:l", submit: process.env.IL_CURSOR_SUBMIT ?? "return" },
};

// AppleScript: find the app window whose title contains `hint`, raise it, optionally
// focus the input, then type `text` + Return. Returns OK / NOMATCH / NOAPP / ERROR.
// argv: 1=appName 2=hint 3=text 4=focusModifier 5=focusKey 6=submitModifier
const OSA = `
on run argv
  set appName to item 1 of argv
  set hint to item 2 of argv
  set theText to item 3 of argv
  set fMod to item 4 of argv
  set fKey to item 5 of argv
  set sMod to item 6 of argv
  tell application "System Events"
    if not (exists process appName) then return "NOAPP"
    tell process appName
      set target to missing value
      repeat with w in windows
        try
          if hint is "" or (name of w contains hint) then
            set target to w
            exit repeat
          end if
        end try
      end repeat
      if target is missing value then return "NOMATCH"
      set frontmost to true
      try
        perform action "AXRaise" of target
      end try
      delay 0.2
      if fKey is not "" then
        if fMod is "command" then
          keystroke fKey using command down
        else if fMod is "control" then
          keystroke fKey using control down
        else
          keystroke fKey
        end if
        delay 0.15
      end if
      keystroke theText
      delay 0.06
      if sMod is "command" then
        key code 36 using command down
      else if sMod is "shift" then
        key code 36 using shift down
      else
        key code 36
      end if
      return "OK"
    end tell
  end tell
end run`;

// Send `text` to a desktop app's agent input, scoped to the window matching `hint`
// (usually the project/dir name). Resolves "OK" | "NOMATCH" | "NOAPP" | "ERROR:<msg>".
export function guiSend(text, sourceOrProfile, hint = "") {
  const p = typeof sourceOrProfile === "string" ? APP_PROFILES[sourceOrProfile] : sourceOrProfile;
  if (!p) return Promise.resolve("ERROR:unknown app");
  const [fMod, fKey] = (p.focus || "").includes(":") ? p.focus.split(":") : ["", p.focus || ""];
  const sMod = (p.submit || "return").includes(":") ? p.submit.split(":")[0] : ""; // modifier for the Return submit
  return new Promise((resolve) => {
    execFile("osascript", ["-e", OSA, p.app, hint, text, fMod, fKey, sMod], (err, stdout) => {
      if (err) return resolve("ERROR:" + (err.message || "").split("\n")[0]);
      resolve((stdout || "").trim() || "ERROR:no result");
    });
  });
}
