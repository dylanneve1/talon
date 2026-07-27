/**
 * Outbound secret-scanning guard.
 *
 * The load-bearing assertions here are the NEGATIVE ones: that a DM is
 * untouched, that a non-messaging action is untouched, and that ordinary
 * prose containing hashes and base64 does not trip the patterns. A guard
 * that blocks secrets is easy; a guard that blocks secrets without
 * becoming annoying enough to switch off is the actual requirement.
 */

import { describe, expect, it, vi } from "vitest";
import {
  collectStrings,
  isGroupChat,
  scanOutboundAction,
  scanText,
  secretScanErrorMessage,
  TEXT_BEARING_ACTIONS,
} from "../core/tools/secret-scan.js";
import { createBridge } from "../core/tools/bridge.js";

const GROUP = "-1001426819337";
const DM = "352042062";
const PI_PASSWORD = "hunter2-raspberry-pi";

describe("isGroupChat", () => {
  it("treats negative Telegram ids as groups", () => {
    expect(isGroupChat(GROUP)).toBe(true);
    expect(isGroupChat("-100")).toBe(true);
  });

  it("treats positive ids and non-numeric ids as not-a-group", () => {
    expect(isGroupChat(DM)).toBe(false);
    expect(isGroupChat("0")).toBe(false);
    expect(isGroupChat("")).toBe(false);
    expect(isGroupChat("heartbeat")).toBe(false);
    // Not "-" followed by digits: must not be coerced by Number().
    expect(isGroupChat("-12ab")).toBe(false);
  });
});

describe("scanText — known values", () => {
  it("matches a configured credential appearing anywhere in the text", () => {
    const findings = scanText(`the password is ${PI_PASSWORD} btw`, {
      knownSecrets: [PI_PASSWORD],
    });
    expect(findings.map((f) => f.rule)).toEqual(["known-secret-value"]);
  });

  it("ignores known values shorter than the minimum length", () => {
    expect(scanText("the pin is 1234", { knownSecrets: ["1234"] })).toEqual([]);
  });

  it("honours the allowlist", () => {
    const findings = scanText(`value ${PI_PASSWORD}`, {
      knownSecrets: [PI_PASSWORD],
      allowlist: [PI_PASSWORD],
    });
    expect(findings).toEqual([]);
  });
});

