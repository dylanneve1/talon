//go:build windows

package main

// platformTelemetry: Windows disk/memory probes need win32 calls beyond
// what this v1 pulls in — the cross-platform base fields (os, arch, cpus,
// uptime of the node process) still apply.
func platformTelemetry() map[string]string {
	return map[string]string{}
}
