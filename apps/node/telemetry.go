package main

import (
	"fmt"
	"runtime"
	"time"
)

var startedAt = time.Now()

// hostTelemetry returns flat string key/values merged into the `status`
// command's payload. Base fields are cross-platform; OS-specific files add
// richer probes (uptime, load, memory, disk) where the stdlib can reach
// them without shelling out.
func hostTelemetry() map[string]string {
	out := map[string]string{
		"os":         runtime.GOOS,
		"arch":       runtime.GOARCH,
		"cpus":       fmt.Sprintf("%d", runtime.NumCPU()),
		"nodeUptime": time.Since(startedAt).Round(time.Second).String(),
	}
	for k, v := range platformTelemetry() {
		out[k] = v
	}
	return out
}

func formatBytes(b uint64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
