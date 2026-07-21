//go:build darwin

package main

import (
	"fmt"
	"syscall"
)

// platformTelemetry keeps to what the stdlib reaches on macOS without cgo
// or subprocesses: root-volume disk usage. (Uptime/memory need sysctl —
// worth adding if headless Macs become a common node target.)
func platformTelemetry() map[string]string {
	out := map[string]string{}
	var fs syscall.Statfs_t
	if err := syscall.Statfs("/", &fs); err == nil {
		out["disk"] = fmt.Sprintf(
			"%s free of %s on /",
			formatBytes(fs.Bavail*uint64(fs.Bsize)),
			formatBytes(fs.Blocks*uint64(fs.Bsize)),
		)
	}
	return out
}
