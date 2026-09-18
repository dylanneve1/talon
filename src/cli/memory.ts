/**
 * `talon memory` — read and edit the typed memory store from a terminal.
 *
 * All lifecycle logic lives in storage/memory.ts; this module only parses
 * argv and renders rows. One row per line, in the store's own
 * `formatMemory` shape, so CLI output and the `/memory` surfaces read
 * identically.
 */

import pc from "picocolors";
import { importAll } from "../core/memory/import.js";
import {
  renderMemoryMarkdown,
  writeRenderedMemory,
} from "../core/memory/render.js";
import {
  assertMemory,
  dropMemory,
  formatMemory,
  getMemory,
  isMemoryKind,
  listMemories,
  memoryHistory,
  replaceStateKey,
  searchMemories,
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRow,
} from "../storage/memory.js";

const USAGE = [
  `  Usage: ${pc.cyan("talon memory <command>")}`,
  "",
  "  Commands:",
  `    ${pc.cyan("list [kind]")}                    Show live memories, ranked`,
  `    ${pc.cyan("search <query>")}                 Full-text search`,
  `    ${pc.cyan("show <id>")}                      One row plus its history`,
  `    ${pc.cyan("remember <kind> <subject> <text>")} Record an operator claim`,
  `    ${pc.cyan("forget <id> [reason]")}           Drop a row to the graveyard`,
  `    ${pc.cyan("state <key> <text>")}             Replace the row for a state key`,
  `    ${pc.cyan("import")}                         Fold memory.md + daily notes into the store`,
  `    ${pc.cyan("render [--write]")}               Render the store as memory.md`,
  "",
  `  Kinds: ${MEMORY_KINDS.join(", ")}`,
  "",
].join("\n");

function fail(message: string): void {
  console.log(`  ${pc.red("✖")} ${message}`);
}

function printRows(rows: readonly MemoryRow[], empty: string): void {
  if (rows.length === 0) {
    console.log(`  ${pc.dim(empty)}\n`);
    return;
  }
  for (const row of rows) console.log(`  ${formatMemory(row)}`);
  console.log();
}

function parseKind(value: string | undefined): MemoryKind | undefined {
  if (value === undefined) return undefined;
  if (!isMemoryKind(value)) throw new Error(`Unknown kind "${value}"`);
  return value;
}

function cmdList(kindArg: string | undefined): void {
  const kind = parseKind(kindArg);
  const rows = listMemories(kind ? { kind } : {});
  printRows(rows, kind ? `No ${kind} memories yet.` : "No memories yet.");
}

function cmdSearch(query: string): void {
  printRows(searchMemories(query), `No memories matching "${query}".`);
}

function cmdShow(idArg: string | undefined): void {
  const id = Number(idArg);
  if (!Number.isInteger(id)) {
    fail("show needs a numeric memory id");
    return;
  }
  const row = getMemory(id);
  if (!row) {
    fail(`No memory with id ${id}`);
    return;
  }
  console.log(`  ${formatMemory(row)}`);
  console.log(
    `  ${pc.dim(`trust=${row.trust} confidence=${row.confidence} hits=${row.hitCount} salience=${row.salience}`)}`,
  );
  for (const entry of memoryHistory(id)) {
    const when = new Date(entry.at).toISOString();
    const why = entry.reason ? ` — ${entry.reason}` : "";
    console.log(`    ${pc.dim(when)} ${entry.op}${why}`);
  }
  console.log();
}

function cmdRemember(args: readonly string[]): void {
  const [kindArg, subject, ...rest] = args;
  const text = rest.join(" ");
  if (!kindArg || !subject || !text) {
    fail("remember needs <kind> <subject> <text...>");
    return;
  }
  const kind = parseKind(kindArg);
  const { id, similar } = assertMemory({
    kind: kind!,
    subject,
    text,
    trust: "operator",
  });
  console.log(`  ${pc.green("●")} Remembered as #${id}`);
  if (similar.length > 0) {
    console.log(`  ${pc.dim("Near-duplicates already stored:")}`);
    for (const row of similar) console.log(`    ${formatMemory(row)}`);
  }
  console.log();
}

function cmdForget(args: readonly string[]): void {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) {
    fail("forget needs a numeric memory id");
    return;
  }
  const reason = args.slice(1).join(" ");
  dropMemory(id, reason || undefined);
  console.log(`  ${pc.green("●")} Dropped #${id} to the graveyard\n`);
}

function cmdState(args: readonly string[]): void {
  const [key, ...rest] = args;
  const text = rest.join(" ");
  if (!key || !text) {
    fail("state needs <key> <text...>");
    return;
  }
  const id = replaceStateKey(key, text);
  console.log(`  ${pc.green("●")} ${key} is now #${id}\n`);
}

function cmdImport(): void {
  const { inserted, superseded, skipped } = importAll();
  console.log(
    `  ${pc.green("●")} Imported: ${inserted} new, ${superseded} updated, ${skipped} unchanged\n`,
  );
}

function cmdRender(args: readonly string[]): void {
  if (!args.includes("--write")) {
    console.log(renderMemoryMarkdown());
    return;
  }
  const { path, bytes, backup } = writeRenderedMemory();
  console.log(`  ${pc.green("●")} Wrote ${bytes} chars to ${path}`);
  if (backup) console.log(`  ${pc.dim(`Previous file archived to ${backup}`)}`);
  console.log();
}

/** Route a `talon memory <command>` invocation. */
export function runMemoryCommand(args: readonly string[]): void {
  try {
    switch (args[0]) {
      case "list":
        cmdList(args[1]);
        break;
      case "search":
        if (!args[1]) fail("search needs a query");
        else cmdSearch(args.slice(1).join(" "));
        break;
      case "show":
        cmdShow(args[1]);
        break;
      case "remember":
        cmdRemember(args.slice(1));
        break;
      case "forget":
        cmdForget(args.slice(1));
        break;
      case "state":
        cmdState(args.slice(1));
        break;
      case "import":
        cmdImport();
        break;
      case "render":
        cmdRender(args.slice(1));
        break;
      default:
        console.log(USAGE);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
