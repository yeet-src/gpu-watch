"""Train ResNet-50 on the JPEG dataset, and say where each step's time goes.

The one knob that matters is --workers. With 0 the main process
decodes and augments every image itself and the GPU waits; with 8 or
more the GPU is the bottleneck. Each log line splits a step into the
time spent waiting for the next batch and the time spent computing.

    python train.py --data data --workers 0 --steps 300
    python train.py --data data --workers 12 --steps 300
"""

import argparse
import os
import time

import torch
import torch.nn as nn
import torchvision
from torch.utils.data import DataLoader
from torchvision import transforms

p = argparse.ArgumentParser()
p.add_argument("--data", default="data")
p.add_argument("--workers", type=int, default=0)
p.add_argument("--batch", type=int, default=128)
p.add_argument("--steps", type=int, default=300)
p.add_argument("--log-every", type=int, default=10)
p.add_argument("--no-amp", action="store_true")
args = p.parse_args()

torch.backends.cudnn.benchmark = True
device = torch.device("cuda")

transform = transforms.Compose([
    transforms.RandomResizedCrop(224),
    transforms.RandomHorizontalFlip(),
    transforms.ColorJitter(0.3, 0.3, 0.3),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])
dataset = torchvision.datasets.ImageFolder(args.data, transform=transform)
loader = DataLoader(
    dataset, batch_size=args.batch, shuffle=True, num_workers=args.workers,
    pin_memory=True, drop_last=True, persistent_workers=args.workers > 0,
)

model = torchvision.models.resnet50(num_classes=len(dataset.classes)).to(device)
model = model.to(memory_format=torch.channels_last)
opt = torch.optim.SGD(model.parameters(), lr=0.1, momentum=0.9)
scaler = torch.amp.GradScaler(enabled=not args.no_amp)
loss_fn = nn.CrossEntropyLoss()

print(f"pid {os.getpid()}  workers {args.workers}  batch {args.batch}  {len(dataset)} images  "
      f"{torch.cuda.get_device_name(0)}", flush=True)

step = 0
wait_total = compute_total = 0.0
images = 0
t_log = time.perf_counter()
while step < args.steps:
    t0 = time.perf_counter()
    for x, y in loader:
        t1 = time.perf_counter()
        x = x.to(device, non_blocking=True, memory_format=torch.channels_last)
        y = y.to(device, non_blocking=True)
        with torch.autocast("cuda", enabled=not args.no_amp):
            loss = loss_fn(model(x), y)
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        torch.cuda.synchronize()
        t2 = time.perf_counter()

        wait_total += t1 - t0
        compute_total += t2 - t1
        images += x.shape[0]
        step += 1
        if step % args.log_every == 0:
            now = time.perf_counter()
            total = wait_total + compute_total
            print(f"step {step:4d}  {images / (now - t_log):7.1f} img/s  "
                  f"waiting for data {100 * wait_total / total:5.1f}%  "
                  f"computing {100 * compute_total / total:5.1f}%  loss {loss.item():.3f}", flush=True)
            wait_total = compute_total = 0.0
            images = 0
            t_log = now
        if step >= args.steps:
            break
        t0 = time.perf_counter()
