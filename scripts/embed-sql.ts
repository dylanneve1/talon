/**
 * `npm run build:sql` — regenerate src/storage/sql/statements.generated.ts
 * from the .sql files next to it. See src/storage/sql/embed.ts.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSqlModule, readSqlSources } from "../src/storage/sql/embed.js";

const sqlDir = fileURLToPath(new URL("../src/storage/sql", import.meta.url));
const target = join(sqlDir, "statements.generated.ts");
writeFileSync(target, buildSqlModule(readSqlSources(sqlDir)));
console.log(`wrote ${target}`);
