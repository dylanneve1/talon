/**
 * Tests for the notes system (save_note, get_note, list_notes, delete_note, search_notes)
 * Uses a temporary directory to avoid polluting production notes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const sendUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(42));
const getClientMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ invoke: vi.fn().mockResolvedValue({}) }),
);
const statSyncMock = vi.hoisted(() => vi.fn().mockReturnValue({ size: 100 }));

vi.mock("../frontend/telegram/userbot.js", () => ({
  isUserClientReady: vi.fn().mockReturnValue(true),
  sendUserbotMessage: sendUserbotMessageMock,
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
  return { handle, call, mockGateway, recordOurMessage };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Notes system (save_note / get_note / list_notes / delete_note / search_notes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Create a temp directory and redirect HOME so notes go there
    tmpDir = mkdtempSync(resolve(tmpdir(), "talon-test-notes-"));
    mkdirSync(resolve(tmpDir, ".talon/workspace/notes"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save_note creates a JSON file in the notes directory", async () => {
    const { call } = makeHandler();
    const result = await call("save_note", {
      key: "test_note",
      content: "Hello, notes!",
      tags: ["test", "hello"],
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.key).toBe("test_note");

    // Verify the file was written
    const { readFileSync } = await import("node:fs");
    const notePath = resolve(tmpDir, ".talon/workspace/notes/test_note.json");
    const saved = JSON.parse(readFileSync(notePath, "utf8"));
    expect(saved.content).toBe("Hello, notes!");
    expect(saved.tags).toEqual(["test", "hello"]);
    expect(saved.key).toBe("test_note");
  });

  it("save_note sanitises key (replaces special chars with _)", async () => {
    const { call } = makeHandler();
    const result = await call("save_note", {
      key: "my note!",
      content: "sanitised",
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.key).toBe("my_note_"); // space and ! become _
  });

  it("get_note retrieves a previously saved note", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "my_key", content: "my content", tags: ["t1"] });
    const result = await call("get_note", { key: "my_key" }) as any;
    expect(result.ok).toBe(true);
    expect(result.content).toBe("my content");
    expect(result.tags).toEqual(["t1"]);
  });

  it("get_note returns error for non-existent note", async () => {
    const { call } = makeHandler();
    const result = await call("get_note", { key: "does_not_exist" }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("list_notes returns all notes when no tag filter", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "note_a", content: "A", tags: ["alpha"] });
    await call("save_note", { key: "note_b", content: "B", tags: ["beta"] });
    const result = await call("list_notes") as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    const keys = result.notes.map((n: any) => n.key);
    expect(keys).toContain("note_a");
    expect(keys).toContain("note_b");
  });

  it("list_notes filters by tag correctly", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "work_note", content: "work content", tags: ["work"] });
    await call("save_note", { key: "personal_note", content: "personal content", tags: ["personal"] });
    const result = await call("list_notes", { tag: "work" }) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.notes[0].key).toBe("work_note");
  });

  it("list_notes returns empty list when dir is empty", async () => {
    const { call } = makeHandler();
    const result = await call("list_notes") as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it("delete_note removes the note file", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "to_delete", content: "bye" });
    const delResult = await call("delete_note", { key: "to_delete" }) as any;
    expect(delResult.ok).toBe(true);

    // Note should no longer exist
    const getResult = await call("get_note", { key: "to_delete" }) as any;
    expect(getResult.ok).toBe(false);
  });

  it("delete_note returns error for non-existent note", async () => {
    const { call } = makeHandler();
    const result = await call("delete_note", { key: "nonexistent" }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("search_notes finds notes by content keyword", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "science", content: "quantum physics is interesting" });
    await call("save_note", { key: "cooking", content: "pasta recipe here" });
    const result = await call("search_notes", { query: "quantum" }) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.notes[0].key).toBe("science");
  });

  it("search_notes finds notes by key", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "project_alpha", content: "some content" });
    await call("save_note", { key: "project_beta", content: "other content" });
    const result = await call("search_notes", { query: "alpha" }) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.notes[0].key).toBe("project_alpha");
  });

  it("search_notes finds notes by tag", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "tagged", content: "hi there", tags: ["urgent"] });
    await call("save_note", { key: "untagged", content: "just content" });
    const result = await call("search_notes", { query: "urgent" }) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.notes[0].key).toBe("tagged");
  });

  it("search_notes is case-insensitive", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "case_test", content: "Hello World from TALON" });
    const result = await call("search_notes", { query: "talon" }) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
  });

  it("search_notes returns empty when no matches", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "some_note", content: "some content" });
    const result = await call("search_notes", { query: "zyxwvutsrq" }) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it("save_note updates existing note by overwriting", async () => {
    const { call } = makeHandler();
    await call("save_note", { key: "updatable", content: "original content" });
    await call("save_note", { key: "updatable", content: "updated content" });
    const result = await call("get_note", { key: "updatable" }) as any;
    expect(result.ok).toBe(true);
    expect(result.content).toBe("updated content");
  });

  it("list_notes includes preview (first 120 chars of content)", async () => {
    const { call } = makeHandler();
    const longContent = "A".repeat(200);
    await call("save_note", { key: "long_note", content: longContent });
    const result = await call("list_notes") as any;
    expect(result.notes[0].preview).toHaveLength(120);
  });
});
