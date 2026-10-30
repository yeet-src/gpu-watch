/* gpu-metrics sampler: a shared worker, one per service, that keeps
 * the state no single scrape could see. It loads the kernel probes
 * and drains their counters every tick into running totals; it keeps
 * a graph subscription open so NVML's per-process SM/encoder/decoder
 * time accumulates; and it rescans the fd tables for processes that
 * hold a GPU device node. A scrape connects, asks for a snapshot,
 * and gets all of it in one message.
 */

import probe from "./lib/bpf/bin/gpu.bpf.o";
import { LruHashMap } from "yeet:bpf";
import { subscribe } from "yeet:graph";
import { nodeName } from "./names.js";

const startedAt = Date.now();
const config = { interval: 1000, fdScan: 10_000 };
const state = {
  probe: { up: false, error: null },
  ticks: 0,
  errors: 0,
  lastError: null,
  procs: new Map(),
  rmCmds: new Map(),
  uvmCmds: new Map(),
  rmNodes: new Map(),
  drmNodes: new Map(),
  utilization: new Map(),
  utilizationSamples: 0,
  holders: [],
  holdersAt: null,
};
const clients = new Set();

const n = (v) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const text = (v) => (v instanceof Uint8Array ? new TextDecoder().decode(v).replace(/\0.*$/s, "") : String(v ?? ""));

function say(line) {
  for (const port of clients) port.postMessage({ type: "log", line });
}

function fail(where, error) {
  state.errors += 1;
  state.lastError = `${where}: ${error?.message ?? error}`;
  for (const port of clients) port.postMessage({ type: "error", line: state.lastError });
}

/* Kernel counters. Every map is drained, so each entry is the delta
 * since the last tick; the totals live here and survive the LRU.
 */
let maps = null;

async function startProbe() {
  try {
    const control = await probe
      .bind("by_pid", { kind: "lru_hash" })
      .bind("rm_cmds", { kind: "lru_hash" })
      .bind("uvm_cmds", { kind: "lru_hash" })
      .bind("rm_nodes", { kind: "lru_hash" })
      .bind("drm_nodes", { kind: "lru_hash" })
      .start();
    maps = Object.fromEntries(
      ["by_pid", "rm_cmds", "uvm_cmds", "rm_nodes", "drm_nodes"].map((name) => [name, new LruHashMap(control, name)]),
    );
    state.probe = { up: true, error: null };
  } catch (error) {
    state.probe = { up: false, error: error?.message ?? String(error) };
    fail("probe", error);
  }
}

async function drain(map) {
  const out = [];
  for (;;) {
    const batch = await map.drainBatch(256);
    const entries = Array.isArray(batch) ? batch : batch?.entries ?? [];
    out.push(...entries);
    if (entries.length < 256) return out;
  }
}

const PID_FIELDS = [
  "rm_ioctls", "rm_ioctl_ns", "rm_errors", "uvm_ioctls", "uvm_ioctl_ns", "uvm_errors", "drm_ioctls",
  "rm_opens", "rm_closes", "rm_mmaps", "uvm_opens", "uvm_releases", "uvm_mmaps",
];

function addTo(map, key, delta, label) {
  const row = map.get(key) ?? { ...label, total: 0 };
  row.total += delta;
  map.set(key, row);
}

async function tick() {
  if (!maps) return;
  try {
    for (const [key, value] of await drain(maps.by_pid)) {
      const pid = n(key);
      const row = state.procs.get(pid) ?? {
        pid, comm: text(value.comm), uid: n(value.uid), first: Date.now(), ...Object.fromEntries(PID_FIELDS.map((f) => [f, 0])),
      };
      row.comm = text(value.comm) || row.comm;
      for (const f of PID_FIELDS) row[f] += n(value[f]);
      row.last = Date.now();
      state.procs.set(pid, row);
    }
    for (const [key, value] of await drain(maps.rm_cmds)) addTo(state.rmCmds, n(key), n(value), { nr: n(key) });
    for (const [key, value] of await drain(maps.uvm_cmds)) addTo(state.uvmCmds, n(key), n(value), { nr: n(key) });
    for (const [key, value] of await drain(maps.rm_nodes)) {
      const node = nodeName(n(key.major), n(key.minor));
      addTo(state.rmNodes, node, n(value), { node });
    }
    for (const [key, value] of await drain(maps.drm_nodes)) {
      const node = nodeName(n(key.major), n(key.minor));
      addTo(state.drmNodes, node, n(value), { node });
    }
    state.ticks += 1;
  } catch (error) {
    fail("tick", error);
  }
}

