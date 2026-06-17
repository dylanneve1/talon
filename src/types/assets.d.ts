// Ambient declaration for prompt file-asset imports. The Bun-only
// `import x from "./foo.md" with { type: "file" }` form (used only by the
// generated embedded-prompts.ts, reached through the `bun` condition of
// the `#prompt-assets` package import) resolves to the embedded file path
// as a string. tsx/node never load that module — they use disk-prompts.ts.
declare module "*.md" {
  const path: string;
  export default path;
}
