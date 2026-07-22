package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// Heartbeat cadence matches the companion app: the daemon flips a device
// offline after ~90s without a beat (and evicts presence at 180s), so 60s
// keeps the node solidly "online" while tolerating one dropped beat.
const heartbeatInterval = 60 * time.Second

// capabilities this node advertises at registration. The daemon gates
// commands on this list, so it must exactly cover what dispatch() handles.
// locate is deliberately absent (servers have no GPS); install_apk is the
// Android self-update path and does not apply.
var nodeCapabilities = []string{
	"ring",
	"status",
	"exec",
	"read_file",
	"write_file",
	"list_dir",
	"stat",
	"delete",
	"mkdir",
	"move",
	"upload_file",
	"download_file",
	"update_node",
}

// Node is the running mesh client: pinned-TLS HTTP to the bridge plus the
// SSE consumer that turns device_command events into local work.
type Node struct {
	cfg      *Config
	client   *http.Client
	DeviceID string
	// seenFingerprint carries the leaf-certificate hash observed during TLS
	// verification of the most recent connection, for TOFU capture.
	seenFingerprint string
	// pendingReexec is set by a successful update_node so handleCommand can
	// restart into the new binary AFTER the command result has been posted
	// (a re-exec replaces the whole process image, so the ack must land
	// first or the caller would hang waiting for a reply that never comes).
	pendingReexec atomic.Bool
}

func NewNode(cfg *Config) (*Node, error) {
	n := &Node{cfg: cfg, DeviceID: cfg.DeviceID}
	transport := &http.Transport{
		// The bridge mints a self-signed certificate; identity is proven by
		// pinning its SHA-256 (exactly like the companion app), not by a CA
		// chain or hostname. VerifyPeerCertificate below is the real check.
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify:    true,
			VerifyPeerCertificate: n.verifyPinnedCert,
		},
		// SSE responses are unbounded; only bound the dial + TLS handshake.
		ResponseHeaderTimeout: 30 * time.Second,
	}
	n.client = &http.Client{Transport: transport}
	return n, nil
}

// verifyPinnedCert implements pin-or-TOFU over the leaf certificate DER —
// the same fingerprint /health advertises and companion pairing screens
// display. With a pin configured, any mismatch kills the handshake. With no
// pin yet, the observed hash is recorded and persisted after the first
// successful authenticated call (see maybeAdoptFingerprint).
func (n *Node) verifyPinnedCert(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	if len(rawCerts) == 0 {
		return errors.New("bridge presented no certificate")
	}
	sum := sha256.Sum256(rawCerts[0])
	got := hex.EncodeToString(sum[:])
	n.seenFingerprint = got
	if pin := n.cfg.Fingerprint; pin != "" && pin != got {
		return fmt.Errorf(
			"bridge certificate mismatch: pinned %s, got %s — refusing to connect",
			pin, got,
		)
	}
	return nil
}

// maybeAdoptFingerprint persists the first-seen certificate hash so every
// later connect is pinned. Called only after a request that proved the
// token works (register/health), so a rogue endpoint can't get adopted just
// by completing a handshake.
func (n *Node) maybeAdoptFingerprint() {
	if n.cfg.Fingerprint != "" || n.seenFingerprint == "" {
		return
	}
	n.cfg.Fingerprint = n.seenFingerprint
	if err := n.cfg.Save(); err != nil {
		log.Printf("warning: could not persist pinned fingerprint: %v", err)
		return
	}
	log.Printf("pinned bridge certificate %s (trust-on-first-use)", n.cfg.Fingerprint)
}

func (n *Node) apiURL(path string, query url.Values) string {
	u := n.cfg.Bridge + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

func (n *Node) authed(req *http.Request) *http.Request {
	req.Header.Set("Authorization", "Bearer "+n.cfg.Token)
	return req
}

// postJSON sends one JSON body and decodes the JSON reply (which may be
// discarded by passing nil). Non-2xx becomes an error with the body tail so
// bridge-side validation messages surface in logs.
func (n *Node) postJSON(ctx context.Context, path string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, n.apiURL(path, nil), bytes.NewReader(raw),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := n.client.Do(n.authed(req))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	reply, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("%s: HTTP %d: %s", path, res.StatusCode, strings.TrimSpace(string(reply)))
	}
	if out != nil {
		return json.Unmarshal(reply, out)
	}
	return nil
}

