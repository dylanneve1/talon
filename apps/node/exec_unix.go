//go:build !windows

package main

import (
	"context"
	"io"
	"os"
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
//
// The pipes are created here rather than with cmd.StdoutPipe(), because
// those are owned by os/exec: "Wait will close the pipe after seeing the
// command exit […] it is thus incorrect to call Wait before all reads from
// the pipe have completed." This function must call Wait first — it is what
// reports the exit code, and the whole point of the drain grace is that the
// reads may NOT have completed — so with exec-owned pipes, Wait raced the
// copy goroutines and closed the read end mid-read. The copy then returned
// early with "file already closed" and whatever was still in the pipe
// buffer was silently dropped: an intermittent empty stdout or stderr on a
// command that had in fact produced both (~1 run in 500 locally, and the
// flake that failed the v3.9.0 release build).
//
// Pipes we own are closed by nobody but us, so Wait cannot pull them out
// from under the readers, and the drain grace means what it says.
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

	outR, outW, err := os.Pipe()
	if err != nil {
		return 0, false, err
	}
	defer outR.Close() //nolint:errcheck
	errR, errW, err := os.Pipe()
	if err != nil {
		outW.Close() //nolint:errcheck
		return 0, false, err
	}
	defer errR.Close() //nolint:errcheck
	// Assigning *os.File (rather than an io.Writer) hands the fd straight to
	// the child: os/exec spawns no copy goroutine of its own and Wait has
	// nothing of ours to wait on or close.
	cmd.Stdout = outW
	cmd.Stderr = errW

	startErr := cmd.Start()
	// The parent's copies of the write ends must go regardless: while we
	// hold one, the reader never sees EOF. After a failed Start they are
	// simply the only holders left.
	outW.Close() //nolint:errcheck
	errW.Close() //nolint:errcheck
	if startErr != nil {
		return 0, false, startErr
	}

	outDone := make(chan struct{})
	errDone := make(chan struct{})
	go func() { io.Copy(stdout, outR); close(outDone) }() //nolint:errcheck
	go func() { io.Copy(stderr, errR); close(errDone) }() //nolint:errcheck

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

	// Grace period for lingering pipe writers (see doc comment). The
	// deferred Close on each read end then unblocks any copy goroutine still
	// waiting on a backgrounded child, so neither the goroutine nor the pipe
	// outlives this call.
	//
	// One DEADLINE shared by both streams, not one timeout each — and not a
	// single time.After channel read twice, which is what this was: a timer
	// channel delivers exactly one value, so once stdout consumed it, the
	// wait on stderr had no timeout left and blocked until the lingering
	// writer happened to exit. `echo hi; sleep 30 &` hung the command for
	// the full 30s. That never showed before because exec-owned pipes were
	// closed by Wait, which ended both copies early — the same bug that ate
	// the output. Fixing one exposed the other.
	deadline := time.Now().Add(1500 * time.Millisecond)
	for _, done := range []chan struct{}{outDone, errDone} {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		grace := time.NewTimer(remaining)
		select {
		case <-done:
		case <-grace.C:
		}
		grace.Stop()
	}

	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			return exitErr.ExitCode(), timedOut, nil
		}
		return -1, timedOut, waitErr
	}
	return 0, timedOut, nil
}
