#!/usr/bin/env bash
# Run gpu-watch as its own yeet service.
#
#   ./deploy.sh               # every interface on 0.0.0.0:9480
#   ./deploy.sh 9490          # another port
#   ./deploy.sh remove
#
# service.toml is the service; this only swaps the port in and imports
# it. The daemon copies the code in at import, so rerun after editing,
# or `yeet service apply -f service.toml gpu-watch` to roll a change out.
set -euo pipefail
cd "$(dirname "$0")"
svc=gpu-watch
default_port=9480

if [[ ${1:-} == remove ]]; then
  yeet service remove -f "$svc"
  exit
fi
port=${1:-$default_port}

[[ -f lib/bpf/bin/gpu.bpf.o ]] || { echo "build the probe first: make (or just: make up)" >&2; exit 1; }

manifest=service.toml
if [[ $port != "$default_port" ]]; then
  manifest=.deploy.toml
  sed "s#0.0.0.0:$default_port#0.0.0.0:$port#; s#:$default_port/#:$port/#g" service.toml > "$manifest"
  trap 'rm -f .deploy.toml' EXIT
fi

yeet service remove -f "$svc" >/dev/null 2>&1 || true
yeet service import "$manifest" --now -y | tail -1
yeet service tree "$svc"
