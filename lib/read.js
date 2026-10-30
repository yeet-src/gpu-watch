/* One read of everything a selection asks for: the graph for the
 * device sections, the sampler for the kernel ones. The result is the
 * shape every format renders from, so a format never touches the graph.
 */

import { graphSections, query, samplerSections } from "./sections.js";

const SAMPLER_TIMEOUT_MS = 3000;

export async function read(sections, { gpu, uuids } = {}) {
  const wantGraph = graphSections(sections).length > 0 || gpu != null;
  const wantSampler = samplerSections(sections).length > 0;
  const [graph, sampler] = await Promise.all([
    wantGraph ? readGraph(sections, uuids) : null,
    wantSampler ? readSampler().catch((error) => ({ error: error?.message ?? String(error) })) : null,
  ]);

  const out = { sampled_at: new Date().toISOString(), sections };
  if (graph) {
    out.available = graph.nvidia != null;
    if (!out.available) out.reason = "NVML is not loaded on this host";
    out.count = graph.nvidia?.count ?? 0;
    out.host = graph.host ?? null;
    out.devices = (graph.nvidia?.devices ?? []).filter((d) => gpu == null || d.index === gpu);
    for (const warning of graph.warnings) (out.warnings ??= []).push(warning);
  }
  if (sampler) {
    if (sampler.error) {
      (out.warnings ??= []).push(`sampler: ${sampler.error}`);
    } else {
      out.probe = sampler.probe;
      out.sampler = { started_at: new Date(sampler.startedAt).toISOString(), ticks: sampler.ticks, errors: sampler.errors, last_error: sampler.lastError };
      if (sections.includes("driver")) out.driver = driver(sampler);
      if (sections.includes("holders")) out.holders = { scanned_at: sampler.holdersAt ? new Date(sampler.holdersAt).toISOString() : null, processes: sampler.holders ?? [] };
    }
  }
  return out;
}

async function readGraph(sections, uuids) {
  const { data, errors } = await yeet.graph.query(query(sections, uuids));
  // A process that exited between NVML's list and the proc read is a
  // path error under `process`, not a reason to fail the read.
  const fatal = errors?.find((e) => !e.path?.includes("process"));
  if (fatal) throw new Error(fatal.message);
  return { ...(data ?? {}), warnings: (errors ?? []).map((e) => `graph: ${e.message}`) };
}

function readSampler() {
  const sampler = new SharedWorker("./sampler.js", { name: "gpu" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sampler.port.close(); reject(new Error(`The sampler did not answer in ${SAMPLER_TIMEOUT_MS}ms`)); }, SAMPLER_TIMEOUT_MS);
    sampler.port.onmessage = ({ data }) => {
      if (data?.type !== "snapshot") return;
      clearTimeout(timer);
      sampler.port.close();
      resolve(data);
    };
    sampler.onerror = (e) => { clearTimeout(timer); sampler.port.close(); reject(new Error(e.message)); };
    sampler.port.postMessage({ type: "snapshot" });
  });
}

// Per-pid totals rolled up by process name, the stable view, with the
// per-pid rows kept beside them for whoever needs the detail.
function driver(snap) {
  const byComm = new Map();
  for (const p of snap.procs ?? []) {
    const row = byComm.get(p.comm) ?? { comm: p.comm, pids: 0, rm_ioctls: 0, rm_ioctl_seconds: 0, rm_errors: 0, rm_opens: 0, rm_closes: 0, rm_mmaps: 0, uvm_ioctls: 0, uvm_ioctl_seconds: 0, uvm_errors: 0, uvm_opens: 0, uvm_releases: 0, uvm_mmaps: 0, drm_ioctls: 0 };
    row.pids += 1;
    row.rm_ioctls += p.rm_ioctls; row.rm_ioctl_seconds += p.rm_ioctl_ns / 1e9; row.rm_errors += p.rm_errors;
    row.rm_opens += p.rm_opens; row.rm_closes += p.rm_closes; row.rm_mmaps += p.rm_mmaps;
    row.uvm_ioctls += p.uvm_ioctls; row.uvm_ioctl_seconds += p.uvm_ioctl_ns / 1e9; row.uvm_errors += p.uvm_errors;
    row.uvm_opens += p.uvm_opens; row.uvm_releases += p.uvm_releases; row.uvm_mmaps += p.uvm_mmaps;
    row.drm_ioctls += p.drm_ioctls;
    byComm.set(p.comm, row);
  }
  const busiest = (a, b) => b.rm_ioctls + b.uvm_ioctls + b.drm_ioctls - (a.rm_ioctls + a.uvm_ioctls + a.drm_ioctls);
  return {
    by_process_name: [...byComm.values()].sort(busiest),
    by_pid: (snap.procs ?? []).map((p) => ({ ...p, first_seen: new Date(p.first).toISOString(), last_seen: new Date(p.last).toISOString() })).sort(busiest),
    rm_ioctls_by_cmd: snap.rmCmds ?? [],
    uvm_ioctls_by_cmd: snap.uvmCmds ?? [],
    rm_ioctls_by_node: snap.rmNodes ?? [],
    drm_ioctls_by_node: snap.drmNodes ?? [],
  };
}
