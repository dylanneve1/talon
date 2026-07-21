//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const launchdLabel = "com.talon.node"

func plistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(
		home, "Library", "LaunchAgents", launchdLabel+".plist",
	)
}

// serviceInstall writes a LaunchAgent for the current user and loads it.
// KeepAlive gives the same restart-on-crash behavior as the systemd unit.
func serviceInstall(cfg *Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>run</string>
    <string>--config</string>
    <string>%s</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`, launchdLabel, exe, cfg.Path)
	path := plistPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		return err
	}
	exec.Command("launchctl", "unload", path).Run() //nolint:errcheck
	if out, err := exec.Command("launchctl", "load", "-w", path).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl load: %v: %s", err, out)
	}
	fmt.Printf("Installed and started LaunchAgent %s (%s)\n", launchdLabel, path)
	return nil
}

func serviceUninstall() error {
	path := plistPath()
	exec.Command("launchctl", "unload", "-w", path).Run() //nolint:errcheck
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Printf("Removed LaunchAgent %s\n", launchdLabel)
	return nil
}

func serviceState() string {
	out, err := exec.Command("launchctl", "list").Output()
	if err != nil {
		return "unknown"
	}
	if strings.Contains(string(out), launchdLabel) {
		return "loaded (LaunchAgent)"
	}
	return "not installed"
}
