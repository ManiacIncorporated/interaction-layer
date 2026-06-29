// Hands-free trigger via an AirPod (or any) play-pause tap.
//
// macOS delivers Bluetooth AirPod taps (an AVRCP command) to the "now playing" media
// app via MediaRemote — they never surface as an event a CGEventTap can see, and the
// raw AVRCP/AACP Bluetooth channels aren't app-accessible. So we BECOME a now-playing
// app: loop a silent AVPlayer track (AVAudioEngine output does NOT register on recent
// macOS — only real AVPlayer playback does) and register MPRemoteCommandCenter
// handlers. A play/pause tap then arrives as a command and we record a TOGGLE.
//
// CRITICAL: this only works when LAUNCHED THROUGH LaunchServices (`open Foo.app`) as a
// real bundle — a directly-spawned binary is not command-eligible. Because `open`
// detaches stdout, we signal the sidecar by appending to an event file.
//
// Build via build-nowplaying.sh. Verified on macOS 26.3: AirPod taps fire commands.
import Cocoa
import AVFoundation
import MediaPlayer

let STARTUP_GRACE = 1.5 // s — ignore the burst of pause commands right after launch
let DEBOUNCE = 0.5      // s — collapse a single tap's multiple events into one toggle

// Event channel: a file both sides agree on (open() detaches our stdout).
let eventFile = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent(".cache/interaction-layer/airpod.events")

func writeEvent(_ s: String) {
  try? FileManager.default.createDirectory(
    at: eventFile.deletingLastPathComponent(), withIntermediateDirectories: true)
  if let h = try? FileHandle(forWritingTo: eventFile) {
    h.seekToEndOfFile()
    h.write((s + "\n").data(using: .utf8)!)
    try? h.close()
  } else {
    try? (s + "\n").write(to: eventFile, atomically: true, encoding: .utf8)
  }
}

// fresh event file for this run
try? "".write(to: eventFile, atomically: true, encoding: .utf8)

// --- a 5s silent stereo WAV, looped, to hold the now-playing slot ---
func silentWav() -> URL {
  let sr = 44100, ch = 2, secs = 5
  let dataBytes = sr * ch * 2 * secs
  var d = Data()
  func le32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
  func le16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
  d.append("RIFF".data(using: .ascii)!); le32(UInt32(36 + dataBytes)); d.append("WAVE".data(using: .ascii)!)
  d.append("fmt ".data(using: .ascii)!); le32(16); le16(1); le16(UInt16(ch)); le32(UInt32(sr))
  le32(UInt32(sr * ch * 2)); le16(UInt16(ch * 2)); le16(16)
  d.append("data".data(using: .ascii)!); le32(UInt32(dataBytes)); d.append(Data(count: dataBytes))
  let u = FileManager.default.temporaryDirectory.appendingPathComponent("il-silence.wav")
  try? d.write(to: u)
  return u
}

let queue = AVQueuePlayer()
queue.automaticallyWaitsToMinimizeStalling = false // else it can sit in "waiting" and never become now-playing
let looper = AVPlayerLooper(player: queue, templateItem: AVPlayerItem(url: silentWav()))
queue.volume = 1.0 // the samples are zero, so it's silent regardless
queue.play()

let nowPlaying = MPNowPlayingInfoCenter.default()
nowPlaying.nowPlayingInfo = [
  MPMediaItemPropertyTitle: "Claude Conductor — tap to talk",
  MPMediaItemPropertyPlaybackDuration: 5.0,
  MPNowPlayingInfoPropertyElapsedPlaybackTime: 0.0,
  MPNowPlayingInfoPropertyPlaybackRate: 1.0,
]
nowPlaying.playbackState = .playing

let startedAt = Date()
var lastTap = Date(timeIntervalSince1970: 0)
func onCommand() -> MPRemoteCommandHandlerStatus {
  let now = Date()
  queue.play() // never actually pause — stay the command target
  nowPlaying.playbackState = .playing
  if now.timeIntervalSince(startedAt) < STARTUP_GRACE { return .success } // settle burst
  if now.timeIntervalSince(lastTap) < DEBOUNCE { return .success }        // one tap = one toggle
  lastTap = now
  writeEvent("TOGGLE")
  return .success
}

let cc = MPRemoteCommandCenter.shared()
for cmd in [cc.togglePlayPauseCommand, cc.playCommand, cc.pauseCommand] {
  cmd.isEnabled = true
  cmd.addTarget { _ in onCommand() }
}

// Watchdog: keep playing + re-assert now-playing. NOTE: empirically this does NOT
// reliably win the now-playing slot on macOS 26 — taps only reach us when the system
// happens to hand us the slot. Kept as best-effort.
Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in
  if queue.timeControlStatus != .playing { queue.play() }
  nowPlaying.playbackState = .playing
}

writeEvent("READY")
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
