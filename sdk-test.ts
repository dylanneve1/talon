delete process.env.CLAUDECODE;
import { execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";

const claudePath = execSync("where claude", {encoding: "utf-8"}).trim().split("\n")[0].trim();
console.log("Claude path:", claudePath);
console.log("Platform:", process.platform);

const qi = query({
  prompt: "Say hi",
  options: {
    model: "default",
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    maxTurns: 1,
    pathToClaudeCodeExecutable: claudePath,
  }
});
console.log("Query created");

const timer = setTimeout(() => { console.log("HUNG after 15s"); process.exit(1); }, 15000);

try {
  for await (const msg of qi) {
    const m = msg as Record<string, unknown>;
    console.log("EVENT:", m.type, m.subtype || "");
    if (m.type === "result") {
      console.log("Result:", String(m.result).slice(0, 100));
      break;
    }
  }
  console.log("Done");
} catch(e: any) {
  console.log("ERROR:", e.message);
}
clearTimeout(timer);
process.exit(0);
