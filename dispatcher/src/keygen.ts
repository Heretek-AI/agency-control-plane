#!/usr/bin/env bun
/**
 * Generate the human approval key in es-core's sealed format:
 *
 *   bun dispatcher/src/keygen.ts --out ~/.local/state/agency-control-plane [--force]
 *
 * Writes `human.key.enc` (scrypt + aes-256-gcm, mode 0600) and
 * `human.pub`. The passphrase comes from `HUMAN_KEY_PASSPHRASE` or an
 * interactive prompt (input not echoed). An existing `human.pub` from
 * epistemic-factory works as-is: point `--state-dir` / `--human-pub` at it
 * instead of generating a new one.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "./cli-args.js";
import { sealHumanKey } from "./human-key.js";

const stdinLines = console[Symbol.asyncIterator]();

async function readPassphrase(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const tty = process.stdin.isTTY === true;
  if (tty) spawnSync("stty", ["-echo"], { stdio: "inherit" });
  try {
    const next = await stdinLines.next();
    return next.done === true ? "" : next.value;
  } finally {
    if (tty) spawnSync("stty", ["echo"], { stdio: "inherit" });
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  const { flags, switches } = parseArgs(process.argv.slice(2), new Set(["force"]));
  const out = resolve(flags.get("out") ?? process.env["FLEET_STATE_DIR"] ?? join(homedir(), ".local", "state", "agency-control-plane"));
  if (existsSync(join(out, "human.pub")) && !switches.has("force")) {
    throw new Error(`${join(out, "human.pub")} already exists; pass --force to replace the human key`);
  }
  let passphrase = process.env["HUMAN_KEY_PASSPHRASE"] ?? "";
  if (passphrase.length === 0) {
    passphrase = await readPassphrase("Approval passphrase: ");
    const confirm = await readPassphrase("Repeat passphrase: ");
    if (confirm !== passphrase) throw new Error("passphrases do not match");
  }
  if (passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
  const { fingerprint } = sealHumanKey(out, passphrase);
  passphrase = "";
  console.log(`wrote ${join(out, "human.key.enc")} (0600) and ${join(out, "human.pub")}`);
  console.log(`fingerprint ${fingerprint}`);
}

main().catch((err: unknown) => {
  console.error(`keygen: ${(err as Error).message}`);
  process.exit(1);
});
