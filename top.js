/* The terminal face: a live view on the tty portal, so
 * `yeet dial ws://host:9480/top` is nvidia-smi that updates in place.
 * `--interval` and `--fields` are the unit's args in the service file.
 */

import { select } from "./lib/sections.js";
import { read } from "./lib/read.js";
import { deviceRows, gib } from "./lib/formats.js";

const args = yeet.args ?? {};
const INTERVAL_MS = Math.max(200, Number(args.interval) || 1000);
const SECTIONS = select(args.fields ?? "device,power,thermal,utilization,memory,clocks,pcie,processes");

function bar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  const color = pct >= 90 ? style.red : pct >= 50 ? style.yellow : style.green;
  return color("█".repeat(filled)) + style.dim("░".repeat(width - filled));
}

function render(r) {
  const { cols } = tty.size();
  const w = Math.max(10, Math.min(40, cols - 30));
  tty.clear();
  if (r.available === false) return tty.write(style.red(`no NVIDIA devices: ${r.reason}\n`));
  for (const d of r.devices ?? []) {
    tty.write(style.bold(style.cyan(`GPU ${d.index}  ${d.name ?? ""}`)) + "\n");
    tty.write(style.dim("─".repeat(Math.min(cols, 60))) + "\n");
    if (d.utilization_rates) {
      tty.write(style.dim("gpu busy".padEnd(12)) + bar(d.utilization_rates.gpu, w) + ` ${String(d.utilization_rates.gpu).padStart(3)}%\n`);
      tty.write(style.dim("mem busy".padEnd(12)) + bar(d.utilization_rates.memory, w) + ` ${String(d.utilization_rates.memory).padStart(3)}%\n`);
    }
    if (d.memory) {
      const pct = Math.round((Number(d.memory.used) / Number(d.memory.total)) * 100);
      tty.write(style.dim("vram".padEnd(12)) + bar(pct, w) + ` ${gib(d.memory.used)} / ${gib(d.memory.total)}\n`);
    }
    for (const [label, value] of deviceRows(d)) {
      if (["busy", "memory", "uuid"].includes(label)) continue;
      const shown = label === "throttle" && value !== "none" ? style.yellow(value) : value;
      tty.write(style.dim(label.padEnd(12)) + shown + "\n");
    }
    tty.write("\n");
  }
  for (const wmsg of r.warnings ?? []) tty.write(style.yellow(`! ${wmsg}\n`));
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