/* NVML process utilization only accumulates across a subscription:
 * the graph keeps the last NVML timestamp per subscription and adds
 * each sample's share of the interval since. The schema does not say
 * which pid each entry belongs to, so the sum per device is kept.
 */
async function watchUtilization() {
  const query = `subscription { nvidia(interval_ms: 2000) { devices { index process_utilization { sm enc dec } } } }`;
  try {
    await subscribe(query, ({ data }) => {
      for (const device of data?.nvidia?.devices ?? []) {
        const sum = { sm: 0, enc: 0, dec: 0, processes: device.process_utilization.length };
        for (const t of device.process_utilization) { sum.sm += n(t.sm); sum.enc += n(t.enc); sum.dec += n(t.dec); }
        state.utilization.set(device.index, sum);
      }
      state.utilizationSamples += 1;
    }, (error) => fail("utilization", error));
  } catch (error) {
    fail("utilization", error);
  }
}

// Which processes hold a GPU device node open, NVML context or not.
async function scanHolders() {
  const query = `{ procs { pid stat { comm } status { euid } fds { kind path } } }`;
  try {
    const { data, errors } = await yeet.graph.query(query);
    const fatal = errors?.find((e) => e.path?.[0] !== "procs" || e.path?.length < 2);
    if (fatal) throw new Error(fatal.message);
    const holders = [];
    for (const proc of data?.procs ?? []) {
      if (!proc?.fds) continue;
      const nodes = new Set();
      for (const fd of proc.fds) {
        if (fd.kind !== "PATH" || !fd.path) continue;
        if (fd.path.startsWith("/dev/nvidia") || fd.path.startsWith("/dev/dri/")) nodes.add(fd.path.slice(5));
      }
      if (nodes.size) holders.push({ pid: proc.pid, comm: proc.stat?.comm ?? "", uid: proc.status?.euid ?? null, nodes: [...nodes].sort() });
    }
    state.holders = holders;
    state.holdersAt = Date.now();
  } catch (error) {
    fail("fd scan", error);
  }
}

function snapshot() {
  return {
    type: "snapshot",
    startedAt,
    config: { ...config },
    probe: { ...state.probe },
    ticks: state.ticks,
    errors: state.errors,
    lastError: state.lastError,
    procs: [...state.procs.values()],
    rmCmds: [...state.rmCmds.values()],
    uvmCmds: [...state.uvmCmds.values()],
    rmNodes: [...state.rmNodes.values()],
    drmNodes: [...state.drmNodes.values()],
    utilization: [...state.utilization].map(([index, sum]) => ({ index, ...sum })),
    utilizationSamples: state.utilizationSamples,
    holders: state.holders,
    holdersAt: state.holdersAt,
  };
}

let tickTimer = null;
let scanTimer = null;

function schedule() {
  clearInterval(tickTimer);
  clearInterval(scanTimer);
  tickTimer = setInterval(tick, config.interval);
  scanTimer = setInterval(scanHolders, config.fdScan);
}

onconnect = ({ ports: [port] }) => {
  clients.add(port);
  port.addEventListener("close", () => clients.delete(port));
  port.onmessage = ({ data }) => {
    switch (data?.type) {
      case "snapshot":
        port.postMessage(snapshot());
        break;
      case "configure":
        config.interval = Math.max(100, Number(data.interval) || config.interval);
        config.fdScan = Math.max(config.interval, Number(data.fdScan) || config.fdScan);
        schedule();
        say(`sampler: interval ${config.interval}ms, fd scan ${config.fdScan}ms`);
        break;
    }
  };
};

await startProbe();
watchUtilization();
scanHolders();
schedule();
