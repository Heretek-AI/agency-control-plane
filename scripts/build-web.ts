#!/usr/bin/env bun
/**
 * Build the WebUI for the browser: `web/index.html` (which loads
 * `./src/main.tsx`) -> `web/dist/` (hashed JS/CSS + rewritten index.html).
 * Fails when the bundle is missing, empty, or still references Node
 * built-ins, so a broken browser build can never ship silently.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "web", "dist");
rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(root, "web", "index.html")],
  outdir,
  target: "browser",
  minify: true,
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("web build failed");
}

const files = readdirSync(outdir, { recursive: true }).map(String);
const scripts = files.filter((file) => file.endsWith(".js"));
if (!existsSync(join(outdir, "index.html")) || scripts.length === 0) {
  throw new Error(`web build produced no index.html/script: ${files.join(", ")}`);
}
const html = readFileSync(join(outdir, "index.html"), "utf8");
if (html.includes("main.tsx")) {
  throw new Error("web/dist/index.html still references the TSX source");
}
let total = 0;
for (const file of scripts) {
  const code = readFileSync(join(outdir, file), "utf8");
  total += statSync(join(outdir, file)).size;
  if (/from\s*["']node:|require\(["']node:/.test(code)) {
    throw new Error(`${file} references a Node built-in; the browser bundle must not`);
  }
}
if (total < 50_000) {
  throw new Error(`web bundle is suspiciously small (${total} bytes); React app not bundled?`);
}
console.log(`web build ok: ${scripts.length} script(s), ${(total / 1024).toFixed(0)} KiB -> ${outdir}`);
