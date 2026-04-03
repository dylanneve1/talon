/**
 * Tests for keyword watch actions (watch_keyword, unwatch_keyword, list_watches)
 * and the loadWatches cache in userbot-frontend.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const getClientMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ invoke: vi.fn().mockResolvedValue({}) }),
);
const statSyncMock = vi.hoisted(() => vi.fn().mockReturnValue({ size: 100 }));

vi.mock("../frontend/telegram/userbot.js", () => ({
  isUserClientReady: vi.fn().mockReturnValue(true),
  sendUserbotMessage: vi.fn().mockResolvedValue(42),
  sendUserbotTyping: vi.fn().mockResolvedValue(undefined),
  editUserbotMessage: vi.fn().mockResolvedValue(undefined),
  deleteUserbotMessage: vi.fn().mockResolvedValue(undefined),
  reactUserbotMessage: vi.fn().mockResolvedValue(undefined),
  clearUserbotReactions: vi.fn().mockResolvedValue(undefined),
  pinUserbotMessage: vi.fn().mockResolvedValue(undefined),
  unpinUserbotMessage: vi.fn().mockResolvedValue(undefined),
  forwardUserbotMessage: vi.fn().mockResolvedValue(77),
  sendUserbotFile: vi.fn().mockResolvedValue(42),
  getUserbotEntity: vi.fn().mockResolvedValue({ id: 123n }),
  getUserbotAdmins: vi.fn().mockResolvedValue([]),
  getUserbotMemberCount: vi.fn().mockResolvedValue(5),
  searchMessages: vi.fn().mockResolvedValue("search results"),
  getHistory: vi.fn().mockResolvedValue("history text"),
  getParticipantDetails: vi.fn().mockResolvedValue([]),
  getUserInfo: vi.fn().mockResolvedValue(null),
  getMessage: vi.fn().mockResolvedValue(null),
  getPinnedMessages: vi.fn().mockResolvedValue([]),
  getOnlineCount: vi.fn().mockResolvedValue(0),
  downloadMessageMedia: vi.fn().mockResolvedValue("/tmp/file.jpg"),
  getClient: getClientMock,
}));

vi.mock("../core/gateway.js", () => ({
  withRetry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: statSyncMock,
  };
});

const { createUserbotActionHandler } = await import(
  "../frontend/telegram/userbot-actions.js"
);

// ── Test setup ────────────────────────────────────────────────────────────────

const CHAT_ID = 123456;
let tmpDir: string;
let originalHome: string | undefined;

function makeHandler() {
  const recordOurMessage = vi.fn();
  const mockGateway: any = {
    incrementMessages: vi.fn(),
    getPort: vi.fn().mockReturnValue(19876),
  };
  const handle = createUserbotActionHandler(mockGateway, recordOurMessage);
  const call = (action: string, extra: Record<string, unknown> = {}) =>
    handle({ action, ...extra }, CHAT_ID);
  return { call };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Keyword watches (watch_keyword / unwatch_keyword / list_watches)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(resolve(tmpdir(), "talon-test-watches-"));
    mkdirSync(resolve(tmpDir, ".talon/workspace"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("watch_keyword adds a watch and returns ok with total_watches", async () => {
    const { call } = makeHandler();
    const result = await call("watch_keyword", { keyword: "urgent" }) as any;
    expect(result.ok).toBe(true);
    expect(result.keyword).toBe("urgent");
    expect(result.total_watches).toBe(1);
    expect(result.chat_id).toBeUndefined();
  });

  it("watch_keyword with chat_id restricts to that chat", async () => {
    const { call } = makeHandler();
    const result = await call("watch_keyword", {
      keyword: "bug",
      chat_id: -1001234567890,
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.chat_id).toBe(-1001234567890);
  });

  it("watch_keyword deduplicates same keyword+chatId combo", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "hello" });
    await call("watch_keyword", { keyword: "hello" }); // same keyword, global
    const listResult = await call("list_watches") as any;
    expect(listResult.count).toBe(1); // should not have duplicates
  });

  it("watch_keyword does NOT deduplicate different chatIds for same keyword", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "hello" }); // global
    await call("watch_keyword", { keyword: "hello", chat_id: 123 }); // chat-specific
    const listResult = await call("list_watches") as any;
    expect(listResult.count).toBe(2); // different scope = different watch
  });

  it("watch_keyword is case-insensitive for deduplication", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "Hello" });
    await call("watch_keyword", { keyword: "hello" }); // same keyword, different case
    const listResult = await call("list_watches") as any;
    expect(listResult.count).toBe(1);
  });

  it("unwatch_keyword removes the watch", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "to_remove" });
    const removeResult = await call("unwatch_keyword", { keyword: "to_remove" }) as any;
    expect(removeResult.ok).toBe(true);
    expect(removeResult.removed).toBe(1);
    expect(removeResult.remaining).toBe(0);
    const listResult = await call("list_watches") as any;
    expect(listResult.count).toBe(0);
  });

  it("unwatch_keyword is case-insensitive", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "IMPORTANT" });
    const result = await call("unwatch_keyword", { keyword: "important" }) as any;
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(1);
  });

  it("unwatch_keyword returns error when no watches configured", async () => {
    const { call } = makeHandler();
    // No watches file yet
    const result = await call("unwatch_keyword", { keyword: "anything" }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No watches/i);
  });

  it("unwatch_keyword reports removed:0 when keyword not found", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "existing" });
    const result = await call("unwatch_keyword", { keyword: "nonexistent" }) as any;
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("list_watches returns empty array when no file exists", async () => {
    const { call } = makeHandler();
    const result = await call("list_watches") as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.watches).toEqual([]);
  });

  it("list_watches returns all watches", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "alpha" });
    await call("watch_keyword", { keyword: "beta" });
    await call("watch_keyword", { keyword: "gamma", chat_id: 111 });
    const result = await call("list_watches") as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    const keywords = result.watches.map((w: any) => w.keyword);
    expect(keywords).toContain("alpha");
    expect(keywords).toContain("beta");
    expect(keywords).toContain("gamma");
  });

  it("watch entries include createdAt timestamp", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "timestamped" });
    const result = await call("list_watches") as any;
    const watch = result.watches.find((w: any) => w.keyword === "timestamped");
    expect(watch).toBeDefined();
    expect(watch.createdAt).toBeTruthy();
    // Should be a valid ISO date string
    expect(() => new Date(watch.createdAt)).not.toThrow();
  });

  it("watch_keyword returns error when keyword is empty", async () => {
    const { call } = makeHandler();
    const result = await call("watch_keyword", { keyword: "" }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/keyword/);
  });

  it("multiple watches survive multiple add/remove cycles", async () => {
    const { call } = makeHandler();
    await call("watch_keyword", { keyword: "a" });
    await call("watch_keyword", { keyword: "b" });
    await call("watch_keyword", { keyword: "c" });
    await call("unwatch_keyword", { keyword: "b" });
    const result = await call("list_watches") as any;
    expect(result.count).toBe(2);
    const keywords = result.watches.map((w: any) => w.keyword);
    expect(keywords).toContain("a");
    expect(keywords).toContain("c");
    expect(keywords).not.toContain("b");
  });
});
