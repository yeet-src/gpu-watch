"""Make a small ImageFolder-style dataset of JPEGs on disk.

The images are random colour blobs, which matter only in that they
decode like real photos: a 320x320 JPEG per sample, 10 classes, so a
dataloader has real work to do per image.

    python make_dataset.py data 8000
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw

root = sys.argv[1] if len(sys.argv) > 1 else "data"
count = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
classes = 10
size = 320
rng = np.random.default_rng(0)

for cls in range(classes):
    os.makedirs(os.path.join(root, f"class{cls}"), exist_ok=True)

for i in range(count):
    cls = i % classes
    path = os.path.join(root, f"class{cls}", f"{i:06d}.jpg")
    if os.path.exists(path):
        continue
    base = rng.integers(0, 256, size=(size, size, 3), dtype=np.uint8)
    img = Image.fromarray(base)
    draw = ImageDraw.Draw(img)
    for _ in range(12):
        x0, y0 = rng.integers(0, size, 2)
        r = int(rng.integers(10, 90))
        colour = tuple(int(c) for c in rng.integers(0, 256, 3))
        draw.ellipse([x0 - r, y0 - r, x0 + r, y0 + r], fill=colour)
    img.save(path, "JPEG", quality=90)
    if i % 1000 == 0:
        print(f"{i}/{count}", flush=True)

print(f"{count} images under {root}")
