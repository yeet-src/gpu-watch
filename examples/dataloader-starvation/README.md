# The GPU is at 40 percent and nobody knows why

A ResNet-50 training run on one RTX 5070. It does 450 images a second.
`nvidia-smi` says the card is busy about half the time, the clocks are
at the ceiling, nothing is throttling. Every GPU tool stops there.

This example reproduces the problem, shows what gpu-watch and the
system graph see while it happens, and fixes it. Everything below was
captured on that card; the numbers are real.

## Run it

On the GPU host, with gpu-watch up (`make up` in the repo root):

```sh
cd examples/dataloader-starvation
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --index-url https://download.pytorch.org/whl/cu128 torch torchvision
uv pip install --python .venv/bin/python pillow numpy
.venv/bin/python make_dataset.py data 8000        # 8000 JPEGs, 360 MB, once
```

Two terminals. In the first, the slow run:

```sh
.venv/bin/python train.py --data data --workers 0 --steps 150
```

In the second, once it prints its pid, watch it:

```sh
python3 observe.py <pid> --seconds 40 --disk nvme0n1
```

Then the same with `--workers 12`.

## What the trainer says

`train.py` splits every step into the time it waited for the next
batch and the time it computed. With no dataloader workers the main
process decodes and augments every JPEG itself:

```
step   40    458.7 img/s  waiting for data  55.5%  computing  44.5%
step   50    454.9 img/s  waiting for data  55.9%  computing  44.1%
step   60    457.7 img/s  waiting for data  55.6%  computing  44.4%
```

With twelve workers:

```
step   40   1030.0 img/s  waiting for data   0.1%  computing  99.9%
step   50   1032.6 img/s  waiting for data   0.0%  computing 100.0%
step   60   1032.4 img/s  waiting for data   0.0%  computing 100.0%
```

That instrumentation is the luxury of owning the training loop. Most
of the time you don't: it's someone else's script, a framework's
trainer, a job on a cluster you only see from the outside. The point
of the rest is that you reach the same conclusion without it.

## What gpu-watch sees

`observe.py` asks gpu-watch for the device every two seconds and the
system graph for the trainer's CPU time and the data disk's busy
time, so the GPU side and the host side sit on one line.

Starved, `--workers 0`:

```
time     gpu_busy  sm_mhz pstate watts  ioctl/s  cpu% disk_busy%
15:07:44      76%    2872     P1   104        0  477%         0%
15:07:46     100%    2872     P1   111        0  483%         0%
15:07:48      74%    2872     P1   112        0  500%         0%
15:07:50      34%    2872     P1   106        0  500%         0%
15:07:52       4%    2872     P1   103        0  497%         0%
15:07:54       0%    2872     P1   105        0  483%         0%
15:07:56       6%    2872     P1   102        0  482%         0%
15:07:58      49%    2872     P1   103        0  499%         1%
```

Fed, `--workers 12`:

```
time     gpu_busy  sm_mhz pstate watts  ioctl/s  cpu% disk_busy%
15:08:40      99%    2850     P1   187        0  113%         0%
15:08:42      99%    2850     P1   187        0  106%         0%
15:08:44     100%    2850     P1   187        0  102%         0%
15:08:46       0%    2850     P1   154        0   96%         1%
15:08:48      99%    2850     P1   187        0  110%         0%
15:08:50      99%    2850     P1   186        0  107%         0%
15:08:52     100%    2850     P1   186        0  102%         0%
```

Read the starved table top to bottom. The GPU is not slow and it is
not throttled: the SM clock is pinned at 2872 MHz, P1, and when work
arrives it goes to 100 percent. It is *waiting*. Busy sawtooths from
100 to 0 and back, and power sits around 105 W where a fed ResNet-50
pulls 187. The disk is idle: the dataset fits in page cache, so this
is not I/O. The column that explains it is `cpu%`: the training
process is burning five cores. Decoding JPEGs and running the
augmentation on the main thread, between steps, while the GPU sits.

The fix moves that work to worker processes. Fed, the main process
drops to one core, the twelve workers share about two more, and the
GPU never waits. Through the graph:

```
$ yeet graph query '{ procs { stat { comm utime stime } } }'     # summed by name over 10 s
python           procs= 1 cpu= 106%
pt_data_worker   procs=12 cpu= 218%
```

The periodic dip to 0 percent in the fed table, every eight seconds,
is the epoch boundary: 8000 images at 128 a batch is 62 steps, and
the loader stalls while it reshuffles. On a real dataset you would
never see it; here it's a reminder that the loader is still the only
thing that can starve this GPU.

## What the probe adds, and what it doesn't

The `ioctl/s` column is the kprobe view of the trainer, and it reads
zero in both tables. That is correct and worth knowing: a CUDA process
makes about a thousand ioctls creating its context, then submits work
through memory-mapped queues with almost no syscalls. gpu-watch shows
the setup burst, and the uvm faults if the model used managed memory,
but steady-state training is invisible to the driver's syscall
surface. For "who is talking to the GPU" the probe's answer is the
process list and the contexts, which is what `fields=driver,holders`
gives you. For "how hard" it is NVML's utilization.

## The same diagnosis from an agent

Point Claude Code at the service and ask it why training is slow:

```sh
claude mcp add gpu-watch -- ssh gpu-host yeet dial ws://127.0.0.1:9480/mcp
```

It has `gpu_watch` for the sawtooth, `gpu_snapshot(fields: "processes")`
for the trainer's pid, and `graph_query` for that pid's CPU time and
the block devices. Three calls reach the sentence at the top of this
page: the GPU is waiting on the host, the host is decoding on one
thread, add workers.

## Files

- `make_dataset.py`: 8000 JPEGs of random colour blobs, ten classes,
  320 pixels square, so the loader has real decode work per image.
- `train.py`: ResNet-50, AMP, channels-last, with every step split
  into waiting and computing. `--workers` is the whole experiment.
- `observe.py`: the two-second table above, from `/gpu` and
  `yeet graph query`.
