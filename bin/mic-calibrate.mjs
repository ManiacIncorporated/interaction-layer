#!/usr/bin/env node
// Mic tuning tool. Run it, then talk normally. It shows a live level meter, the
// current speech threshold, and fires SPEECH START/END so you can confirm the
// VAD triggers on your voice and pick a sensitivity.
//
//   node bin/mic-calibrate.mjs [sensitivity]   (default 1; try 1.5–3 if needed)
//
import { Mic } from "../src/mic.mjs";

const sensitivity = Number(process.argv[2]) || 1;
const mic = new Mic({ sensitivity });
let thr = 0;

mic.on("ready", (i) => {
  thr = i.threshold;
  console.log(
    `\nArmed. floor≈${i.floor.toFixed(0)} threshold≈${i.threshold.toFixed(0)} (sensitivity ${sensitivity}).`
  );
  console.log("Talk now. Bars should spike past │ and fire SPEECH. Ctrl-C to stop.\n");
});

mic.on("rms", (l) => {
  thr = mic.floor ? mic._threshold() : thr;
  const bars = Math.min(50, Math.round(l / 40));
  const mark = Math.min(50, Math.round(thr / 40));
  let row = "";
  for (let i = 0; i < 50; i++) row += i === mark ? "│" : i < bars ? "█" : " ";
  process.stdout.write(`\r[${row}] ${l.toFixed(0).padStart(5)}`);
});

mic.on("speechstart", () => process.stdout.write("  ◀ SPEECH START\n"));
mic.on("speechend", (b) =>
  process.stdout.write(`  ◀ SPEECH END (${(b.length / 32000).toFixed(1)}s)\n`)
);
mic.on("error", (e) => {
  console.error("\nmic error:", e.message);
  process.exit(1);
});

console.log("Calibrating ambient noise — stay quiet for ~1s…");
mic.start();
process.on("SIGINT", () => {
  mic.stop();
  process.exit(0);
});
