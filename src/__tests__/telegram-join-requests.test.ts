import { describe, it, expect, beforeEach } from "vitest";
import {
  recordJoinRequest,
  clearJoinRequest,
  listJoinRequests,
  resetJoinRequests,
} from "../frontend/telegram/join-requests.js";

const req = (userId: number, name = `user${userId}`) => ({
  userId,
  name,
  at: 1000 + userId,
});

beforeEach(() => resetJoinRequests());

describe("join-request store", () => {
  it("keeps requests per chat and re-requesting overwrites", () => {
    recordJoinRequest(1, req(10));
    recordJoinRequest(1, { ...req(10), name: "renamed" });
    recordJoinRequest(2, req(20));
    expect(listJoinRequests(1)).toHaveLength(1);
    expect(listJoinRequests(1)[0].name).toBe("renamed");
    expect(listJoinRequests(2)).toHaveLength(1);
  });

  it("clears on approve/decline", () => {
    recordJoinRequest(1, req(10));
    clearJoinRequest(1, 10);
    expect(listJoinRequests(1)).toEqual([]);
    // Clearing an unknown user is a no-op, not an error.
    clearJoinRequest(1, 999);
    clearJoinRequest(42, 10);
  });

  it("stays bounded by evicting the oldest entry", () => {
    for (let i = 0; i < 201; i++) recordJoinRequest(1, req(i));
    const pending = listJoinRequests(1);
    expect(pending).toHaveLength(200);
    expect(pending.some((r) => r.userId === 0)).toBe(false);
    expect(pending.some((r) => r.userId === 200)).toBe(true);
  });
});
