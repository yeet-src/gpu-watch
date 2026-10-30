// Names for the ioctl numbers the probes count, so a scrape reads as
// `rm_control` rather than `42`. The NVIDIA resource-manager escapes
// come from nv_escape.h and nv-ioctl-numbers.h in the open kernel
// module; the UVM numbers from uvm_ioctl.h. An unlisted number is
// still exported, labelled by its `nr` alone.

export const RM_ESCAPES = {
  0x27: "rm_alloc_memory",
  0x28: "rm_alloc_object",
  0x29: "rm_free",
  0x2a: "rm_control",
  0x2b: "rm_alloc",
  0x32: "rm_config_get",
  0x33: "rm_config_set",
  0x34: "rm_dup_object",
  0x35: "rm_share",
  0x37: "rm_config_get_ex",
  0x38: "rm_config_set_ex",
  0x39: "rm_i2c_access",
  0x41: "rm_idle_channels",
  0x4a: "rm_vid_heap_control",
  0x4d: "rm_access_registry",
  0x4e: "rm_map_memory",
  0x4f: "rm_unmap_memory",
  0x52: "rm_get_event_data",
  0x54: "rm_alloc_context_dma2",
  0x57: "rm_map_memory_dma",
  0x58: "rm_unmap_memory_dma",
  0x59: "rm_bind_context_dma",
  0x5c: "rm_export_object_to_fd",
  0x5d: "rm_import_object_from_fd",
  0x5e: "rm_update_device_mapping_info",
  0x5f: "rm_lockless_diagnostic",
  0xc8: "card_info",
  0xc9: "register_fd",
  0xce: "alloc_os_event",
  0xcf: "free_os_event",
  0xd1: "status_code",
  0xd2: "check_version_str",
  0xd3: "ioctl_xfer_cmd",
  0xd4: "attach_gpus_to_fd",
  0xd5: "query_device_intr",
  0xd6: "sys_params",
  0xd7: "numa_info",
  0xd8: "set_numa_status",
  0xd9: "export_to_dmabuf_fd",
  0xda: "wait_open_complete",
};

export const UVM_ESCAPES = {
  0x01: "initialize",
  0x02: "deinitialize",
  0x21: "map_external_allocation",
  0x25: "register_gpu",
  0x26: "unregister_gpu",
  0x27: "pageable_mem_access",
  0x28: "set_preferred_location",
  0x29: "unset_preferred_location",
  0x2b: "set_accessed_by",
  0x2c: "unset_accessed_by",
  0x2d: "register_gpu_vaspace",
  0x2e: "unregister_gpu_vaspace",
  0x2f: "register_channel",
  0x30: "unregister_channel",
  0x33: "enable_read_duplication",
  0x34: "disable_read_duplication",
  0x35: "set_range_group",
  0x36: "create_range_group",
  0x37: "destroy_range_group",
  0x38: "migrate",
  0x39: "migrate_range_group",
  0x3a: "enable_system_wide_atomics",
  0x3b: "disable_system_wide_atomics",
  0x3d: "create_external_range",
  0x3e: "free",
  0x40: "map_dynamic_parallelism_region",
  0x41: "enable_peer_access",
  0x42: "disable_peer_access",
  0x43: "alloc_semaphore_pool",
  0x44: "clean_up_zombie_resources",
  0x45: "pageable_mem_access_on_gpu",
  0x46: "populate_pageable",
  0x47: "validate_va_range",
  0x48: "prevent_migration_range_groups",
  0x49: "allow_migration_range_groups",
  0x4a: "set_preferred_location_v2",
  0x4b: "set_accessed_by_v2",
  0x4c: "unset_accessed_by_v2",
  0x4d: "migrate_v2",
  0x4e: "tools_init_event_tracker",
  0x4f: "tools_set_notification_threshold",
  0x50: "tools_event_queue_enable_events",
  0x51: "tools_event_queue_disable_events",
  0x52: "tools_enable_counters",
  0x53: "tools_disable_counters",
  0x54: "tools_read_process_memory",
  0x55: "tools_write_process_memory",
  0x56: "tools_get_processor_uuid_table",
  0x57: "map_dynamic_parallelism_region_v2",
  0x58: "unmap_external",
  0x59: "alloc_device_p2p",
  0x5a: "tools_flush_events",
  0x5b: "mm_initialize",
};

// Char device majors from the kernel's devices.txt. nvidia-uvm takes
// a dynamic major, so the sampler reports it by name from the probe
// that saw it, not by number.
export const NVIDIA_MAJOR = 195;
export const DRM_MAJOR = 226;

export const nodeName = (major, minor) => {
  if (major === NVIDIA_MAJOR) return minor === 255 ? "nvidiactl" : `nvidia${minor}`;
  if (major === DRM_MAJOR) return minor >= 128 ? `renderD${minor}` : `card${minor}`;
  return `${major}:${minor}`;
};
