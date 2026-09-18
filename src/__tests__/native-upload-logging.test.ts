import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const logged: Array<{ level: "info" | "warn"; text: string }> = [];

vi.mock("../util/log.js", () => ({
  log: (_c: string, text: string) => logged.push({ level: "info", text }),
  logWarn: (_c: string, text: string) => logged.push({ level: "warn", text }),
  logError: () => {},
}));

/**
 * Upload failures used to be answered in JSON and logged nowhere, so the
 * daemon log had nothing to say when a client could not attach a file.
 */
describe("the upload route's logging", () => {
  const routesFor = async (host: unknown) => {
    const { chatRoutes } =
      await import("../frontend/native/bridge/routes/chats.js");
    return chatRoutes(host as never);
  };

  const hostWith = (upload: (filename: string) => Promise<unknown>) =>
    ({
      json: () => {},
      readJson: async () => ({}),
      handlers: { upload },
    }) as never;

  const call = async (
    routes: Awaited<ReturnType<typeof routesFor>>,
    filename: string,
  ) =>
    routes["POST /upload"]({
      req: Object.assign(Readable.from([]), { headers: {} }) as never,
      res: {} as never,
      url: new URL(`http://x/upload?filename=${filename}`),
    } as never);

  it("logs the file on success and the reason on failure", async () => {
    logged.length = 0;
    const routes = await routesFor(
      hostWith(async (filename: string) => {
        if (filename === "big")
          throw new Error("Upload exceeds the 512 MB limit");
        return {
          path: "/u/deck.pptx",
          name: "deck.pptx",
          size: 9042185,
          mimeType: "application/vnd.ms-powerpoint",
          url: "/media?id=m1",
          image: false,
        };
      }),
    );

    await call(routes, "deck.pptx");
    await call(routes, "big");

    const ok = logged.find((l) => l.level === "info");
    expect(ok?.text).toContain("deck.pptx");
    expect(ok?.text).toContain("9042185 bytes");

    const failed = logged.find((l) => l.level === "warn");
    expect(failed?.text).toContain("upload failed (413)");
    expect(failed?.text).toContain("512 MB limit");
  });
});
