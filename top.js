/* The terminal face: a live view on the tty portal, so
 * `yeet dial ws://host:9480/top` is nvidia-smi that updates in place
 * and remembers. Each signal is a sparkline of the last few minutes
 * beside its current value, so a GPU that sawtooths between busy and
 * idle looks like a sawtooth and not like a number that flickers.
 * `--interval` and `--fields` are the unit's args in the service file.
 */

import { select } from "./lib/sections.js";
import { read, readDisks } from "./lib/read.js";
import { deviceRows, gib } from "./lib/formats.js";

const args = yeet.args ?? {};
const INTERVAL_MS = Math.max(200, Number(args.interval) || 1000);
const SECTIONS = select(args.fields ?? "device,power,thermal,utilization,memory,clocks,pcie,processes");
const HISTORY = 600;
const BARS = "▁▂▃▄▅▆▇█";

// Per device, per signal, the last HISTORY samples.
const history = new Map();
const n = (v) => (typeof v === "bigint" ? Number(v) : v == null ? null : Number(v));

/* The host side, which no GPU tool shows beside the GPU: what each
 * process holding a context is doing with the CPU, and whether the
 * disks are busy. Both are rates between two ticks, so the previous
 * counters are kept per pid and per disk.
 */
const lastCpu = new Map();
const lastDisk = new Map();
let hz = 100;
// `h` hides and shows the host side, so a demo can show the GPU view
// every tool has, then the same screen with the host beside it.
let showHost = true;

function cpuPercent(p, now) {
  const s = p.process?.stat;
  if (!s) return null;
  const ticks = s.utime + s.stime;
  const prev = lastCpu.get(p.pid);
  lastCpu.set(p.pid, { ticks, now });
  if (!prev || now === prev.now) return null;
  return (100 * (ticks - prev.ticks)) / hz / ((now - prev.now) / 1000);
}

function diskRows(disks, now) {
  const rows = [];
  for (const d of disks) {
    const prev = lastDisk.get(d.name);
    lastDisk.set(d.name, { busy: n(d.time_in_progress), read: n(d.bytes_read), write: n(d.bytes_written), now });
    if (!prev || now === prev.now) continue;
    const dt = (now - prev.now) / 1000;
    rows.push({
      name: d.name,
      busy: (100 * (n(d.time_in_progress) - prev.busy)) / 1000 / dt,
      read: (n(d.bytes_read) - prev.read) / dt,
      write: (n(d.bytes_written) - prev.write) / dt,
      inflight: n(d.in_progress),
    });
  }
  // Partitions and mappers repeat their disk; the busiest two tell the story.
  return rows.sort((a, b) => b.busy - a.busy).slice(0, 2);
}

const mib = (b) => (b / 2 ** 20).toFixed(1) + " MiB/s";

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

function render(r, disks) {
  const now = Date.now();
  hz = r.host?.ticks_per_second || hz;
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
      if (["busy", "memory", "uuid", "clocks", "power", "processes"].includes(label)) continue;
      const shown = label === "throttle" && value !== "none" ? style.yellow(value) : value;
      tty.write(style.dim(label.padEnd(10)) + shown + "\n");
    }
    const procs = [...(d.running_compute_processes ?? []).map((p) => ({ ...p, kind: "compute" })), ...(d.running_graphics_processes ?? []).map((p) => ({ ...p, kind: "graphics" }))];
    if (d.running_compute_processes && showHost) {
      tty.write("\n" + style.bold("on the host") + style.dim("   what each process holding a context is doing with the CPU") + "\n");
      if (!procs.length) tty.write(style.dim("  no process holds a context\n"));
      for (const p of procs) {
        const s = p.process?.stat;
        const cpu = cpuPercent(p, now);
        const cpuText = cpu == null ? "   -- " : `${String(Math.round(cpu)).padStart(4)}%`;
        const cpuShown = cpu != null && cpu >= 300 ? style.yellow(cpuText) : cpuText;
        tty.write(`  ${String(p.pid).padStart(7)}  ${(s?.comm ?? "?").padEnd(16)} cpu ${cpuShown}  rss ${s ? gib(s.rss_bytes).padStart(9) : "?"}  threads ${String(s?.num_threads ?? "?").padStart(3)}  vram ${p.used_gpu_memory == null ? "?" : gib(p.used_gpu_memory)}  ${style.dim(p.kind)}\n`);
      }
    }
    tty.write("\n");
  }
  const rows = diskRows(disks, now);
  if (rows.length && showHost) {
    for (const x of rows) {
      const busy = `${String(Math.round(x.busy)).padStart(3)}%`;
      tty.write(style.dim("disk".padEnd(10)) + `${x.name.padEnd(10)} busy ${x.busy >= 80 ? style.yellow(busy) : busy}  read ${mib(x.read).padStart(12)}  write ${mib(x.write).padStart(12)}  in flight ${x.inflight}\n`);
    }
    tty.write("\n");
  }
  for (const w of r.warnings ?? []) tty.write(style.yellow(`! ${w}\n`));
  tty.write(style.dim(`every ${INTERVAL_MS}ms, ${r.sampled_at}   h: ${showHost ? "hide" : "show"} the host side   ctrl-c to quit`) + "\n");
}

async function tick() {
  try {
    const [r, disks] = await Promise.all([read(SECTIONS), readDisks().catch(() => [])]);
    render(r, disks);
  } catch (error) {
    tty.clear();
    tty.write(style.red(`error: ${error?.message ?? error}\n`));
  }
}

tty.on("keydown", (e) => {
  if (e.code === "h" && !e.ctrlKey) {
    showHost = !showHost;
    tick();
  }
});

tty.alt(); tty.hideCursor(); tty.title("yeet gpu");
await tick();
setInterval(tick, INTERVAL_MS);