describe("scanText — patterns", () => {
  const cases: Array<[string, string]> = [
    ["private-key-block", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc"],
    ["anthropic-api-key", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"],
    // NB: these two are assembled at runtime rather than written as
    // literals. They are fake, but they have the exact shape real ones
    // do, so a literal here trips the repo's own gitleaks job in CI —
    // which is the correct behaviour from gitleaks and a poor reason to
    // weaken .gitleaks.toml. The interpolated form matches the style
    // already used by the google/telegram cases below.
    ["github-token", `ghp_${"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"}`],
    ["slack-token", `xoxb-${"123456789012"}-${"abcdefghijkl"}`],
    ["aws-access-key-id", "AKIAIOSFODNN7EXAMPLE"],
    ["google-api-key", `AIza${"a".repeat(35)}`],
    ["telegram-bot-token", `123456789:AA${"x".repeat(32)}`],
  ];

  for (const [rule, sample] of cases) {
    it(`detects ${rule}`, () => {
      expect(scanText(`here: ${sample}`).map((f) => f.rule)).toContain(rule);
    });
  }

  it("does not fire on ordinary technical prose", () => {
    const prose = [
      "the commit is 3fd5cfc0a1b2c3d4e5f60718293a4b5c6d7e8f90 on main",
      "base64 of the png is iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "run `gh pr view 669` and check reviewDecision",
      "PR #669 adds a chatFreeActions set to gateway.ts",
    ].join("\n");
    expect(scanText(prose)).toEqual([]);
  });

  it("reports each rule at most once", () => {
    const text =
      "ghp_AAAAAAAAAAAAAAAAAAAAAAAA and ghp_BBBBBBBBBBBBBBBBBBBBBBBB";
    expect(scanText(text)).toHaveLength(1);
  });
});

describe("collectStrings", () => {
  it("reaches strings nested in arrays and objects", () => {
    const params = {
      text: "hello",
      rows: [[{ text: "button", url: "https://example.com" }]],
      count: 3,
      nothing: null,
    };
    expect(collectStrings(params).sort()).toEqual([
      "button",
      "hello",
      "https://example.com",
    ]);
  });
});

describe("scanOutboundAction — scoping", () => {
  const opts = { knownSecrets: [PI_PASSWORD] };

  it("blocks a group-bound message carrying a known secret", () => {
    const findings = scanOutboundAction(
      "send_message",
      { text: `ssh in with ${PI_PASSWORD}` },
      GROUP,
      opts,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("known-secret-value");
  });

  // The whole point of the design: Dylan reads his own credentials in his
  // own DM. If this ever fails, the guard becomes a nuisance and gets
  // turned off, which is worse than not having it.
  it("leaves DM-bound messages completely alone", () => {
    expect(
      scanOutboundAction(
        "send_message",
        { text: `ssh in with ${PI_PASSWORD}` },
        DM,
        opts,
      ),
    ).toEqual([]);
  });

  it("ignores actions that carry no model-authored text", () => {
    expect(
      scanOutboundAction(
        "native_bash",
        { command: `sshpass -p ${PI_PASSWORD} ssh pi@box` },
        GROUP,
        opts,
      ),
    ).toEqual([]);
  });

  it("scans button labels and captions, not just the text field", () => {
    expect(
      scanOutboundAction(
        "send_photo",
        { file_path: "/tmp/x.png", caption: `key: ${PI_PASSWORD}` },
        GROUP,
        opts,
      ),
    ).toHaveLength(1);
    expect(
      scanOutboundAction(
        "send_message_with_buttons",
        { text: "ok", rows: [[{ text: `ghp_${"C".repeat(24)}` }]] },
        GROUP,
      ),
    ).toHaveLength(1);
  });

  it("covers every messaging action the tools actually call", () => {
    for (const action of ["send_message", "edit_message", "schedule_message"]) {
      expect(TEXT_BEARING_ACTIONS.has(action)).toBe(true);
    }
  });
});

describe("secretScanErrorMessage", () => {
  it("names the rule but never the value", () => {
    const message = secretScanErrorMessage("send_message", [
      {
        rule: "known-secret-value",
        hint: "a credential configured on this host",
      },
    ]);
    expect(message).toContain("known-secret-value");
    expect(message).toContain("blocked by outbound secret scanning");
    expect(message).not.toContain(PI_PASSWORD);
  });
});

describe("createBridge integration", () => {
  function stubFetch() {
    const calls: string[] = [];
    const fake = vi.fn(async (_url: string, init: { body: string }) => {
      calls.push(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ ok: true }),
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fake;
    return calls;
  }

  it("throws instead of sending when a group message carries a secret", async () => {
    const calls = stubFetch();
    const bridge = createBridge("http://127.0.0.1:19876", GROUP, {
      knownSecrets: [PI_PASSWORD],
    });
    await expect(
      bridge("send_message", { text: `pass: ${PI_PASSWORD}` }),
    ).rejects.toThrow(/outbound secret scanning/);
    // Nothing left the process.
    expect(calls).toHaveLength(0);
  });

  it("sends the same message unchanged in a DM", async () => {
    const calls = stubFetch();
    const bridge = createBridge("http://127.0.0.1:19876", DM, {
      knownSecrets: [PI_PASSWORD],
    });
    await bridge("send_message", { text: `pass: ${PI_PASSWORD}` });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(PI_PASSWORD);
  });

  it("can be disabled explicitly", async () => {
    const calls = stubFetch();
    const bridge = createBridge("http://127.0.0.1:19876", GROUP, {
      enabled: false,
      knownSecrets: [PI_PASSWORD],
    });
    await bridge("send_message", { text: `pass: ${PI_PASSWORD}` });
    expect(calls).toHaveLength(1);
  });

  it("honours an explicit chat_id override when deciding group-ness", async () => {
    const calls = stubFetch();
    // Bridge bound to a DM, but the model routes explicitly to a group.
    const bridge = createBridge("http://127.0.0.1:19876", DM, {
      knownSecrets: [PI_PASSWORD],
    });
    await expect(
      bridge("send_message", { chat_id: GROUP, text: `pass: ${PI_PASSWORD}` }),
    ).rejects.toThrow(/outbound secret scanning/);
    expect(calls).toHaveLength(0);
  });
});
