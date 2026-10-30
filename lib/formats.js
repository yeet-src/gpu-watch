/* Renderings of one read: JSON for programs, Markdown for agents and
 * people reading a page, a plain table for a terminal. Prometheus has
 * its own file since it is a different shape, families not devices.
 */

import { SECTIONS } from "./sections.js";

const n = (v) => (typeof v === "bigint" ? Number(v) : v == null ? null : Number(v));
export const gib = (b) => (n(b) / 2 ** 30).toFixed(2) + " GiB";
export const watts = (mw) => (n(mw) / 1000).toFixed(1) + " W";

export const json = (r) => JSON.stringify(r, null, 2) + "\n";

export function markdown(r) {
  const lines = [`# GPUs on this host`, ``, `Sampled ${r.sampled_at}. Sections: ${r.sections.join(", ")}.`, ``];
  if (r.available === false) lines.push(`No NVIDIA devices: ${r.reason}.`, ``);
  for (const d of r.devices ?? []) {
    lines.push(`## GPU ${d.index}${d.name ? `: ${d.name}` : ""}`, ``);
    for (const [label, value] of deviceRows(d)) lines.push(`- ${label}: ${value}`);
    lines.push(``);
  }
  if (r.driver) {
    lines.push(`## Driver calls (kprobes)`, ``, `| process | rm ioctls | rm time | uvm ioctls | uvm time | drm ioctls | errors |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
    for (const p of r.driver.by_process_name.slice(0, 15)) lines.push(`| ${p.comm} | ${p.rm_ioctls} | ${p.rm_ioctl_seconds.toFixed(3)} s | ${p.uvm_ioctls} | ${p.uvm_ioctl_seconds.toFixed(3)} s | ${p.drm_ioctls} | ${p.rm_errors + p.uvm_errors} |`);
    lines.push(``);
  }
  if (r.holders) {
    lines.push(`## Processes holding a GPU device node`, ``);
    if (!r.holders.processes.length) lines.push(`none`);
    for (const h of r.holders.processes) lines.push(`- ${h.pid} ${h.comm} (uid ${h.uid ?? "?"}): ${h.nodes.join(", ")}`);
    lines.push(``);
  }
  if (r.probe) lines.push(`Probe ${r.probe.up ? "attached" : "down"}${r.probe.error ? `: ${r.probe.error}` : ""}.`, ``);
  for (const w of r.warnings ?? []) lines.push(`> ${w}`);
  lines.push(`Sections available: ${Object.entries(SECTIONS).map(([k, v]) => `\`${k}\` ${v.about}`).join(" ")}`, ``);
  return lines.join("\n");
}

export function table(r) {
  const out = [];
  if (r.available === false) out.push(`no NVIDIA devices: ${r.reason}`);
  for (const d of r.devices ?? []) {
    out.push(`GPU ${d.index}${d.name ? `  ${d.name}` : ""}`);
    for (const [label, value] of deviceRows(d)) out.push(`  ${label.padEnd(14)} ${value}`);
    out.push(``);
  }
  if (r.driver) {
    out.push(`${"process".padEnd(18)} ${"rm ioctls".padStart(10)} ${"rm time".padStart(10)} ${"uvm ioctls".padStart(11)} ${"drm ioctls".padStart(11)} ${"errors".padStart(7)}`);
    for (const p of r.driver.by_process_name.slice(0, 15)) out.push(`${p.comm.padEnd(18)} ${String(p.rm_ioctls).padStart(10)} ${(p.rm_ioctl_seconds.toFixed(3) + "s").padStart(10)} ${String(p.uvm_ioctls).padStart(11)} ${String(p.drm_ioctls).padStart(11)} ${String(p.rm_errors + p.uvm_errors).padStart(7)}`);
    out.push(``);
  }
  if (r.holders) {
    out.push(`device node holders: ${r.holders.processes.length || "none"}`);
    for (const h of r.holders.processes) out.push(`  ${String(h.pid).padStart(7)}  ${h.comm.padEnd(16)} ${h.nodes.join(", ")}`);
    out.push(``);
  }
  for (const w of r.warnings ?? []) out.push(`! ${w}`);
  return out.join("\n") + "\n";
}

// The rows a device prints, in whichever sections were read.
export function deviceRows(d) {
  const rows = [];
  if (d.uuid) rows.push(["uuid", d.uuid]);
  if (d.performance_state !== undefined || d.temperature !== undefined) {
    rows.push(["state", [d.performance_state, d.temperature != null ? `${d.temperature} C` : null].filter(Boolean).join(", ")]);
  }
  if (d.power_usage !== undefined) rows.push(["power", `${watts(d.power_usage)}${d.power_limits?.enforced != null ? ` of ${watts(d.power_limits.enforced)} enforced` : ""}`]);
  if (d.utilization_rates) rows.push(["busy", `SM ${d.utilization_rates.gpu}%, memory controller ${d.utilization_rates.memory}%`]);
  if (d.memory) rows.push(["memory", `${gib(d.memory.used)} used of ${gib(d.memory.total)}, ${gib(d.memory.reserved)} reserved`]);
  if (d.clocks) rows.push(["clocks", ["graphics", "sm", "memory", "video"].map((k) => `${k} ${d.clocks[k].current}/${d.clocks[k].max} MHz`).join(", ")]);
  if (d.throttle_reasons !== undefined) rows.push(["throttle", d.throttle_reasons?.length ? d.throttle_reasons.join(", ") : "none"]);
  if (d.fan_speeds) rows.push(["fans", d.fan_speeds.length ? d.fan_speeds.map((f) => `${f}%`).join(", ") : "none"]);
  if (d.pcie) rows.push(["pcie", `gen ${d.pcie.generation}/${d.pcie.max_generation} x${d.pcie.width}/${d.pcie.max_width}, ${d.pcie.replay_counter ?? 0} replays, tx ${d.pcie.throughput?.tx ?? "?"} KB/s rx ${d.pcie.throughput?.rx ?? "?"} KB/s`]);
  if (d.ecc) rows.push(["ecc", d.ecc.enabled == null ? "not supported" : `${d.ecc.enabled ? "on" : "off"}, volatile ${d.ecc.volatile_errors?.corrected ?? 0}/${d.ecc.volatile_errors?.uncorrected ?? 0}, aggregate ${d.ecc.aggregate_errors?.corrected ?? 0}/${d.ecc.aggregate_errors?.uncorrected ?? 0} corrected/uncorrected`]);
  if (d.running_compute_processes) {
    const procs = [...d.running_compute_processes.map((p) => ({ ...p, kind: "compute" })), ...(d.running_graphics_processes ?? []).map((p) => ({ ...p, kind: "graphics" }))];
    rows.push(["processes", procs.length ? procs.map((p) => `${p.pid} ${p.process?.stat?.comm ?? "?"} (${p.kind}${p.used_gpu_memory != null ? `, ${gib(p.used_gpu_memory)}` : ""})`).join("; ") : "none"]);
  }
  return rows;
}
