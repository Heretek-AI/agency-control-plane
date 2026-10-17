#!/usr/bin/env bun
/**
 * Dispatcher daemon entrypoint: serves the control API and the built
 * WebUI on one loopback origin, runs workers and the Director.
 *
 *   bun dispatcher/src/main.ts --repo <repo> [--state-dir <dir>] [--port 7600]
 *
 * Flags (environment fallback in parentheses):
 *   --repo <dir>            repository the fleet works on (FLEET_REPO, default cwd)
 *   --state-dir <dir>       SQLite board, worktrees, audit log, human.pub
 *                           (FLEET_STATE_DIR, default ~/.local/state/agency-control-plane)
 *   --port <n>              loopback port (FLEET_PORT, default 7600; 0 = ephemeral)
 *   --human-pub <file>      pinned human key (default <state-dir>/human.pub)
 *   --web-dist <dir>        built WebUI (default web/dist next to this package)
 *   --worker-cmd <cmd>      worker server command, JSON array or words
 *                           (FLEET_WORKER_CMD, default `opencode serve --port 0 --hostname 127.0.0.1`)
 *   --director-cmd <cmd>    Director server command (default: worker command)
 *   --director-agent <name> OpenCode agent for the Director (default `director`)
 *   --task-agent <name>     OpenCode agent for task workers (default: server default)
 *   --roles-dir <dir>       role packs for `expert` tasks (FLEET_ROLES_DIR); see dispatcher/src/roles.ts
 *   --tier-models <json>    `{"tier-1-opencode": "provider/model", ...}` (FLEET_TIER_MODELS);
 *                           tier failover moves new worker sessions to the next tier's model
 *   --fleet-cap <n>         max concurrent workers (default 4)
 *   --per-expert-cap <n>    max concurrent workers per expert without a role cap (default: fleet cap)
 *   --task-timeout-ms <n>   per-task worker timeout (default 30 min)
 *   --no-workers / --no-director
 *   NATS_URL                mirror events + board into NATS JetStream / KV
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseCommand, parseTierModels } from "./cli-args.js";
import { NatsJetStreamBridge, natsUrlFromEnv, redactNatsUrl } from "./nats-bridge.js";
import { startServer } from "./server.js";

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

async function main(): Promise<void> {
  const { flags, switches } = parseArgs(process.argv.slice(2), new Set(["no-workers", "no-director"]));
  const env = process.env;
  const repoDir = resolve(flags.get("repo") ?? env["FLEET_REPO"] ?? process.cwd());
  const stateDir = resolve(flags.get("state-dir") ?? env["FLEET_STATE_DIR"] ?? join(homedir(), ".local", "state", "agency-control-plane"));
  const port = int(flags.get("port") ?? env["FLEET_PORT"], 7600, "--port");
  const webDistDir = resolve(flags.get("web-dist") ?? join(import.meta.dir, "..", "..", "web", "dist"));
  const workerCmd = flags.get("worker-cmd") ?? env["FLEET_WORKER_CMD"];
  const directorCmd = flags.get("director-cmd") ?? env["FLEET_DIRECTOR_CMD"];
  const workerCommand = workerCmd === undefined ? undefined : parseCommand(workerCmd);

  const running = startServer({
    port,
    repoDir,
    stateDir,
    webDistDir,
    humanPublicKeyPath: flags.get("human-pub"),
    fleetCap: int(flags.get("fleet-cap"), 4, "--fleet-cap"),
    workers: switches.has("no-workers")
      ? false
      : {
          command: workerCommand,
          agent: flags.get("task-agent"),
          rolesDir: flags.get("roles-dir") ?? env["FLEET_ROLES_DIR"],
          tierModels: parseTierModels(flags.get("tier-models") ?? env["FLEET_TIER_MODELS"]),
          perExpertCap: flags.has("per-expert-cap") ? Math.max(1, int(flags.get("per-expert-cap"), 1, "--per-expert-cap")) : undefined,
          taskTimeoutMs: flags.has("task-timeout-ms") ? int(flags.get("task-timeout-ms"), 0, "--task-timeout-ms") : undefined,
        },
    director: switches.has("no-director")
      ? false
      : {
          command: directorCmd === undefined ? workerCommand : parseCommand(directorCmd),
          agent: flags.get("director-agent") ?? "director",
        },
  });
  const { app } = running;
  const natsUrl = natsUrlFromEnv(env);
  if (natsUrl !== null) {
    try {
      app.attachNats(await NatsJetStreamBridge.connect(natsUrl));
    } catch (err) {
      await running.stop();
      throw new Error(`NATS_URL=${redactNatsUrl(natsUrl)} is set but JetStream is unreachable: ${(err as Error).message}`);
    }
  }
  console.log(`fleet dispatcher listening on ${running.url}`);
  console.log(`  repo:      ${repoDir}`);
  console.log(`  state:     ${stateDir}`);
  console.log(`  web UI:    ${webDistDir}`);
  console.log(
    app.humanKey !== null
      ? `  approvals: pinned human key ${app.humanKey.fingerprint.slice(0, 16)}… (${app.humanKey.sourcePath})`
      : `  approvals: DISABLED (fail closed): ${app.approvalsUnavailableReason ?? "no key"}`,
  );
  console.log(`  nats:      ${natsUrl !== null ? redactNatsUrl(natsUrl) : "off (set NATS_URL to mirror into JetStream)"}`);
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`received ${signal}; stopping workers`);
    running.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(`dispatcher: ${(err as Error).message}`);
  process.exit(1);
});
