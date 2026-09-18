/**
 * Remote-server profile pins.
 *
 * The Kilo and OpenCode drivers used to be sixteen files under
 * `backend/kilo/` and `backend/opencode/`; they are now two profile
 * objects bound through `remote-server/profiles/bind.ts`. Nothing the
 * user or the provider sees may have moved in that translation, so this
 * file pins the values that would be silent if they changed:
 *
 *   1. **The delivery-contract suffix.** It is appended to the END of
 *      the static system prompt, which is the prompt-cache prefix — one
 *      different byte re-bills every live chat on the next turn. The
 *      digests below were captured from `origin/main` before the
 *      refactor (`sha256(suffix).slice(0, 16)`).
 *   2. **The model-picker knobs.** A wrong `maxCallbackIdLength` or
 *      `quickPickLimit` silently drops models from a settings menu.
 *   3. **The loopback ports and stored-model parsers**, which decide
 *      which server a turn talks to and which model it asks for.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildDeliveryContract } from "../backend/runtime/prompt/delivery-contract.js";
import { kiloProfile } from "../backend/remote-server/profiles/kilo.js";
import { opencodeProfile } from "../backend/remote-server/profiles/opencode.js";

// The suffix is rendered from prompt templates read off disk. A Windows
// checkout (core.autocrlf) hands them over with CRLF line endings, so the
// digests — recorded from the LF sources — are taken over LF-normalised
// text; the identity being pinned is the template content, not the
// platform's newline convention.
const digest = (s: string): string =>
  createHash("sha256")
    .update(s.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex")
    .slice(0, 16);

/** Every frontend with its own delivery tool names, plus the fallbacks. */
const FRONTENDS = [
  "telegram",
  "discord",
  "teams",
  "native",
  "whatsapp",
  "terminal",
  "unknown-frontend",
] as const;

/** Captured from origin/main, before kilo/ and opencode/ were deleted. */
const SUFFIX_DIGESTS: Record<string, Record<string, string>> = {
  kilo: {
    telegram: "c2476f1e96152904",
    discord: "c2476f1e96152904",
    teams: "04669a55911a1f42",
    native: "041ca995bc0cf213",
    whatsapp: "04669a55911a1f42",
    terminal: "c2476f1e96152904",
    "unknown-frontend": "c2476f1e96152904",
  },
  opencode: {
    telegram: "5570be87ba36ea5b",
    discord: "5570be87ba36ea5b",
    teams: "be1ea073afd343cd",
    native: "be1ea073afd343cd",
    whatsapp: "be1ea073afd343cd",
    terminal: "5570be87ba36ea5b",
    "unknown-frontend": "5570be87ba36ea5b",
  },
};

const PROFILES = [kiloProfile, opencodeProfile] as const;

describe("remote-server profiles — prompt-cache byte identity", () => {
  for (const profile of PROFILES) {
    it(`${profile.id} renders the pre-refactor suffix for every frontend`, () => {
      for (const frontend of FRONTENDS) {
        expect(
          digest(profile.systemPromptSuffix(frontend)),
          `${profile.id}/${frontend} delivery-contract suffix changed`,
        ).toBe(SUFFIX_DIGESTS[profile.id][frontend]);
      }
    });

    it(`${profile.id} one-shot suffix is the telegram-shaped one`, () => {
      // Heartbeat and dream are cross-surface, so they carry the default.
      expect(profile.defaultSystemPromptSuffix).toBe(
        profile.systemPromptSuffix("telegram"),
      );
    });

    it(`${profile.id} suffix is the shared contract wrapped in blank lines`, () => {
      expect(profile.systemPromptSuffix("discord")).toBe(
        `\n\n${buildDeliveryContract(profile.definition.deliveryContract, "discord")}\n`,
      );
    });
  }

  it("the two backends carry different contracts", () => {
    expect(kiloProfile.definition.deliveryContract).toBe("text-or-tools");
    expect(opencodeProfile.definition.deliveryContract).toBe("text-preferred");
    expect(kiloProfile.systemPromptSuffix("telegram")).not.toBe(
      opencodeProfile.systemPromptSuffix("telegram"),
    );
  });
});

describe("remote-server profiles — registry and picker knobs", () => {
  it("kilo keeps its Discord-sized picker budget and port", () => {
    expect(kiloProfile.id).toBe("kilo");
    expect(kiloProfile.label).toBe("Kilo");
    expect(kiloProfile.sdkPackage).toBe("@kilocode/sdk");
    expect(kiloProfile.baseUrl).toBe("http://127.0.0.1:4097");
    expect(kiloProfile.definition.maxCallbackIdLength).toBe(90);
    expect(kiloProfile.definition.allowCallbackSeparators).toBe(true);
    expect(kiloProfile.definition.quickPickLimit).toBe(24);
  });

  it("opencode keeps its Telegram-sized picker budget and port", () => {
    expect(opencodeProfile.id).toBe("opencode");
    expect(opencodeProfile.label).toBe("OpenCode");
    expect(opencodeProfile.sdkPackage).toBe("@opencode-ai/sdk");
    expect(opencodeProfile.baseUrl).toBe("http://127.0.0.1:4096");
    expect(opencodeProfile.definition.maxCallbackIdLength).toBe(48);
    expect(opencodeProfile.definition.allowCallbackSeparators).toBe(false);
    expect(opencodeProfile.definition.quickPickLimit).toBe(4);
  });
});

describe("remote-server profiles — stored model parsing", () => {
  // The one genuine behavioural difference between the two drivers: the
  // Kilo router rejects the `kilo/` hint Talon used to store, while
  // OpenCode's router wants a fuzzy `provider/model` split.
  it("kilo strips the kilo/ hint and pins the provider", () => {
    expect(
      kiloProfile.parseModelSelection(" kilo/deepseek/deepseek-v4-flash:free "),
    ).toEqual({
      providerID: "kilo",
      modelID: "deepseek/deepseek-v4-flash:free",
    });
  });

  it("kilo keeps any other vendor-prefixed id whole", () => {
    expect(
      kiloProfile.parseModelSelection("  openrouter/qwen3-235b-a22b:free  "),
    ).toEqual({
      providerID: undefined,
      modelID: "openrouter/qwen3-235b-a22b:free",
    });
  });

  it("opencode splits the provider off the front", () => {
    expect(opencodeProfile.parseModelSelection("OpenAI/gpt-5")).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
  });
});
