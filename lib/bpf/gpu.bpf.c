/* Kernel-side view of who touches the GPUs. Every userspace path to
 * an NVIDIA GPU goes through three char devices: /dev/nvidia* and
 * /dev/nvidiactl (the resource manager, module `nvidia`), and
 * /dev/nvidia-uvm (unified memory, module `nvidia_uvm`). DRM nodes
 * under /dev/dri cover every KMS/render driver, nvidia_drm and
 * amdgpu alike. NVML only reports processes that hold a context at
 * sample time; kprobes on the entry points see every call, including
 * ones from processes that live for a millisecond.
 *
 * Per-pid counters go in an LRU hash the sampler drains every tick,
 * so the kernel side only ever holds deltas; the JS side keeps the
 * running totals. Latency is measured per thread between the kprobe
 * and the kretprobe.
 */
#define BPF_NO_KFUNC_PROTOTYPES
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wmissing-declarations"
#include "vmlinux.h"
#pragma clang diagnostic pop
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

#define MINORBITS 20
#define MINORMASK ((1U << MINORBITS) - 1)

struct gpu_counts {
    __u64 rm_ioctls;
    __u64 rm_ioctl_ns;
    __u64 rm_errors;
    __u64 uvm_ioctls;
    __u64 uvm_ioctl_ns;
    __u64 uvm_errors;
    __u64 drm_ioctls;
    __u64 rm_opens;
    __u64 rm_closes;
    __u64 rm_mmaps;
    __u64 uvm_opens;
    __u64 uvm_releases;
    __u64 uvm_mmaps;
    __u64 first_ns;
    __u64 last_ns;
    __u32 uid;
    char comm[16];
};

struct node_key {
    __u32 major;
    __u32 minor;
};

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 4096);
    __type(key, __u32);
    __type(value, struct gpu_counts);
} by_pid SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);
    __type(value, __u64);
} rm_cmds SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);
    __type(value, __u64);
} uvm_cmds SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 256);
    __type(key, struct node_key);
    __type(value, __u64);
} rm_nodes SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 256);
    __type(key, struct node_key);
    __type(value, __u64);
} drm_nodes SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 16384);
    __type(key, __u32);
    __type(value, __u64);
} inflight SEC(".maps");

static __always_inline struct gpu_counts *counts(void)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;
    __u64 now = bpf_ktime_get_ns();
    struct gpu_counts *c = bpf_map_lookup_elem(&by_pid, &pid);
    if (c) {
        c->last_ns = now;
        return c;
    }

    struct gpu_counts fresh = {};
    fresh.first_ns = now;
    fresh.last_ns = now;
    fresh.uid = bpf_get_current_uid_gid() & 0xffffffff;
    bpf_get_current_comm(fresh.comm, sizeof(fresh.comm));
    bpf_map_update_elem(&by_pid, &pid, &fresh, BPF_NOEXIST);
    return bpf_map_lookup_elem(&by_pid, &pid);
}

static __always_inline void bump(void *map, const void *key)
{
    __u64 *n = bpf_map_lookup_elem(map, key);
    if (n) {
        __sync_fetch_and_add(n, 1);
        return;
    }
    __u64 one = 1;
    bpf_map_update_elem(map, key, &one, BPF_NOEXIST);
}

static __always_inline void bump_node(void *map, struct file *filp)
{
    dev_t rdev = BPF_CORE_READ(filp, f_inode, i_rdev);
    struct node_key key = { .major = rdev >> MINORBITS, .minor = rdev & MINORMASK };
    bump(map, &key);
}

static __always_inline void enter(void)
{
    __u32 tid = bpf_get_current_pid_tgid();
    __u64 now = bpf_ktime_get_ns();
    bpf_map_update_elem(&inflight, &tid, &now, BPF_ANY);
}

static __always_inline __u64 leave(void)
{
    __u32 tid = bpf_get_current_pid_tgid();
    __u64 *start = bpf_map_lookup_elem(&inflight, &tid);
    if (!start)
        return 0;
    __u64 delta = bpf_ktime_get_ns() - *start;
    bpf_map_delete_elem(&inflight, &tid);
    return delta;
}

SEC("kprobe/nvidia_unlocked_ioctl")
int BPF_KPROBE(rm_ioctl_enter, struct file *filp, unsigned int cmd)
{
    struct gpu_counts *c = counts();
    if (!c)
        return 0;
    __sync_fetch_and_add(&c->rm_ioctls, 1);
    __u32 nr = cmd & 0xff;
    bump(&rm_cmds, &nr);
    bump_node(&rm_nodes, filp);
    enter();
    return 0;
}

SEC("kretprobe/nvidia_unlocked_ioctl")
int BPF_KRETPROBE(rm_ioctl_exit, long ret)
{
    __u64 delta = leave();
    struct gpu_counts *c = counts();
    if (!c)
        return 0;
    __sync_fetch_and_add(&c->rm_ioctl_ns, delta);
    if (ret < 0)
        __sync_fetch_and_add(&c->rm_errors, 1);
    return 0;
}

SEC("kprobe/uvm_ioctl")
int BPF_KPROBE(uvm_ioctl_enter, struct file *filp, unsigned int cmd)
{
    struct gpu_counts *c = counts();
    if (!c)
        return 0;
    __sync_fetch_and_add(&c->uvm_ioctls, 1);
    __u32 nr = cmd & 0xff;
    bump(&uvm_cmds, &nr);
    enter();
    return 0;
}

SEC("kretprobe/uvm_ioctl")
int BPF_KRETPROBE(uvm_ioctl_exit, long ret)
{
    __u64 delta = leave();
    struct gpu_counts *c = counts();
    if (!c)
        return 0;
    __sync_fetch_and_add(&c->uvm_ioctl_ns, delta);
    if (ret < 0)
        __sync_fetch_and_add(&c->uvm_errors, 1);
    return 0;
}

SEC("kprobe/drm_ioctl")
int BPF_KPROBE(drm_ioctl_enter, struct file *filp)
{
    struct gpu_counts *c = counts();
    if (!c)
        return 0;
    __sync_fetch_and_add(&c->drm_ioctls, 1);
    bump_node(&drm_nodes, filp);
    return 0;
}

#define COUNT_CALL(sym, field)                     \
    SEC("kprobe/" #sym)                            \
    int BPF_KPROBE(sym##_enter)                    \
    {                                              \
        struct gpu_counts *c = counts();           \
        if (c)                                     \
            __sync_fetch_and_add(&c->field, 1);    \
        return 0;                                  \
    }

COUNT_CALL(nvidia_open, rm_opens)
COUNT_CALL(nvidia_close, rm_closes)
COUNT_CALL(nvidia_mmap, rm_mmaps)
COUNT_CALL(uvm_open_entry, uvm_opens)
COUNT_CALL(uvm_release_entry, uvm_releases)
COUNT_CALL(uvm_mmap_entry, uvm_mmaps)

char LICENSE[] SEC("license") = "GPL";