// Health fetches /health (unauthenticated by design — the discovery ping).
func (n *Node) Health() (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(
		ctx, http.MethodGet, n.apiURL("/health", nil), nil,
	)
	if err != nil {
		return nil, err
	}
	res, err := n.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// registrationBody is the POST /devices/register payload — also the 60s
// heartbeat body. Battery fields are omitted entirely: servers don't have
// one, and the registry treats absence correctly. Kept as its own function
// so the protocol conformance test can assert the wire shape against the
// shared fixture (protocol/fixtures/mesh_v1.json).
func (n *Node) registrationBody() map[string]any {
	return map[string]any{
		"id":       n.DeviceID,
		"name":     n.cfg.Name,
		"platform": meshPlatform(),
		// The Go arch (amd64/arm64/arm) — matched against release binary
		// names (talon-node-<os>-<arch>) so the daemon can auto-resolve the
		// right replacement for update_node.
		"arch":         runtime.GOARCH,
		"appVersion":   version,
		"capabilities": nodeCapabilities,
	}
}

// Register upserts this node in the daemon's mesh registry.
func (n *Node) Register(ctx context.Context) error {
	err := n.postJSON(ctx, "/devices/register", n.registrationBody(), nil)
	if err == nil {
		n.maybeAdoptFingerprint()
	}
	return err
}

// resultBody is the POST /devices/command-result payload. Its own function
// so the protocol conformance test can assert the wire shape against the
// shared fixture (protocol/fixtures/mesh_v1.json).
func resultBody(deviceID string, r commandResult) map[string]any {
	return map[string]any{
		"commandId": r.CommandID,
		"deviceId":  deviceID,
		"ok":        r.OK,
		"message":   r.Message,
		"data":      r.Data,
	}
}

// PostCommandResult answers one device_command by correlation id. Every
// command path must end here — success, failure, or unsupported — or the
// daemon-side tool call hangs until its timeout.
func (n *Node) PostCommandResult(ctx context.Context, r commandResult) error {
	return n.postJSON(ctx, "/devices/command-result", resultBody(n.DeviceID, r), nil)
}

// Run is the forever loop: register, heartbeat, and consume the SSE stream,
// reconnecting with capped exponential backoff until ctx is done.
func (n *Node) Run(ctx context.Context) {
	// Heartbeat runs independently of the event stream: registration is how
	// presence works, and it must survive SSE reconnect churn.
	go n.heartbeatLoop(ctx)
	// SIGHUP (unix) restarts into the on-disk binary — a reload after the
	// binary is replaced out of band. No-op on Windows.
	go watchReload(ctx, n)

	backoff := time.Second
	for ctx.Err() == nil {
		err := n.consumeEvents(ctx)
		if ctx.Err() != nil {
			return
		}
		log.Printf("event stream dropped (%v) — reconnecting in %s", err, backoff)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (n *Node) heartbeatLoop(ctx context.Context) {
	// Immediate first beat so the node shows up without waiting a minute.
	for {
		beatCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		if err := n.Register(beatCtx); err != nil {
			log.Printf("register failed: %v", err)
		}
		cancel()
		select {
		case <-time.After(heartbeatInterval):
		case <-ctx.Done():
			return
		}
	}
}

// consumeEvents opens GET /events and dispatches device_command frames
// addressed to this device. Blocks until the stream errors or ctx is done.
// Each frame is `data: <json>\n\n` (standard SSE, no event names).
func (n *Node) consumeEvents(ctx context.Context) error {
	req, err := http.NewRequestWithContext(
		ctx, http.MethodGet, n.apiURL("/events", nil), nil,
	)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	res, err := n.client.Do(n.authed(req))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("events: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	log.Printf("event stream connected")

	// Re-register on every (re)connect: if the daemon restarted, its registry
	// reloaded from disk but this device may have flipped offline meanwhile.
	go func() {
		regCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		if err := n.Register(regCtx); err != nil {
			log.Printf("post-connect register failed: %v", err)
		}
	}()

	scanner := bufio.NewScanner(res.Body)
	// Command payloads (write_file base64 chunks) can approach ~400KB of
	// JSON; give the scanner room well beyond that.
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		event, ok := decodeCommandFrame(scanner.Text(), n.DeviceID)
		if !ok {
			continue
		}
		// Commands run concurrently on purpose: a long exec must not block a
		// status probe, and the daemon correlates results by id, not order.
		go n.handleCommand(ctx, event)
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return errors.New("stream closed")
}

func (n *Node) handleCommand(ctx context.Context, event map[string]any) {
	id, _ := event["id"].(string)
	if id == "" {
		return
	}
	name, _ := event["name"].(string)
	params, _ := event["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}
	log.Printf("command %q (%s)", name, id)
	result := dispatch(ctx, n, name, params)
	result.CommandID = id
	postCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := n.PostCommandResult(postCtx, result); err != nil {
		log.Printf("could not answer command %q (%s): %v", name, id, err)
	}
	// A successful update_node swapped the on-disk binary; now that the ack
	// has been delivered, restart into it. Under systemd/launchd this is an
	// in-place execve (same pid, no exit → the supervisor sees no crash);
	// the daemon confirms via get_device_status once appVersion changes.
	if n.pendingReexec.Load() {
		reexecInto(n)
	}
}

// decodeCommandFrame parses one SSE line into a device_command event
// addressed to deviceID. Everything else — blank separators, comments,
// keepalives, malformed JSON (not for us to crash on), other event kinds,
// commands for other devices — returns false and is skipped.
func decodeCommandFrame(line, deviceID string) (map[string]any, bool) {
	if !strings.HasPrefix(line, "data: ") {
		return nil, false
	}
	var event map[string]any
	if err := json.Unmarshal([]byte(line[len("data: "):]), &event); err != nil {
		return nil, false
	}
	if event["kind"] != "device_command" {
		return nil, false
	}
	if id, _ := event["deviceId"].(string); id != deviceID {
		return nil, false
	}
	return event, true
}

// meshPlatform maps the Go runtime OS onto the mesh's DevicePlatform enum.
func meshPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		// linux and any other unix all register as linux — the closest enum
		// member the daemon validates against.
		return "linux"
	}
}
