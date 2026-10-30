# gpu-watch on yeet.
#
#   make up                      # build the probe if needed, start the service on :9480
#   make up PORT=9490            # serve on another port
#   make down                    # stop and remove the service
#   make status                  # the service tree
#   make scrape                  # curl /metrics
#   make snapshot                # curl /gpu as a table
#   make top                     # the live terminal view
#
#   make                         # just build lib/bpf/bin/gpu.bpf.o (vendored toolchain)
#   make check                   # syntax over every script
#   make pack                    # gpu-watch.tar.gz, importable anywhere with `yeet service import`
#   sudo make veristat           # this kernel's verifier over the probe
#   make veristat-matrix         # the same across booted kernels (Linux + KVM)

.DEFAULT_GOAL := all

include build/toolchain.mk
include build/bpf.mk

PORT ?= 9480
SVC  := gpu-watch

all: bpf

up: bpf
	./deploy.sh $(PORT)

down:
	./deploy.sh remove

status:
	yeet service tree $(SVC)

scrape:
	curl -fsS localhost:$(PORT)/metrics

snapshot:
	curl -fsS 'localhost:$(PORT)/gpu?format=table'

top:
	yeet dial ws://127.0.0.1:$(PORT)/top

# The pack is what `yeet service import` reads: one archive with the
# service file at the top and the scripts beside it. Only the runtime
# goes in, the built probe included, so no toolchain is needed where
# it is imported. Plain tar, so a release can be cut without yeet.
pack: bpf
	rm -rf .pack && mkdir -p .pack/lib/bpf/bin
	cp service.toml *.js .pack/ && cp lib/*.js .pack/lib/ && cp lib/bpf/bin/gpu.bpf.o .pack/lib/bpf/bin/
	tar czf $(SVC).tar.gz -C .pack .
	rm -rf .pack

check:
	@set -e; for f in $$(find . -name '*.js' -not -path './node_modules/*'); do node --check "$$f"; done; echo "js ok"
	@set -e; for f in build/*.sh deploy.sh; do sh -n "$$f"; done; echo "sh ok"

clean: clean-bpf
	rm -rf .kmatrix .pack $(SVC).tar.gz

.PHONY: all up down status scrape snapshot top pack check clean
