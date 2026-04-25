#!/usr/bin/env node
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "linux") process.exit(0);

const report = process.report.getReport();
const glibcVersion = report?.header?.glibcVersionRuntime;
const isGlibc = typeof glibcVersion === "string" && glibcVersion.length > 0;

const base = join(process.cwd(), "node_modules", "@anthropic-ai");
const wrong = isGlibc
  ? `claude-agent-sdk-linux-${process.arch}-musl`
  : `claude-agent-sdk-linux-${process.arch}`;
const target = join(base, wrong);

if (existsSync(target)) {
  try {
    rmSync(target, { recursive: true, force: true });
    console.log(`[prune-native-sdk] removed ${wrong} (host is ${isGlibc ? "glibc" : "musl"})`);
  } catch (err) {
    console.warn(`[prune-native-sdk] failed to remove ${wrong}: ${err.message}`);
  }
}
