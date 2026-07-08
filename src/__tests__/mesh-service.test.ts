/**
 * Core mesh service — the daemon-wide device mesh the model reaches from
 * every frontend:
 *   - tool composition: mesh tools are NOT frontend-restricted
 *   - shared gateway actions: list_devices / get_device_location resolve
 *     without any frontend handler
 *   - locate flow: dispatcher fan-out, fresh-fix wait, last-known fallback,
 *     and the no-transport fast path
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MeshRegistry,
  MeshService,
  getMeshService,
  setMeshService,
} from "../core/mesh/index.js";
import { meshHandlers } from "../core/engine/gateway-actions/mesh.js";
import { composeTools } from "../core/tools/index.js";

async function tempService(
  options?: ConstructorParameters<typeof MeshService>[1],
): Promise<MeshService> {
  const dir = await mkdtemp(join(tmpdir(), "talon-mesh-service-"));
  const registry = new MeshRegistry({
    devices: join(dir, "devices.json"),
    locations: join(dir, "locations.json"),
    history: join(dir, "history.json"),
  });
  return new MeshService(registry, options);
}

async function registerPhone(service: MeshService): Promise<void> {
  await service.register({
    id: "phone",
    name: "Pixel 9",
    platform: "android",
    appVersion: "1.0.0",
    battery: 77,
  });
}

afterEach(() => setMeshService(null));

describe("mesh tool availability", () => {
  it.each(["telegram", "discord", "teams", "terminal", "native"] as const)(
    "exposes every mesh tool on the %s frontend",
    (frontend) => {
      const names = composeTools({ frontend }).map((t) => t.name);
      for (const tool of [
        "list_devices",
        "get_device_location",
        "get_device_history",
        "ring_device",
        "get_device_status",
      ]) {
        expect(names).toContain(tool);
      }
    },
  );
});

describe("mesh shared gateway actions", () => {
  it("serves list_devices and get_device_location through the shared registry", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 50,
      pollIntervalMs: 10,
    });
    setMeshService(service);
    await registerPhone(service);
    await service.storeLocation({
      deviceId: "phone",
      lat: 53.1,
      lon: -6.2,
      ts: Date.now(),
    });

    const list = await meshHandlers.list_devices({ action: "list_devices" }, 1);
    expect(list.ok).toBe(true);
    expect(list.text).toContain("Pixel 9");
    expect(list.text).toContain("[id: phone]");
    expect(list.text).toContain("53.100000,-6.200000");

    const loc = await meshHandlers.get_device_location(
      { action: "get_device_location", device: "pixel" },
      1,
    );
    expect(loc.ok).toBe(true);
    expect(loc.text).toContain("Pixel 9 is at 53.100000, -6.200000");
  });

  it("getMeshService returns a stable singleton until reset", () => {
    const a = getMeshService();
    expect(getMeshService()).toBe(a);
    setMeshService(null);
    expect(getMeshService()).not.toBe(a);
  });
});

describe("MeshService locate flow", () => {
  it("answers from last-known immediately when no transport is attached", async () => {
    const service = await tempService({ freshFixTimeoutMs: 5_000 });
    await registerPhone(service);
    await service.storeLocation({
      deviceId: "phone",
      lat: 1,
      lon: 2,
      ts: Date.now() - 60_000,
    });

    const started = Date.now();
    const result = await service.locateDevice();
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Pixel 9 is at 1.000000, 2.000000");
    // No dispatcher — must not wait out the 5s fresh-fix window.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("dispatches a targeted locate and resolves on the fresh fix", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 2_000,
      pollIntervalMs: 25,
    });
    await registerPhone(service);
    const locates: Array<string | undefined> = [];
    service.registerTransport({
      locate: (deviceId) => {
        locates.push(deviceId);
        // Simulate the companion answering the locate with a fresh fix.
        void service.storeLocation({
          deviceId: "phone",
          lat: 53.5,
          lon: -6.5,
          ts: Date.now(),
        });
      },
      command: () => {},
    });

    const result = await service.locateDevice("phone");
    expect(locates).toEqual(["phone"]);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("53.500000, -6.500000");
  });

  it("falls back to last-known when no fresh fix arrives in time", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 60,
      pollIntervalMs: 20,
    });
    await registerPhone(service);
    await service.storeLocation({
      deviceId: "phone",
      lat: 9,
      lon: 8,
      ts: Date.now() - 120_000,
    });
    service.registerTransport({
      locate: () => {
        /* transport attached, but the device never answers */
      },
      command: () => {},
    });

    const result = await service.locateDevice("phone");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("9.000000, 8.000000");
  });

  it("survives a throwing dispatcher and honours unsubscribe", async () => {
    const service = await tempService({
      freshFixTimeoutMs: 40,
      pollIntervalMs: 10,
    });
    await registerPhone(service);
    const seen: Array<string | undefined> = [];
    service.registerTransport({
      locate: () => {
        throw new Error("broken transport");
      },
      command: () => {},
    });
    const unsubscribe = service.registerTransport({
      locate: (id) => seen.push(id),
      command: () => {},
    });

    expect(service.requestLocate("phone")).toBe(true);
    expect(seen).toEqual(["phone"]);

    unsubscribe(); // one dispatcher (the broken one) still attached
    expect(service.requestLocate("phone")).toBe(true);
    expect(seen).toEqual(["phone"]);
  });

  it("lists known devices when the query matches nothing, and reports the empty mesh", async () => {
    const service = await tempService({ freshFixTimeoutMs: 40 });
    const empty = await service.locateDevice("phone");
    expect(empty).toMatchObject({
      ok: false,
      text: "No mesh devices are registered.",
    });

    await registerPhone(service);
    const miss = await service.locateDevice("watch");
    expect(miss.ok).toBe(false);
    expect(miss.text).toContain('No mesh device matches "watch"');
    expect(miss.text).toContain("Pixel 9");
  });

  it("builds a movement + battery history from stored fixes", async () => {
    const service = await tempService();
    await registerPhone(service);
    const now = Date.now();
    // A morning of fixes: home -> across town, battery draining.
    const fixes = [
      { lat: 53.3, lon: -6.25, batteryPct: 90, ts: now - 3 * 3_600_000 },
      { lat: 53.31, lon: -6.24, batteryPct: 84, ts: now - 2 * 3_600_000 },
      { lat: 53.32, lon: -6.23, batteryPct: 79, ts: now - 1 * 3_600_000 },
      { lat: 53.33, lon: -6.22, batteryPct: 71, ts: now - 10 * 60_000 },
    ];
    for (const f of fixes) {
      await service.storeLocation({ deviceId: "phone", ...f });
    }

    const result = await service.deviceHistory("phone", 6);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("4 fixes in the last 6h");
    expect(result.text).toContain("battery 90% → 71%");
    expect(result.text).toMatch(/moved ~\d/);
    expect(result.text).toContain("53.33000,-6.22000");

    // Window filtering: only the recent fix lands in a 1h window.
    const short = await service.deviceHistory("phone", 1);
    expect(short.text).toContain("1 fix in the last 1h");

    // Empty window is a clean answer, not an error.
    const other = await service.register({
      id: "tab",
      name: "Tablet",
      platform: "android",
      appVersion: "1.0.0",
    });
    expect(other.id).toBe("tab");
    const empty = await service.deviceHistory("tablet", 24);
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("No location reports");

    // Shared action path + history survives a reload from disk.
    setMeshService(service);
    const viaAction = await meshHandlers.get_device_history(
      { action: "get_device_history", device: "phone", hours: 6 },
      1,
    );
    expect(viaAction.text).toContain("4 fixes");
  });

  it("prefers mobile devices as the default target", async () => {
    const service = await tempService();
    await service.register({
      id: "mac",
      name: "MacBook",
      platform: "macos",
      appVersion: "1.0.0",
    });
    await registerPhone(service);
    expect(service.chooseDevice()?.id).toBe("phone");
    expect(service.chooseDevice("mac")?.id).toBe("mac");
    expect(service.chooseDevice("macbook")?.id).toBe("mac");
  });

  it("dispatches a command and resolves on the device's answer", async () => {
    const service = await tempService({ commandTimeoutMs: 2_000 });
    await service.register({
      id: "phone",
      name: "Pixel 9",
      platform: "android",
      appVersion: "1.0.0",
      capabilities: ["locate", "ring", "status"],
    });
    const sent: Array<{ name: string; params: Record<string, unknown> }> = [];
    service.registerTransport({
      locate: () => {},
      command: (cmd) => {
        sent.push({ name: cmd.name, params: cmd.params });
        // Simulate the companion answering over POST /devices/command-result.
        queueMicrotask(() =>
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            ...(cmd.name === "status"
              ? { data: { battery: "77%", network: "wifi" } }
              : {}),
          }),
        );
      },
    });

    const ring = await service.ringDevice("phone", "where are you");
    expect(ring.ok).toBe(true);
    expect(ring.text).toContain("Pixel 9 is ringing");
    expect(sent[0]).toEqual({
      name: "ring",
      params: { message: "where are you" },
    });

    const status = await service.getDeviceStatus("phone");
    expect(status.ok).toBe(true);
    expect(status.text).toContain("battery: 77%");
    expect(status.text).toContain("network: wifi");
  });

  it("times out a command the device never answers", async () => {
    const service = await tempService({ commandTimeoutMs: 60 });
    await registerPhone(service);
    service.registerTransport({ locate: () => {}, command: () => {} });
    const result = await service.ringDevice("phone");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("did not answer");
  });

  it("refuses commands a device declares it cannot run", async () => {
    const service = await tempService({ commandTimeoutMs: 60 });
    await service.register({
      id: "mac",
      name: "MacBook",
      platform: "macos",
      appVersion: "1.0.0",
      capabilities: ["locate", "status"],
    });
    service.registerTransport({ locate: () => {}, command: () => {} });
    const result = await service.ringDevice("mac");
    expect(result.ok).toBe(false);
    expect(result.text).toContain('does not support "ring"');
    expect(result.text).toContain("locate, status");
  });

  it("fails fast with no transport and ignores stale results", async () => {
    const service = await tempService({ commandTimeoutMs: 60 });
    await registerPhone(service);

    const noTransport = await service.ringDevice("phone");
    expect(noTransport.ok).toBe(false);
    expect(noTransport.text).toContain("No companion transport is connected");

    // A result for an unknown/expired correlation id is ignored, not fatal.
    expect(
      service.completeCommand({
        commandId: "nope",
        deviceId: "phone",
        ok: true,
      }),
    ).toBe(false);
  });

  it("routes command tools through the shared gateway actions", async () => {
    const service = await tempService({ commandTimeoutMs: 2_000 });
    setMeshService(service);
    await service.register({
      id: "mac",
      name: "MacBook",
      platform: "macos",
      appVersion: "1.0.0",
      capabilities: ["ring", "status"],
    });
    service.registerTransport({
      locate: () => {},
      command: (cmd) =>
        queueMicrotask(() =>
          service.completeCommand({
            commandId: cmd.id,
            deviceId: cmd.deviceId,
            ok: true,
            ...(cmd.name === "status"
              ? { data: { battery: "93%", os: "macOS 15" } }
              : {}),
          }),
        ),
    });

    const ring = await meshHandlers.ring_device(
      { action: "ring_device", device: "mac" },
      1,
    );
    expect(ring.ok).toBe(true);
    expect(ring.text).toContain("MacBook is ringing");

    const status = await meshHandlers.get_device_status(
      { action: "get_device_status", device: "mac" },
      1,
    );
    expect(status.ok).toBe(true);
    expect(status.text).toContain("battery: 93%");
    expect(status.text).toContain("os: macOS 15");
  });
});
