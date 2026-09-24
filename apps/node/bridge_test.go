package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testNode(t *testing.T, bridge string) *Node {
	t.Helper()
	n, err := NewNode(&Config{
		Bridge:   bridge,
		Token:    "test-token",
		DeviceID: "node-test",
		Path:     filepath.Join(t.TempDir(), "config.json"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestReconnectBackoffDoublesAndResetsAfterStableStream(t *testing.T) {
	backoff := minReconnectBackoff
	var waits []time.Duration
	for i := 0; i < 7; i++ {
		var wait time.Duration
		wait, backoff = reconnectBackoff(backoff, 0)
		waits = append(waits, wait)
	}
	want := []time.Duration{1, 2, 4, 8, 16, 30, 30}
	for i, w := range want {
		if waits[i] != w*time.Second {
			t.Fatalf("failure %d: waited %s, want %s (all: %v)", i, waits[i], w*time.Second, waits)
		}
	}
	// A stream that stayed up resets the backoff: the next drop reconnects
	// fast instead of waiting the capped 30s (commands in that gap are lost).
	wait, next := reconnectBackoff(backoff, stableStreamAfter)
	if wait != minReconnectBackoff || next != 2*minReconnectBackoff {
		t.Fatalf("after a stable stream: wait %s next %s", wait, next)
	}
	// A stream that connected but dropped at once keeps backing off.
	wait, _ = reconnectBackoff(8*time.Second, time.Second)
	if wait != 8*time.Second {
		t.Fatalf("flapping stream reset the backoff: wait %s", wait)
	}
}

// sseBridge serves /events (a ping, then silence until the client leaves)
// and accepts registrations and command results.
func sseBridge(t *testing.T, results chan<- map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/events":
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, ": ping\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done() // half-open: headers and a ping, then nothing
		case "/devices/command-result":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if results != nil {
				results <- body
			}
			_, _ = io.WriteString(w, `{"ok":true}`)
		default:
			_, _ = io.WriteString(w, `{"ok":true}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestConsumeEventsGivesUpOnASilentStream(t *testing.T) {
	prev := streamIdleTimeout
	streamIdleTimeout = 200 * time.Millisecond
	t.Cleanup(func() { streamIdleTimeout = prev })

	n := testNode(t, sseBridge(t, nil).URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	uptime, err := n.consumeEvents(ctx)
	if !errors.Is(err, errStreamIdle) {
		t.Fatalf("err = %v, want errStreamIdle", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("took %s to notice a dead stream", elapsed)
	}
	if uptime <= 0 {
		t.Fatalf("uptime %s for a stream that did connect", uptime)
	}
	if ctx.Err() != nil {
		t.Fatal("the idle deadline must not cancel the parent context")
	}
}

func TestPostJSONReusesConnectionForLargeReplies(t *testing.T) {
	var conns atomic.Int32
	big := `{"ok":true,"pad":"` + strings.Repeat("x", 32<<10) + `"}`
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, big)
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			conns.Add(1)
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)

	n := testNode(t, srv.URL)
	for i := 0; i < 3; i++ {
		// The reply is >4KB, so the parsed prefix is truncated JSON — the
		// point here is only what happens to the connection afterwards.
		_ = n.postJSON(context.Background(), "/devices/register", map[string]any{}, nil)
	}
	if got := conns.Load(); got != 1 {
		t.Fatalf("%d TCP connections for 3 requests; replies >4KB must be drained so keep-alive works", got)
	}
}

// Run with -race: TLS handshakes on several goroutines record the seen
// fingerprint while registration adopts it (#1061).
func TestFingerprintTrackingIsRaceFree(t *testing.T) {
	n := testNode(t, "https://127.0.0.1:1")
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				der := make([]byte, 32)
				_, _ = rand.Read(der)
				_ = n.verifyPinnedCert([][]byte{der}, nil)
				_ = n.pinnedFingerprint()
			}
		}()
	}
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				n.maybeAdoptFingerprint()
			}
		}()
	}
	wg.Wait()
	if n.pinnedFingerprint() == "" {
		t.Fatal("no fingerprint adopted")
	}
	if len(n.lastSeenFingerprint()) != 64 {
		t.Fatalf("seen fingerprint %q is not a sha256 hex", n.lastSeenFingerprint())
	}
}
