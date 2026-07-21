//go:build !windows

package main

import (
	"context"
	"io"
	"os/exec"
	"sync/atomic"
	"syscall"
	"time"
)

// runShell executes `sh -c <cmdline>` with its own process group, so a
// timeout kills the whole tree (a plain Process.Kill would orphan children
// and let a runaway pipeline keep burning CPU).
//
// The pipe-drain trick mirrors the companion app: after the shell exits, a
// backgrounded child (`long-running &`) can inherit the stdout/stderr pipes
// and hold them open long after — so output collection gets a short grace,
// then the command answers with whatever has arrived. Redirect-to-file is
// the supported channel for persistent streams.
func runShell(
	ctx context.Context,
	cmdline, cwd string,
	budget time.Duration,
	stdout, stderr io.Writer,
) (exitCode int, timedOut bool, err error) {
	cmd := exec.Command("/bin/sh", "-c", cmdline)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	outPipe, err := cmd.StdoutPipe()
	if err != nil {
		return 0, false, err
	}
	errPipe, err := cmd.StderrPipe()
	if err != nil {
		return 0, false, err
	}
	if err := cmd.Start(); err != nil {
		return 0, false, err
	}

	outDone := make(chan struct{})
	errDone := make(chan struct{})
	go func() { io.Copy(stdout, outPipe); close(outDone) }() //nolint:errcheck
	go func() { io.Copy(stderr, errPipe); close(errDone) }() //nolint:errcheck

	var killed atomic.Bool
	timer := time.AfterFunc(budget, func() {
		killed.Store(true)
		// Negative pid targets the process group.
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) //nolint:errcheck
	})
	// Also honor ctx cancellation (node shutting down mid-command).
	ctxDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) //nolint:errcheck
		case <-ctxDone:
		}
	}()

	waitErr := cmd.Wait()
	timer.Stop()
	close(ctxDone)
	timedOut = killed.Load()

	// Grace period for lingering pipe writers (see doc comment).
	drain := time.After(1500 * time.Millisecond)
	for _, done := range []chan struct{}{outDone, errDone} {
		select {
		case <-done:
		case <-drain:
		}
	}

	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			return exitErr.ExitCode(), timedOut, nil
		}
		return -1, timedOut, waitErr
	}
	return 0, timedOut, nil
}
