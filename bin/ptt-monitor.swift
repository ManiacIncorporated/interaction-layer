// Global push-to-talk monitor. Prints "DOWN" when the push-to-talk key is
// pressed and "UP" when released, from any app, so you can hold it while focused
// on the Claude terminal.
//
// Uses a CGEventTap (listen-only) on flagsChanged — this needs INPUT MONITORING
// permission (not Accessibility), and unlike NSEvent's global monitor it works
// reliably from a command-line binary and reports a clear failure if it isn't
// permitted (tap creation returns nil -> we print NOACCESS).
//
//   swiftc -O ptt-monitor.swift -o ptt-monitor   (or run via `swift`)
//   --debug : print the keyCode of every modifier change (to find your key)
import Cocoa

// Default trigger = right ⌥ (keyCode 61). Override with IL_PTT_KEYCODE.
let env = ProcessInfo.processInfo.environment
let PTT_KEY = Int64(env["IL_PTT_KEYCODE"] ?? "") ?? 61
let DEBUG = CommandLine.arguments.contains("--debug")
setbuf(stdout, nil) // unbuffered so Node sees events immediately

// Top-level C-compatible callback (captures nothing; reads globals).
func onEvent(
  proxy: CGEventTapProxy, type: CGEventType, event: CGEvent,
  refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  if type == .flagsChanged {
    let kc = event.getIntegerValueField(.keyboardEventKeycode)
    let optionDown = event.flags.contains(.maskAlternate)
    if DEBUG {
      print("flagsChanged keyCode=\(kc) option=\(optionDown)")
    } else if kc == PTT_KEY {
      // option flag present = just pressed; absent = just released.
      print(optionDown ? "DOWN" : "UP")
    }
  }
  return Unmanaged.passUnretained(event)
}

let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
guard
  let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
    eventsOfInterest: mask, callback: onEvent, userInfo: nil)
else {
  print("NOACCESS") // not permitted — needs Input Monitoring
  exit(1)
}

let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
print("READY")
CFRunLoopRun()
