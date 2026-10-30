// Prometheus text exposition (version 0.0.4). A family is HELP, TYPE
// and its samples; a sample with a null or non-finite value is left
// out so a missing reading never prints as NaN.

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const labels = (set) => {
  const entries = Object.entries(set).filter(([, v]) => v !== undefined && v !== null);
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}` : "";
};

export class Exposition {
  #lines = [];

  family(name, type, help, samples) {
    this.#lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [set, value] of samples) {
      const n = typeof value === "bigint" ? Number(value) : value;
      if (n == null || !Number.isFinite(n)) continue;
      this.#lines.push(`${name}${labels(set)} ${Number.isInteger(n) ? n : +n.toFixed(9)}`);
    }
    this.#lines.push("");
  }

  // A note for a human reading the scrape; parsers skip it.
  comment(line) {
    this.#lines.push(`# ${String(line).replace(/\n/g, " ")}`);
  }

  gauge(name, help, samples) { this.family(name, "gauge", help, samples); }
  counter(name, help, samples) { this.family(name, "counter", help, samples); }

  toString() { return this.#lines.join("\n"); }
}

export const num = (v) => (typeof v === "bigint" ? Number(v) : v == null ? null : Number(v));
