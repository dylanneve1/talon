//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

const taskName = "TalonNode"

// serviceInstall registers a Scheduled Task that starts the node at boot as
// SYSTEM. A scheduled task (unlike an SCM service) runs a plain console
// binary without service-control plumbing — the pragmatic zero-dependency
// route; a real SCM service can follow if Windows nodes become common.
func serviceInstall(cfg *Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	tr := fmt.Sprintf(`"%s" run --config "%s"`, exe, cfg.Path)
	out, err := exec.Command(
		"schtasks", "/Create", "/F",
		"/TN", taskName,
		"/SC", "ONSTART",
		"/RU", "SYSTEM",
		"/TR", tr,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks create: %v: %s", err, out)
	}
	if out, err := exec.Command(
		"schtasks", "/Run", "/TN", taskName,
	).CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks run: %v: %s", err, out)
	}
	fmt.Printf("Installed and started scheduled task %s\n", taskName)
	return nil
}

func serviceUninstall() error {
	exec.Command("schtasks", "/End", "/TN", taskName).Run() //nolint:errcheck
	out, err := exec.Command(
		"schtasks", "/Delete", "/F", "/TN", taskName,
	).CombinedOutput()
	if err != nil && !strings.Contains(string(out), "ERROR: The system cannot find") {
		return fmt.Errorf("schtasks delete: %v: %s", err, out)
	}
	fmt.Printf("Removed scheduled task %s\n", taskName)
	return nil
}

func serviceState() string {
	out, err := exec.Command(
		"schtasks", "/Query", "/TN", taskName,
	).CombinedOutput()
	if err != nil {
		return "not installed"
	}
	if strings.Contains(string(out), "Running") {
		return "running (scheduled task)"
	}
	return "installed (scheduled task)"
}
