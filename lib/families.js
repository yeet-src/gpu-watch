/* The Prometheus families, grouped by section so `/metrics?fields=`
 * cuts them the same way every other interface does. Each family is
 * a gauge or counter over the devices or the sampler's totals in one
 * read; a value the card lacks is left out, never printed as 0.
 */

import { Exposition, num } from "./prom.js";
import { RM_ESCAPES, UVM_ESCAPES } from "../names.js";

const DOMAINS = ["graphics", "sm", "memory", "video"];
const LIMITS = ["current", "enforced", "default", "min", "max"];
const MEMORY = ["total", "used", "free", "reserved"];
const THROTTLE_REASONS = [
  "GPU_IDLE", "APPLICATIONS_CLOCKS_SETTING", "SW_POWER_CAP", "HW_SLOWDOWN", "SYNC_BOOST",
  "SW_THERMAL_SLOWDOWN", "HW_THERMAL_SLOWDOWN", "HW_POWER_BRAKE_SLOWDOWN", "DISPLAY_CLOCK_SETTING",
];

export function exposition(r, { pidTtlMs = 300_000 } = {}) {
  const out = new Exposition();
  const devices = r.devices ?? [];
  const dev = (d) => ({ gpu: d.index, uuid: d.uuid });
  const has = (s) => r.sections.includes(s);
  for (const w of r.warnings ?? []) out.comment(w);

  out.gauge("gpu_exporter_up", "1 when the exporter could read the system graph.", [[{}, 1]]);
  if (r.available !== undefined) out.gauge("nvidia_gpu_count", "NVIDIA devices NVML reports; absent when NVML is not loaded.", r.available ? [[{}, r.count]] : []);

  if (has("device")) {
    out.gauge("nvidia_gpu_info", "One row per device: its index, UUID, product name and board id.", devices.map((d) => [{ ...dev(d), name: d.name, board_id: d.board_id }, 1]));
  }
  if (has("power")) {
    out.gauge("nvidia_gpu_power_watts", "Power draw of the whole board.", devices.map((d) => [dev(d), num(d.power_usage) / 1000]));
    out.counter("nvidia_gpu_energy_joules_total", "Energy consumed since the driver loaded.", devices.map((d) => [dev(d), num(d.total_energy_consumption) / 1000]));
    out.gauge("nvidia_gpu_power_limit_watts", "Power limits: the current and enforced caps, the default, and the range the card accepts.", devices.flatMap((d) => LIMITS.map((limit) => [{ ...dev(d), limit }, d.power_limits?.[limit] == null ? null : num(d.power_limits[limit]) / 1000])));
  }
  if (has("thermal")) {
    out.gauge("nvidia_gpu_temperature_celsius", "GPU die temperature.", devices.map((d) => [dev(d), d.temperature]));
    out.gauge("nvidia_gpu_fan_speed_ratio", "Fan speed as a share of its maximum, 0 to 1, one row per fan.", devices.flatMap((d) => (d.fan_speeds ?? []).map((s, fan) => [{ ...dev(d), fan }, s / 100])));
    out.gauge("nvidia_gpu_performance_state", "Performance state as a number, 0 (P0, maximum) to 15 (P15, minimum); absent when unknown.", devices.map((d) => {
      const m = /^P(\d+)$/.exec(d.performance_state ?? "");
      return [dev(d), m ? Number(m[1]) : null];
    }));
    out.gauge("nvidia_gpu_throttle_reason", "1 while the reason is holding the clocks down, one row per reason; absent when the driver cannot report them.", devices.flatMap((d) =>
      d.throttle_reasons == null ? [] : THROTTLE_REASONS.map((reason) => [{ ...dev(d), reason: reason.toLowerCase() }, d.throttle_reasons.includes(reason) ? 1 : 0]),
    ));
  }
  if (has("utilization")) {
    out.gauge("nvidia_gpu_utilization_ratio", "Share of the last sample window in which a kernel was running, 0 to 1.", devices.map((d) => [dev(d), num(d.utilization_rates?.gpu) / 100]));
    out.gauge("nvidia_gpu_memory_utilization_ratio", "Share of the last sample window in which device memory was being read or written, 0 to 1.", devices.map((d) => [dev(d), num(d.utilization_rates?.memory) / 100]));
  }
  if (has("memory")) {
    for (const field of MEMORY) out.gauge(`nvidia_gpu_memory_${field}_bytes`, `Device memory ${field === "reserved" ? "reserved by the driver" : field}.`, devices.map((d) => [dev(d), num(d.memory?.[field])]));
  }
  if (has("clocks")) {
    const clock = (field, help) => out.gauge(`nvidia_gpu_clock${field === "current" ? "" : `_${field}`}_hertz`, help, devices.flatMap((d) => DOMAINS.map((domain) => [{ ...dev(d), domain }, d.clocks?.[domain]?.[field] == null ? null : num(d.clocks[domain][field]) * 1e6])));
    clock("current", "Current clock of the domain: graphics, sm, memory or video.");
    clock("max", "Highest clock the domain can reach.");
    clock("application", "Clock the domain is pinned to by application clock settings; absent when none is set.");
  }
  if (has("pcie")) {
    out.gauge("nvidia_gpu_pcie_link_generation", "PCIe generation the link is running at now; it drops when the card idles.", devices.map((d) => [dev(d), d.pcie?.generation]));
    out.gauge("nvidia_gpu_pcie_link_width", "PCIe lanes the link is running at now.", devices.map((d) => [dev(d), d.pcie?.width]));
    out.gauge("nvidia_gpu_pcie_link_max_generation", "Highest PCIe generation the card and slot support.", devices.map((d) => [dev(d), d.pcie?.max_generation]));
    out.gauge("nvidia_gpu_pcie_link_max_width", "Most PCIe lanes the card and slot support.", devices.map((d) => [dev(d), d.pcie?.max_width]));
    out.counter("nvidia_gpu_pcie_replays_total", "PCIe link replays (retries) since the driver loaded; a rising count means a flaky link.", devices.map((d) => [dev(d), d.pcie?.replay_counter]));
    out.gauge("nvidia_gpu_pcie_throughput_bytes_per_second", "PCIe traffic over the last sample window, tx from the card and rx into it; NVML reports KB/s, taken as 1000 bytes.", devices.flatMap((d) => ["tx", "rx"].map((direction) => [{ ...dev(d), direction }, d.pcie?.throughput?.[direction] == null ? null : num(d.pcie.throughput[direction]) * 1000])));
  }
  if (has("ecc")) {
    out.gauge("nvidia_gpu_ecc_enabled", "1 when ECC is on; absent when the card has no ECC.", devices.map((d) => [dev(d), d.ecc?.enabled == null ? null : d.ecc.enabled ? 1 : 0]));
    out.gauge("nvidia_gpu_ecc_pending_enabled", "1 when ECC will be on after the next reset.", devices.map((d) => [dev(d), d.ecc?.pending_enabled == null ? null : d.ecc.pending_enabled ? 1 : 0]));
    out.counter("nvidia_gpu_ecc_errors_total", "ECC errors by scope (volatile: since the driver loaded; aggregate: lifetime) and kind.", devices.flatMap((d) =>
      [["volatile", d.ecc?.volatile_errors], ["aggregate", d.ecc?.aggregate_errors]].flatMap(([scope, e]) => e == null ? [] : ["corrected", "uncorrected"].map((kind) => [{ ...dev(d), scope, kind }, num(e[kind])])),
    ));
  }
  if (has("processes")) {
    const hz = r.host?.ticks_per_second || 100;
    const boot = r.host?.boot_time_secs ?? 0;
    out.gauge("nvidia_gpu_compute_processes", "Processes holding a compute context on the device.", devices.map((d) => [dev(d), d.running_compute_processes?.length ?? null]));
    out.gauge("nvidia_gpu_graphics_processes", "Processes holding a graphics context on the device.", devices.map((d) => [dev(d), d.running_graphics_processes?.length ?? null]));
    const contexts = devices.flatMap((d) => [
      ...(d.running_compute_processes ?? []).map((p) => ({ d, p, kind: "compute" })),
      ...(d.running_graphics_processes ?? []).map((p) => ({ d, p, kind: "graphics" })),
    ]);
    const proc = ({ d, p, kind }) => ({ ...dev(d), pid: p.pid, comm: p.process?.stat?.comm ?? "", kind });
    out.gauge("nvidia_gpu_process_info", "One row per NVML context: the process, its executable and owner, and any MIG instance ids.", contexts.map((c) => [{ ...proc(c), exe: c.p.process?.exe ?? "", uid: c.p.process?.uid, gpu_instance: c.p.gpu_instance_id, compute_instance: c.p.compute_instance_id }, 1]));
    out.gauge("nvidia_gpu_process_memory_bytes", "Device memory the context holds; absent when the driver withholds it.", contexts.map((c) => [proc(c), num(c.p.used_gpu_memory)]));
    out.gauge("nvidia_gpu_process_rss_bytes", "Resident host memory of the process.", contexts.map((c) => [proc(c), num(c.p.process?.stat?.rss_bytes)]));
    out.gauge("nvidia_gpu_process_threads", "Threads in the process.", contexts.map((c) => [proc(c), c.p.process?.stat?.num_threads]));
    out.counter("nvidia_gpu_process_cpu_seconds_total", "CPU time the process has used, user plus system.", contexts.map((c) => { const s = c.p.process?.stat; return [proc(c), s ? (s.utime + s.stime) / hz : null]; }));
    out.gauge("nvidia_gpu_process_start_time_seconds", "Unix time the process started.", contexts.map((c) => { const s = c.p.process?.stat; return [proc(c), s ? boot + s.starttime / hz : null]; }));
  }

  if (r.probe) {
    out.gauge("gpu_kernel_probe_up", "1 when the kprobes on the nvidia, nvidia_uvm and drm entry points are attached.", [[{}, r.probe.up ? 1 : 0]]);
    if (r.probe.error) out.comment(`probe: ${r.probe.error}`);
  }
  if (r.driver) {
    const comms = r.driver.by_process_name;
    const now = Date.now();
    const recent = r.driver.by_pid.filter((p) => now - p.last <= pidTtlMs);
    const pidLabels = (p) => ({ pid: p.pid, comm: p.comm, uid: p.uid });
    const commCounter = (name, help, field, scale = 1) => out.counter(name, help, comms.filter((c) => c[field]).map((c) => [{ comm: c.comm }, c[field] * scale]));
    commCounter("nvidia_rm_ioctls_total", "ioctl calls into the NVIDIA resource manager (/dev/nvidia*, /dev/nvidiactl) by process name.", "rm_ioctls");
    commCounter("nvidia_rm_ioctl_seconds_total", "Time spent inside those ioctls.", "rm_ioctl_seconds");
    commCounter("nvidia_rm_ioctl_errors_total", "Resource manager ioctls that returned an error.", "rm_errors");
    commCounter("nvidia_rm_opens_total", "Opens of /dev/nvidia* and /dev/nvidiactl.", "rm_opens");
    commCounter("nvidia_rm_closes_total", "Closes of those nodes.", "rm_closes");
    commCounter("nvidia_rm_mmaps_total", "Mappings of device or driver memory into the process.", "rm_mmaps");
    commCounter("nvidia_uvm_ioctls_total", "ioctl calls into unified memory (/dev/nvidia-uvm) by process name.", "uvm_ioctls");
    commCounter("nvidia_uvm_ioctl_seconds_total", "Time spent inside those ioctls.", "uvm_ioctl_seconds");
    commCounter("nvidia_uvm_ioctl_errors_total", "Unified memory ioctls that returned an error.", "uvm_errors");
    commCounter("nvidia_uvm_opens_total", "Opens of /dev/nvidia-uvm.", "uvm_opens");
    commCounter("nvidia_uvm_releases_total", "Final closes of /dev/nvidia-uvm.", "uvm_releases");
    commCounter("nvidia_uvm_mmaps_total", "Mappings of unified memory into the process.", "uvm_mmaps");
    commCounter("drm_ioctls_total", "ioctl calls into any DRM node (/dev/dri/*), every GPU driver, by process name.", "drm_ioctls");
    out.gauge("gpu_kernel_processes_seen", "Distinct pids the probes have seen per process name since the sampler started.", comms.map((c) => [{ comm: c.comm }, c.pids]));
    out.counter("nvidia_rm_ioctls_by_cmd_total", "Resource manager ioctls by escape number; cmd names the escape when known.", r.driver.rm_ioctls_by_cmd.map((c) => [{ nr: c.nr, cmd: RM_ESCAPES[c.nr] ?? "" }, c.total]));
    out.counter("nvidia_uvm_ioctls_by_cmd_total", "Unified memory ioctls by command number; cmd names it when known.", r.driver.uvm_ioctls_by_cmd.map((c) => [{ nr: c.nr, cmd: UVM_ESCAPES[c.nr] ?? "" }, c.total]));
    out.counter("nvidia_rm_ioctls_by_node_total", "Resource manager ioctls by device node, so nvidiactl traffic is told from each GPU's.", r.driver.rm_ioctls_by_node.map((x) => [{ node: x.node }, x.total]));
    out.counter("drm_ioctls_by_node_total", "DRM ioctls by node: cardN for KMS, renderDN for render.", r.driver.drm_ioctls_by_node.map((x) => [{ node: x.node }, x.total]));
    out.counter("nvidia_process_rm_ioctls_total", `Resource manager ioctls per pid, for pids the probes saw in the last ${pidTtlMs / 1000}s.`, recent.map((p) => [pidLabels(p), p.rm_ioctls]));
    out.counter("nvidia_process_rm_ioctl_seconds_total", "Time those pids spent inside resource manager ioctls.", recent.map((p) => [pidLabels(p), p.rm_ioctl_ns * 1e-9]));
    out.counter("nvidia_process_uvm_ioctls_total", "Unified memory ioctls per recent pid.", recent.map((p) => [pidLabels(p), p.uvm_ioctls]));
    out.counter("nvidia_process_uvm_ioctl_seconds_total", "Time those pids spent inside unified memory ioctls.", recent.map((p) => [pidLabels(p), p.uvm_ioctl_ns * 1e-9]));
    out.counter("drm_process_ioctls_total", "DRM ioctls per recent pid.", recent.map((p) => [pidLabels(p), p.drm_ioctls]));
    out.gauge("gpu_process_first_seen_seconds", "Unix time the probes first saw the pid touch a GPU.", recent.map((p) => [pidLabels(p), p.first / 1000]));
    out.gauge("gpu_process_last_seen_seconds", "Unix time the probes last saw the pid touch a GPU.", recent.map((p) => [pidLabels(p), p.last / 1000]));
  }
  if (r.holders) {
    const counts = new Map();
    for (const h of r.holders.processes) for (const node of h.nodes) counts.set(node, (counts.get(node) ?? 0) + 1);
    out.gauge("gpu_device_node_holders", "Processes with the device node open, from the fd tables; a context need not exist for NVML to miss it.", [...counts].map(([node, count]) => [{ node }, count]));
    out.gauge("gpu_device_node_holder_info", "One row per process holding GPU device nodes; nodes lists them.", r.holders.processes.map((h) => [{ pid: h.pid, comm: h.comm, uid: h.uid, nodes: h.nodes.join(",") }, 1]));
    out.gauge("gpu_device_node_scan_age_seconds", "Seconds since the fd tables were last scanned.", r.holders.scanned_at ? [[{}, (Date.now() - Date.parse(r.holders.scanned_at)) / 1000]] : []);
  }
  if (r.sampler) {
    out.gauge("gpu_exporter_sampler_uptime_seconds", "Seconds the sampler worker has been running.", [[{}, (Date.now() - Date.parse(r.sampler.started_at)) / 1000]]);
    out.counter("gpu_exporter_sampler_ticks_total", "Kernel counter drains the sampler has done.", [[{}, r.sampler.ticks]]);
    out.counter("gpu_exporter_sampler_errors_total", "Errors the sampler hit.", [[{}, r.sampler.errors]]);
    if (r.sampler.last_error) out.comment(`sampler last error: ${r.sampler.last_error}`);
  }
  return out.toString();
}
