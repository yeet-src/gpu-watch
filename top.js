/* The terminal face: a live view on the tty portal, so
 * `yeet dial ws://host:9480/top` is nvidia-smi that updates in place
 * and remembers. Each signal is a sparkline of the last few minutes
 * beside its current value, so a GPU that sawtooths between busy and
 * idle looks like a sawtooth and not like a number that flickers.
 * `--interval` and `--fields` are the unit's args in the service file.
 */

import { select } from "./lib/sections.js";
import { read } from "./lib/read.js";
import { deviceRows, gib } from "./lib/formats.js";

const args = yeet.args ?? {};
const INTERVAL_MS = Math.max(200, Number(args.interval) || 1000);
const SECTIONS = select(args.fields ?? "device,power,thermal,utilization,memory,clocks,pcie,processes");
const HISTORY = 600;
const BARS = "▁▂▃▄▅▆▇█";

// Per device, per signal, the last HISTORY samples.
const history = new Map();
const n = (v) => (typeof v === "bigint" ? Number(v) : v == null ? null : Number(v));

function remember(d) {
  const h = history.get(d.index) ?? new Map();
  const push = (key, v) => {
    if (v == null) return;
    const arr = h.get(key) ?? [];
    arr.push(v);
    if (arr.length > HISTORY) arr.shift();
    h.set(key, arr);
  };
  push("gpu busy", n(d.utilization_rates?.gpu));
  push("mem busy", n(d.utilization_rates?.memory));
  push("vram", d.memory ? (100 * n(d.memory.used)) / n(d.memory.total) : null);
  push("sm clock", d.clocks?.sm ? (100 * n(d.clocks.sm.current)) / n(d.clocks.sm.max) : null);
  push("power", d.power_usage != null && d.power_limits?.enforced ? (100 * n(d.power_usage)) / n(d.power_limits.enforced) : null);
  push("temp", n(d.temperature));
  history.set(d.index, h);
}

/* A sparkline over the last `width` samples, scaled to `max`. The
 * colour follows the latest value so the eye lands on the right end.
 */
function spark(samples, width, max) {
  const tail = samples.slice(-width);
  const pad = " ".repeat(Math.max(0, width - tail.length));
  const glyphs = tail.map((v) => BARS[Math.min(7, Math.max(0, Math.round((v / max) * 7)))]).join("");
  const last = tail[tail.length - 1] ?? 0;
  const pct = (100 * last) / max;
  const color = pct >= 90 ? style.red : pct >= 50 ? style.yellow : style.green;
  return pad + color(glyphs);
}

function render(r) {
  const { cols } = tty.size();
  const width = Math.max(20, Math.min(100, cols - 32));
  const span = (width * INTERVAL_MS) / 1000;
  tty.clear();
  if (r.available === false) return tty.write(style.red(`no NVIDIA devices: ${r.reason}\n`));
  for (const d of r.devices ?? []) {
    remember(d);
    const h = history.get(d.index);
    tty.write(style.bold(style.cyan(`GPU ${d.index}  ${d.name ?? ""}`)) + style.dim(`   last ${span >= 60 ? (span / 60).toFixed(1) + " min" : span.toFixed(0) + " s"}, newest at the right`) + "\n");
    tty.write(style.dim("─".repeat(Math.min(cols, width + 32))) + "\n");
    const row = (key, max, label) => {
      const s = h.get(key);
      if (!s) return;
      tty.write(style.dim(key.padEnd(10)) + spark(s, width, max) + " " + label(s[s.length - 1]) + "\n");
    };
    row("gpu busy", 100, (v) => `${String(Math.round(v)).padStart(3)}%`);
    row("mem busy", 100, (v) => `${String(Math.round(v)).padStart(3)}%`);
    row("vram", 100, () => `${gib(d.memory.used)} / ${gib(d.memory.total)}`);
    row("sm clock", 100, () => `${d.clocks.sm.current}/${d.clocks.sm.max} MHz`);
    row("power", 100, () => `${(n(d.power_usage) / 1000).toFixed(0)} W / ${(n(d.power_limits.enforced) / 1000).toFixed(0)} W`);
    row("temp", 100, (v) => `${v} C`);
    tty.write("\n");
    for (const [label, value] of deviceRows(d)) {
      if (["busy", "memory", "uuid", "clocks", "power"].includes(label)) continue;
      const shown = label === "throttle" && value !== "none" ? style.yellow(value) : value;
      tty.write(style.dim(label.padEnd(10)) + shown + "\n");
    }
    tty.write("\n");
  }
  for (const w of r.warnings ?? []) tty.write(style.yellow(`! ${w}\n`));
  tty.write(style.dim(`every ${INTERVAL_MS}ms, ${r.sampled_at}  ctrl-c to quit`) + "\n");
}

async function tick() {
  try {
    render(await read(SECTIONS));
  } catch (error) {
    tty.clear();
    tty.write(style.red(`error: ${error?.message ?? error}\n`));
  }
}

tty.alt(); tty.hideCursor(); tty.title("yeet gpu");
await tick();
setInterval(tick, INTERVAL_MS);
