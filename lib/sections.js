/* The one catalog every interface selects from. A section is a name,
 * a sentence, and the GraphQL it needs on a device; the sampler-backed
 * sections have no GraphQL and are filled from its snapshot instead.
 * `?fields=`, the MCP tool argument and the Prometheus families all
 * cut along these lines, so a word means the same thing everywhere.
 */

export const SECTIONS = {
  device: {
    about: "Identity: index, UUID, product name, board id.",
    gql: "index uuid name board_id",
  },
  power: {
    about: "Draw, energy since the driver loaded, and the limits the draw is held under.",
    gql: "power_usage total_energy_consumption power_limits { current enforced default min max }",
  },
  thermal: {
    about: "Temperature, fans, performance state and why the clocks are being held down.",
    gql: "temperature fan_speeds performance_state throttle_reasons",
  },
  utilization: {
    about: "Share of the sample window a kernel ran and the memory controller was busy.",
    gql: "utilization_rates { gpu memory }",
  },
  memory: {
    about: "Framebuffer memory: total, used, free, reserved by the driver.",
    gql: "memory { total used free reserved }",
  },
  clocks: {
    about: "Each clock domain against its ceiling: graphics, SM, memory, video.",
    gql: "clocks { graphics { ...clock } sm { ...clock } memory { ...clock } video { ...clock } }",
  },
  pcie: {
    about: "The link as negotiated against what the slot supports, replays, and throughput.",
    gql: "pcie { generation width max_generation max_width replay_counter throughput { tx rx } }",
  },
  ecc: {
    about: "ECC mode and error counts; null on cards without ECC.",
    gql: "ecc { enabled pending_enabled volatile_errors { ...ecc } aggregate_errors { ...ecc } }",
  },
  processes: {
    about: "Processes holding a compute or graphics context, joined with /proc.",
    gql: "running_compute_processes { ...proc } running_graphics_processes { ...proc }",
  },
  driver: {
    about: "Kernel side, from the probes: ioctls into the NVIDIA, UVM and DRM entry points by process.",
    sampler: true,
  },
  holders: {
    about: "Every process with a GPU device node open, NVML context or not, from the fd tables.",
    sampler: true,
  },
};

// GraphQL refuses a document with a fragment nothing spreads, so each
// rides along only when a selected section names it.
const FRAGMENTS = {
  clock: "fragment clock on NvidiaDeviceClock { current max application }",
  ecc: "fragment ecc on NvidiaDeviceEccErrors { corrected uncorrected }",
  proc: `fragment proc on NvidiaProcessInfo {
  pid used_gpu_memory gpu_instance_id compute_instance_id
  process { uid exe cmdline stat { comm state utime stime rss_bytes starttime num_threads } }
}`,
};

export const ALL = Object.keys(SECTIONS);

/* A selection from words: a comma list, an array, or nothing for all.
 * Unknown words are an error rather than silently nothing, since an
 * agent that misspells a section should hear about it.
 */
export function select(words) {
  if (words == null || words === "" || words === "all") return [...ALL];
  const list = Array.isArray(words) ? words : String(words).split(",");
  const picked = list.map((w) => w.trim()).filter(Boolean);
  const unknown = picked.filter((w) => !SECTIONS[w]);
  if (unknown.length) throw new Error(`Unknown section(s): ${unknown.join(", ")}. Known: ${ALL.join(", ")}`);
  return ALL.filter((s) => picked.includes(s));
}

export const graphSections = (sections) => sections.filter((s) => SECTIONS[s].gql);
export const samplerSections = (sections) => sections.filter((s) => SECTIONS[s].sampler);

/* The query for a selection. `index` is always asked so a device can
 * be named and filtered whatever was selected; `host` rides along when
 * processes need it to turn ticks into seconds.
 */
export function query(sections, uuids) {
  const fields = ["index", ...graphSections(sections).map((s) => SECTIONS[s].gql)].join("\n      ");
  const args = uuids?.length ? `(uuids: ${JSON.stringify(uuids)})` : "";
  const host = sections.includes("processes") ? "host { ticks_per_second boot_time_secs }" : "";
  const fragments = Object.entries(FRAGMENTS)
    .filter(([name]) => fields.includes(`...${name}`))
    .map(([, text]) => text)
    .join("\n");
  return `{ ${host} nvidia { count devices${args} { ${fields} } } }\n${fragments}`;
}
