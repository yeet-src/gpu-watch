#!/bin/sh
# Runs INSIDE a per-kernel VM: load every built BPF object with the static
# veristat and fail if this kernel's verifier rejects any program in any of
# them. Driven by .github/workflows/kernel-matrix.yml, which boots each
# kernel with cilium's little-vm-helper and mounts the project at /host
# after staging veristat into lib/bpf/bin/.
#
#   sh build/verify-kernel.sh [object ...]   (default: lib/bpf/bin/*.bpf.o)
#
# OUT_CSV=<path> also writes file,prog,insns,states,verdict for the
# workflow's summary table. veristat exits 0 even when a program fails to
# load, so the gate reads the verdict column, not the status.

set -eu

VERISTAT="${VERISTAT:-./lib/bpf/bin/veristat}"
COLS="file,prog,insns,states,verdict"

[ $# -gt 0 ] || set -- lib/bpf/bin/*.bpf.o
[ -x "$VERISTAT" ] || { echo "error: veristat not found/executable at $VERISTAT" >&2; exit 1; }
for obj; do [ -f "$obj" ] || { echo "error: BPF object not found at $obj" >&2; exit 1; }; done

KREL="$(uname -r)"
echo ">> kernel $KREL: loading $*"

"$VERISTAT" "$@" || true

csv="$("$VERISTAT" -o csv -e "$COLS" "$@")"
if [ -n "${OUT_CSV:-}" ]; then
	mkdir -p "$(dirname "$OUT_CSV")"
	printf '%s\n' "$csv" > "$OUT_CSV"
fi

if printf '%s\n' "$csv" | tail -n +2 | grep -q ',failure$'; then
	# The verifier's own log for each rejected program, so the reason is
	# in the job output and not only the verdict.
	printf '%s\n' "$csv" | tail -n +2 | grep ',failure$' | while IFS=, read -r file prog _; do
		echo ">> verifier log for $file:$prog"
		"$VERISTAT" -v -f "$prog" "$file" 2>&1 | tail -n 60 || true
	done
	echo "::error::BPF verifier rejected a program on kernel $KREL" >&2
	exit 1
fi

echo ">> all programs in $# object(s) loaded on kernel $KREL"
