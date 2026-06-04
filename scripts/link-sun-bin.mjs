#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const target = resolve(repoRoot, "packages", "launcher", "dist", "index.js");
const binDir = resolve(homedir(), ".local", "bin");
const link = resolve(binDir, "sun");

mkdirSync(binDir, { recursive: true });

if (existsSync(link)) {
  const stat = lstatSync(link);
  if (!stat.isSymbolicLink()) {
    console.warn(`[sunpilot] ${link} exists and is not a symlink; leaving it unchanged.`);
    process.exit(0);
  }
  const current = resolve(binDir, readlinkSync(link));
  if (current === target) {
    console.log(`[sunpilot] sun command already linked: ${link}`);
    process.exit(0);
  }
  unlinkSync(link);
}

symlinkSync(target, link);
console.log(`[sunpilot] linked sun command: ${link}`);
