#!/usr/bin/env node
import("tsx").then(() => import("../src/index.ts")).catch((err) => {
  console.error("Failed to start Talon:", err.message);
  process.exit(1);
});
