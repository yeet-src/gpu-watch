/* The agent face: a Model Context Protocol server on a named portal.
 * Newline-delimited JSON-RPC, the framing of MCP's stdio transport, so
 * `yeet dial ws://host:9480/mcp` is the whole client. The tools select
 * with the same section words as `/gpu?fields=`.
 */

import { ALL, SECTIONS, select } from "./lib/sections.js";
import { read } from "./lib/read.js";
import { markdown } from "./lib/formats.js";

const SERVER = { name: "yeet-gpu", version: "0.2.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const WATCH_MAX_SECONDS = 60;
const EOF = "\x04";

const n = (v) => (typeof v === "bigint" ? Number(v) : v == null ? null : Number(v));

async function snapshot({ fields, gpu } = {}) {
  return read(select(fields), { gpu: gpu ?? null });
}

/* A bounded window instead of a subscription: the range each signal
 * moved through and every state seen, so a throttle that lasted one
 * sample is not lost and the agent decides whether to look closer.
 */
async function watch({ seconds = 10, interval_ms = 1000, gpu } = {}) {
  seconds = Math.min(WATCH_MAX_SECONDS, Math.max(1, Number(seconds) || 10));
  interval_ms = Math.max(200, Number(interval_ms) || 1000);
  const sections = select("device,power,thermal,utilization,memory,clocks,pcie");
  const devices = new Map();
  const range = (r, key, v) => {
    if (v == null) return;
    const slot = r[key] ?? (r[key] = { min: v, max: v, last: v });
    slot.min = Math.min(slot.min, v); slot.max = Math.max(slot.max, v); slot.last = v;
  };
  const started = Date.now();
  let samples = 0;
  while (Date.now() - started < seconds * 1000) {
    const { devices: list = [] } = await read(sections, { gpu: gpu ?? null });
    for (const d of list) {
      const r = devices.get(d.index) ?? { gpu: d.index, name: d.name, performance_states: new Set(), throttle_reasons: new Set(), pcie_generations: new Set() };
      range(r, "gpu_utilization_percent", n(d.utilization_rates?.gpu));
      range(r, "memory_utilization_percent", n(d.utilization_rates?.memory));
      range(r, "sm_clock_mhz", n(d.clocks?.sm?.current));
      range(r, "memory_clock_mhz", n(d.clocks?.memory?.current));
      range(r, "power_watts", n(d.power_usage) / 1000);
      range(r, "temperature_celsius", n(d.temperature));
      range(r, "memory_used_bytes", n(d.memory?.used));
      range(r, "pcie_tx_kbps", n(d.pcie?.throughput?.tx));
      range(r, "pcie_rx_kbps", n(d.pcie?.throughput?.rx));
      if (d.performance_state) r.performance_states.add(d.performance_state);
      for (const reason of d.throttle_reasons ?? []) r.throttle_reasons.add(reason);
      if (d.pcie?.generation != null) r.pcie_generations.add(d.pcie.generation);
      devices.set(d.index, r);
    }
    samples += 1;
    await new Promise((resolve) => setTimeout(resolve, interval_ms));
  }
  return { seconds, interval_ms, samples, devices: [...devices.values()].map((r) => ({ ...r, performance_states: [...r.performance_states], throttle_reasons: [...r.throttle_reasons], pcie_generations: [...r.pcie_generations] })) };
}

async function graphQuery({ query }) {
  if (typeof query !== "string" || !query.trim()) throw new Error("query must be a non-empty GraphQL document");
  if (/^\s*(mutation|subscription)\b/i.test(query)) throw new Error("Only queries are served here; mutations and subscriptions are refused");
  return yeet.graph.query(query);
}

async function graphType({ name }) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? "")) throw new Error("name must be a GraphQL type name");
  const { data, errors } = await yeet.graph.query(`{ __type(name: "${name}") {
    name kind description
    fields { name description type { ...ref } args { name type { ...ref } } }
    enumValues { name description }
  } }
  fragment ref on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`);
  if (errors?.length) throw new Error(errors[0].message);
  if (!data.__type) throw new Error(`No type named ${name}`);
  const show = (t) => (t.kind === "NON_NULL" ? `${show(t.ofType)}!` : t.kind === "LIST" ? `[${show(t.ofType)}]` : t.name);
  return { ...data.__type, fields: data.__type.fields?.map((f) => ({ name: f.name, type: show(f.type), description: f.description, args: f.args?.map((a) => `${a.name}: ${show(a.type)}`) })) };
}

