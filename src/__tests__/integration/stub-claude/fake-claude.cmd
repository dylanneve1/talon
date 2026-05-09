@echo off
REM Windows wrapper for fake-claude.mjs.
REM The SDK invokes `pathToClaudeCodeExecutable` directly. On Linux/macOS the
REM shebang on fake-claude.mjs makes it directly executable; Windows can't
REM execute .mjs files from a path, so we shim via this .cmd that forwards
REM all args to node.
node "%~dp0fake-claude.mjs" %*
