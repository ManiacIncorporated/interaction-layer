// Low-latency streaming audio player. Reads raw PCM (s16le, 44.1kHz, mono) from
// stdin and plays it via CoreAudio as it arrives — first sound within ~tens of ms
// of the first bytes, instead of waiting for a whole file like afplay. Applies a
// pitch-preserving speed multiplier (IL_SPEED). Exits when stdin closes and all
// audio has played; SIGTERM stops instantly (barge-in).
//
//   swiftc -O audio-stream.swift -o audio-stream
import AVFoundation
import Foundation

let speed = Float(ProcessInfo.processInfo.environment["IL_SPEED"] ?? "1.0") ?? 1.0
let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 1, interleaved: false)!

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
let timePitch = AVAudioUnitTimePitch()
timePitch.rate = max(0.5, min(3.0, speed)) // speed without pitch shift

engine.attach(player)
engine.attach(timePitch)
engine.connect(player, to: timePitch, format: fmt)
engine.connect(timePitch, to: engine.mainMixerNode, format: fmt)
do { try engine.start() } catch { FileHandle.standardError.write("audio-stream: engine start failed\n".data(using: .utf8)!); exit(1) }
player.play()

let lock = NSLock()
var inFlight = 0      // buffers scheduled but not yet played
var inputDone = false

func finishIfDone() {
    lock.lock(); let done = inputDone && inFlight == 0; lock.unlock()
    if done { exit(0) }
}

func schedule(_ data: Data) {
    let n = data.count / 2
    guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n)) else { return }
    buf.frameLength = AVAudioFrameCount(n)
    let out = buf.floatChannelData![0]
    data.withUnsafeBytes { raw in
        let s = raw.bindMemory(to: Int16.self)
        for i in 0..<n { out[i] = Float(Int16(littleEndian: s[i])) / 32768.0 }
    }
    lock.lock(); inFlight += 1; lock.unlock()
    // .dataPlayedBack fires when the buffer has actually played OUT, not merely
    // been consumed by the engine (the default). Without this the process exits a
    // buffer-latency early and its tail audio bleeds into the next utterance.
    player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { _ in
        lock.lock(); inFlight -= 1; lock.unlock()
        finishIfDone()
    }
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

// Read stdin and schedule audio in small blocks for low first-audio latency.
DispatchQueue.global().async {
    let stdin = FileHandle.standardInput
    var carry = Data()
    let block = 4096 // bytes (~46ms) — small so the first sound starts fast
    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty { break } // EOF
        carry.append(chunk)
        while carry.count >= block {
            schedule(carry.prefix(block))
            carry.removeFirst(block)
        }
    }
    if !carry.isEmpty { schedule(carry) }
    lock.lock(); inputDone = true; lock.unlock()
    finishIfDone()
}

RunLoop.main.run()
