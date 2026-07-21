package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config is the node's persisted identity + connection settings. One JSON
// file, human-editable, secrets included — written 0600. Flags and env vars
// (TALON_BRIDGE / TALON_TOKEN / TALON_NODE_NAME) override the file; whatever
// wins is what runs, and TOFU fingerprint capture writes back to the file.
type Config struct {
	// Bridge is the base URL of the daemon's native bridge,
	// e.g. "https://100.64.0.1:19880".
	Bridge string `json:"bridge"`
	// Token is the bridge bearer token (same one companion apps pair with).
	Token string `json:"token"`
	// Name is the device name shown across the mesh. Defaults to hostname.
	Name string `json:"name,omitempty"`
	// DeviceID is the stable mesh identity, minted once on first run so a
	// restart (or re-deploy over the same config) never creates a ghost
	// duplicate in the registry.
	DeviceID string `json:"deviceId,omitempty"`
	// Fingerprint pins the bridge TLS certificate (lowercase hex SHA-256 of
	// the DER, exactly as /health reports it). Empty = trust-on-first-use:
	// the first successful connect records it, later connects require it.
	Fingerprint string `json:"fingerprint,omitempty"`

	// Path the config was loaded from (not serialized).
	Path string `json:"-"`
}

func defaultConfigPath() string {
	if runtime.GOOS == "windows" {
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "talon-node", "config.json")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "talon-node.json"
	}
	return filepath.Join(home, ".talon-node", "config.json")
}

// mustLoadConfig merges file < env < flags, fills identity defaults
// (hostname name, minted device id), persists anything newly minted, and
// exits with a usage error on unparseable flags.
func mustLoadConfig(args []string) *Config {
	fs := flag.NewFlagSet("talon-node", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath(), "config file path")
	bridge := fs.String("bridge", "", "bridge base URL")
	token := fs.String("token", "", "bridge bearer token")
	name := fs.String("name", "", "device name")
	fingerprint := fs.String("fingerprint", "", "pinned bridge cert SHA-256")
	_ = fs.Parse(args)

	cfg := &Config{Path: *configPath}
	if raw, err := os.ReadFile(*configPath); err == nil {
		if err := json.Unmarshal(raw, cfg); err != nil {
			log.Fatalf("config %s: invalid JSON: %v", *configPath, err)
		}
		cfg.Path = *configPath
	}
	if v := os.Getenv("TALON_BRIDGE"); v != "" {
		cfg.Bridge = v
	}
	if v := os.Getenv("TALON_TOKEN"); v != "" {
		cfg.Token = v
	}
	if v := os.Getenv("TALON_NODE_NAME"); v != "" {
		cfg.Name = v
	}
	if *bridge != "" {
		cfg.Bridge = *bridge
	}
	if *token != "" {
		cfg.Token = *token
	}
	if *name != "" {
		cfg.Name = *name
	}
	if *fingerprint != "" {
		cfg.Fingerprint = normalizeFingerprint(*fingerprint)
	}

	cfg.Bridge = strings.TrimRight(strings.TrimSpace(cfg.Bridge), "/")
	dirty := false
	if cfg.Name == "" {
		host, err := os.Hostname()
		if err != nil || host == "" {
			host = "talon-node"
		}
		cfg.Name = host
		dirty = true
	}
	if cfg.DeviceID == "" {
		cfg.DeviceID = "node-" + randomHex(16)
		dirty = true
	}
	if dirty {
		if err := cfg.Save(); err != nil {
			// Identity should persist, but a read-only FS must not stop the
			// node from serving — it just re-mints an id next boot.
			log.Printf("warning: could not persist config: %v", err)
		}
	}
	return cfg
}

// Validate checks the fields `run` cannot proceed without.
func (c *Config) Validate() error {
	if c.Bridge == "" {
		return errors.New(
			"no bridge URL — pass --bridge or set \"bridge\" in the config",
		)
	}
	u, err := url.Parse(c.Bridge)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("invalid bridge URL %q", c.Bridge)
	}
	if c.Token == "" {
		return errors.New(
			"no bearer token — pass --token or set \"token\" in the config",
		)
	}
	return nil
}

// Save writes the config file 0600 (it holds the bearer token), creating
// the parent directory as needed.
func (c *Config) Save() error {
	if c.Path == "" {
		c.Path = defaultConfigPath()
	}
	if err := os.MkdirAll(filepath.Dir(c.Path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(c.Path, append(raw, '\n'), 0o600)
}

// normalizeFingerprint accepts "AA:BB:…", uppercase, or plain hex and
// returns the canonical lowercase no-separator form the bridge reports.
func normalizeFingerprint(v string) string {
	return strings.ToLower(strings.NewReplacer(":", "", " ", "").Replace(v))
}

func randomHex(bytes int) string {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failing is effectively unrecoverable; panic beats a
		// predictable identity.
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return hex.EncodeToString(buf)
}
