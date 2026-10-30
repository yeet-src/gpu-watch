/* The HTTP face of the service: one named portal, every plain-GET
 * route pointed at it. A peer that arrives with a request is a GET
 * whose body is whatever this writes until the peer is closed, so a
 * route is a path, a query string is the selection, and the formats
 * are one read rendered several ways.
 *
 *   /gpu?fields=clocks,thermal&gpu=0&format=md     one read
 *   /gpu?watch=1s                                  NDJSON until the client leaves
 *   /metrics?fields=power,driver                   Prometheus
 *   /llms.txt                                      Markdown for agents
 *   /sections                                      what `fields` accepts
 */

import { ALL, SECTIONS, select } from "./lib/sections.js";
import { read } from "./lib/read.js";
import { json, markdown, table } from "./lib/formats.js";
import { exposition } from "./lib/families.js";

const WATCH_MIN_MS = 200;
const WATCH_MAX_MS = 60_000;
const FORMATS = { json, md: markdown, markdown, table, txt: table };

function parse(url) {
  const [path, qs = ""] = String(url ?? "/").split("?", 2);
  const params = new Map();
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=", 2);
    params.set(decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, " ")));
  }
  return { path: path.replace(/\/+$/, "") || "/", params };
}

function options(params) {
  const sections = select(params.get("fields") ?? params.get("sections"));
  const gpu = params.has("gpu") ? Number(params.get("gpu")) : null;
  if (gpu != null && !Number.isInteger(gpu)) throw new Error("gpu must be a device index");
  const uuids = params.has("uuid") ? params.get("uuid").split(",") : undefined;
  return { sections, gpu, uuids };
}

function interval(spec) {
  if (spec == null || spec === "") return null;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(spec);
  if (!m) throw new Error("watch must be a duration like 500ms, 2s or 1m");
  const ms = Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000 }[m[2] ?? "s"]);
  return Math.min(WATCH_MAX_MS, Math.max(WATCH_MIN_MS, ms));
}

async function respond(peer, url) {
  const { path, params } = parse(url);
  switch (path) {
    case "/":
    case "/gpu": {
      const { sections, gpu, uuids } = options(params);
      const render = FORMATS[params.get("format") ?? "json"];
      if (!render) throw new Error(`format must be one of ${Object.keys(FORMATS).join(", ")}`);
      const every = interval(params.get("watch"));
      if (every == null) return peer.write(render(await read(sections, { gpu, uuids })));
      // NDJSON for as long as the client stays; a closed peer ends it.
      while (!peer.closed) {
        peer.write(JSON.stringify(await read(sections, { gpu, uuids })) + "\n");
        await new Promise((resolve) => setTimeout(resolve, every));
      }
      return;
    }
    case "/metrics": {
      const { sections, gpu, uuids } = options(params);
      return peer.write(exposition(await read(sections, { gpu, uuids })));
    }
    case "/llms.txt": {
      const { sections, gpu, uuids } = options(params);
      return peer.write(markdown(await read(sections, { gpu, uuids })));
    }
    case "/sections":
      return peer.write(json({ sections: Object.fromEntries(ALL.map((s) => [s, SECTIONS[s].about])), formats: Object.keys(FORMATS), params: { fields: "comma list of sections, default all", gpu: "device index", uuid: "comma list of device UUIDs", format: "json | md | table", watch: "interval for NDJSON, 200ms to 60s" } }));
    default:
      return peer.write(`no such route: ${path}\nroutes: /gpu /metrics /llms.txt /sections (and /mcp, /top on their own portals)\n`);
  }
}

/* A shared worker lives as long as one port to it does, and a read's
 * port lasts milliseconds, so this isolate holds one open for the
 * life of the service and the kernel totals accumulate across reads.
 * The sampler's log lines land on this console.
 */
const args = yeet.args ?? {};
const sampler = new SharedWorker("./sampler.js", { name: "gpu" });
sampler.port.onmessage = ({ data }) => {
  if (data?.type === "log" || data?.type === "error") console.log(data.line);
};
sampler.port.postMessage({ type: "configure", interval: Number(args.interval) || 1000, fdScan: Number(args["fd-scan"]) || 10_000 });

const portal = new Portal("http");
portal.on("peer", async (peer, request) => {
  try {
    await respond(peer, request?.url);
  } catch (error) {
    if (!peer.closed) peer.write(`error: ${error?.message ?? error}\n`);
  } finally {
    if (!peer.closed) peer.close();
  }
});
console.log("gpu: serving / /gpu /metrics /llms.txt /sections on portal http");
