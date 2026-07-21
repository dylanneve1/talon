//go:build windows

package main

import (
	"context"
	"io"
	"os/exec"
	"sync/atomic"
	"time"
)

// runShell executes the command line under PowerShell. Windows has no
// process groups in the POSIX sense; Kill() terminates the shell itself,
// which is the practical budget enforcement for v1.
func runShell(
	ctx context.Context,
	cmdline, cwd string,
	budget time.Duration,
	stdout, stderr io.Writer,
) (exitCode int, timedOut bool, err error) {
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile", "-NonInteractive", "-Command", cmdline,
	)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return 0, false, err
	}

	var killed atomic.Bool
	timer := time.AfterFunc(budget, func() {
		killed.Store(true)
		cmd.Process.Kill() //nolint:errcheck
	})
	ctxDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			cmd.Process.Kill() //nolint:errcheck
		case <-ctxDone:
		}
	}()

	waitErr := cmd.Wait()
	timer.Stop()
	close(ctxDone)
	timedOut = killed.Load()

	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			return exitErr.ExitCode(), timedOut, nil
		}
		return -1, timedOut, waitErr
	}
	return 0, timedOut, nil
}
