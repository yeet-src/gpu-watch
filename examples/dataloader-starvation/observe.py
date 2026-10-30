"""What gpu-watch and the system graph see while a training run goes.

    python observe.py <pid> [--seconds 60] [--host 127.0.0.1:9480] [--disk nvme0n1]

Every two seconds, one line: GPU busy, SM clock, P-state and power
from gpu-watch; the trainer's ioctl rate into the driver from the
kprobes; and from the graph, the trainer's CPU use and the data disk's
busy share, so the GPU side and the host side sit on one line.
"""

import argparse
import json
import os
import subprocess
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument("pid", type=int)
p.add_argument("--seconds", type=int, default=60)
p.add_argument("--host", default="127.0.0.1:9480")
p.add_argument("--disk", default="nvme0n1")
p.add_argument("--yeet", default=os.environ.get("YEET", "yeet"))
args = p.parse_args()
hz = os.sysconf("SC_CLK_TCK")


def gpu():
    with urllib.request.urlopen(f"http://{args.host}/gpu?fields=utilization,clocks,thermal,power,driver&gpu=0", timeout=5) as r:
        d = json.loads(r.read())
    x = d["devices"][0]
    rows = [q for q in d.get("driver", {}).get("by_pid", []) if q["pid"] == args.pid]
    ioctl = rows[0]["rm_ioctls"] + rows[0]["uvm_ioctls"] if rows else 0
    return x["utilization_rates"]["gpu"], x["clocks"]["sm"]["current"], x["performance_state"], round(x["power_usage"] / 1000), ioctl


def graph():
    q = f'{{ proc(pid: {args.pid}) {{ stat {{ utime stime }} }} diskstats(names: ["{args.disk}"]) {{ time_in_progress }} }}'
    out = subprocess.run([args.yeet, "graph", "query", q], capture_output=True, text=True).stdout
    d = json.loads(out)["data"]
    s = d["proc"]["stat"] if d.get("proc") else None
    return (s["utime"] + s["stime"]) if s else 0, d["diskstats"][0]["time_in_progress"] if d["diskstats"] else 0


print(f"{'time':8} {'gpu_busy':>8} {'sm_mhz':>7} {'pstate':>6} {'watts':>5} {'ioctl/s':>8} {'cpu%':>5} {'disk_busy%':>10}", flush=True)
prev = None
end = time.time() + args.seconds
while time.time() < end:
    try:
        busy, sm, pstate, watts, ioctl = gpu()
        cpu, disk = graph()
    except Exception as e:  # noqa: BLE001
        print(f"sample failed: {e}", flush=True)
        time.sleep(2)
        continue
    now = time.time()
    if prev:
        dt = now - prev["t"]
        print(f"{time.strftime('%H:%M:%S'):8} {busy:>7}% {sm:>7} {pstate:>6} {watts:>5} "
              f"{round((ioctl - prev['ioctl']) / dt):>8} {round(100 * (cpu - prev['cpu']) / hz / dt):>4}% "
              f"{round(100 * (disk - prev['disk']) / 1000 / dt):>9}%", flush=True)
    prev = {"t": now, "ioctl": ioctl, "cpu": cpu, "disk": disk}
    time.sleep(2)