const FIELDS_ARG = { type: "string", description: `Comma list of sections, default all: ${ALL.join(", ")}` };
const GPU_ARG = { type: "integer", description: "Only this device index" };
const TOOLS = [
  { name: "gpu_snapshot", description: `Everything about the GPUs on this host in one live read, or only the sections asked for. Sections: ${ALL.map((s) => `${s} (${SECTIONS[s].about})`).join("; ")}`, inputSchema: { type: "object", properties: { fields: FIELDS_ARG, gpu: GPU_ARG }, additionalProperties: false }, run: snapshot },
  { name: "gpu_watch", description: `Sample the devices for a few seconds and return the range each signal moved through plus every performance state, throttle reason and PCIe generation seen. Tells idle from loaded and catches a throttle. At most ${WATCH_MAX_SECONDS} seconds.`, inputSchema: { type: "object", properties: { seconds: { type: "number", description: "How long to watch, 1 to 60 (default 10)" }, interval_ms: { type: "number", description: "Milliseconds between samples (default 1000)" }, gpu: GPU_ARG }, additionalProperties: false }, run: watch },
  { name: "graph_query", description: "Run a read-only GraphQL query against the yeet system graph: processes, mounts, block devices, cgroups, network, hwmon, containers and the nvidia context. Use graph_type to discover fields. Mutations and subscriptions are refused.", inputSchema: { type: "object", properties: { query: { type: "string", description: "A GraphQL query document" } }, required: ["query"], additionalProperties: false }, run: graphQuery },
  { name: "graph_type", description: "Describe a type in the system graph schema: its fields, their types and arguments. Start from Query, NvidiaDevice, Process, MountInfo or BlockDevice.", inputSchema: { type: "object", properties: { name: { type: "string", description: "A GraphQL type name" } }, required: ["name"], additionalProperties: false }, run: graphType },
];
const RESOURCES = [
  { uri: "gpu://overview", name: "GPU overview", description: "A Markdown summary of every GPU on this host, refreshed on each read.", mimeType: "text/markdown", read: async () => markdown(await read(select(null))) },
];

const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (msg.jsonrpc !== "2.0" || typeof method !== "string") return id === undefined ? null : error(id, -32600, "Invalid request");
  const notification = id === undefined;
  try {
    switch (method) {
      case "initialize":
        return result(id, {
          protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[1],
          capabilities: { tools: {}, resources: {} },
          serverInfo: SERVER,
          instructions: "GPU telemetry for this host, read live from yeet's system graph. Call gpu_snapshot first, with fields to narrow it; gpu_watch to see movement under load; fields=driver,holders for who is talking to the driver; graph_query for anything else on the host.",
        });
      case "ping": return result(id, {});
      case "tools/list": return result(id, { tools: TOOLS.map(({ run, ...t }) => t) });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return error(id, -32602, `Unknown tool ${params.name}`);
        try {
          const value = await tool.run(params.arguments ?? {});
          return result(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false });
        } catch (e) {
          return result(id, { content: [{ type: "text", text: e?.message ?? String(e) }], isError: true });
        }
      }
      case "resources/list": return result(id, { resources: RESOURCES.map(({ read, ...r }) => r) });
      case "resources/read": {
        const res = RESOURCES.find((r) => r.uri === params.uri);
        if (!res) return error(id, -32002, `Unknown resource ${params.uri}`);
        return result(id, { contents: [{ uri: res.uri, mimeType: res.mimeType, text: await res.read() }] });
      }
      default:
        return notification ? null : error(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return notification ? null : error(id, -32603, e?.message ?? String(e));
  }
}

/* dial sends stdin as binary and, at its EOF, a lone ^D, then waits for
 * this side to hang up; a text frame arrives as a string. The stream is
 * cut at newlines, each line one message answered in order, and the ^D
 * closes the peer once every answer before it has gone out.
 */
function serve(peer) {
  const decoder = new TextDecoder();
  let pending = "";
  let chain = Promise.resolve();
  const answer = (line) => async () => {
    let msg;
    try { msg = JSON.parse(line); } catch { return peer.write(JSON.stringify(error(null, -32700, "Parse error")) + "\n"); }
    const reply = await handle(msg);
    if (reply && !peer.closed) peer.write(JSON.stringify(reply) + "\n");
  };
  peer.on("data", (data) => {
    pending += typeof data === "string" ? data : decoder.decode(data, { stream: true });
    const ended = pending.includes(EOF);
    const lines = pending.split("\n");
    pending = ended ? "" : lines.pop();
    for (const raw of lines) {
      const line = raw.replaceAll(EOF, "").replace(/\r/g, "").trim();
      if (line) chain = chain.then(answer(line));
    }
    if (ended) chain = chain.then(() => peer.close());
  });
}

const portal = new Portal("mcp");
portal.on("peer", (peer, request) => {
  console.log(`mcp: peer ${peer.remote ?? "local"} on ${request?.url ?? "?"}`);
  serve(peer);
  peer.on("close", () => console.log(`mcp: peer ${peer.remote ?? "local"} left`));
});
console.log("mcp: serving on portal mcp");
