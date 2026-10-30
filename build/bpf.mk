# BPF build rules, included by the root Makefile after build/toolchain.mk.
#
# Every lib/bpf/*.bpf.c is its own loadable object in lib/bpf/bin/; here
# that is gpu, the kprobes on the NVIDIA, UVM and DRM entry points the
# sampler loads. vmlinux.h (CO-RE) is generated from the running
# kernel's BTF into lib/bpf/include/.

CLANG   ?= clang
BPFTOOL ?= $(shell command -v bpftool 2>/dev/null || echo /usr/sbin/bpftool)

UNAME_M := $(shell uname -m)
ARCH    := $(UNAME_M:x86_64=x86)
ARCH    := $(ARCH:aarch64=arm64)

BPF_DIR  := lib/bpf
VMLINUX  := $(BPF_DIR)/include/vmlinux.h
BPF_SRCS := $(wildcard $(BPF_DIR)/*.bpf.c)
BPF_OBJS := $(patsubst $(BPF_DIR)/%.bpf.c,$(BPF_DIR)/bin/%.bpf.o,$(BPF_SRCS))

BPF_CFLAGS ?= -g -O2 -Wall -target bpf -D__TARGET_ARCH_$(ARCH) -I $(BPF_DIR)/include
# The vendored libbpf program headers (<bpf/bpf_helpers.h>, ...) when the
# toolchain supplies them; otherwise a host libbpf-dev on the default path.
BPF_CFLAGS += $(if $(BPF_SYSINCLUDE),-I$(BPF_SYSINCLUDE))

bpf: $(BPF_OBJS)

$(VMLINUX): | toolchain
	@command -v $(BPFTOOL) >/dev/null 2>&1 || { echo "error: bpftool not found"; exit 1; }
	sh build/gen-vmlinux.sh $(BPFTOOL) $@

$(BPF_DIR)/bin/%.bpf.o: $(BPF_DIR)/%.bpf.c $(VMLINUX) | toolchain
	@command -v $(CLANG) >/dev/null 2>&1 || { echo "error: clang not found"; exit 1; }
	@mkdir -p $(dir $@)
	$(CLANG) $(BPF_CFLAGS) -c $< -o $@

clean-bpf:
	rm -rf $(BPF_DIR)/bin $(VMLINUX)

# This kernel's verifier over every object (needs sudo); the local
# counterpart of the kernel-matrix workflow.
veristat: $(BPF_OBJS) | toolchain
	@command -v $(VERISTAT) >/dev/null 2>&1 || { echo "error: veristat not found ($(VERISTAT))"; exit 1; }
	$(VERISTAT) $(BPF_OBJS)

# The same check across a matrix of kernels booted locally (Linux + KVM).
veristat-matrix: $(BPF_OBJS) | toolchain
	VERISTAT="$(VERISTAT)" sh build/kernel-matrix.sh $(KERNELS)

.PHONY: bpf clean-bpf veristat veristat-matrix
