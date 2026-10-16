import { expect, test } from "bun:test";
import { parseArgs } from "../src/cli-args.js";

const SWITCHES = new Set(["no-director"]);

test("value flags, = form, and known switches", () => {
  const { flags, switches } = parseArgs(["--port", "7600", "--repo=/r", "--no-director"], SWITCHES);
  expect(flags.get("port")).toBe("7600");
  expect(flags.get("repo")).toBe("/r");
  expect(switches.has("no-director")).toBe(true);
});

test("a value flag without its operand is an error, not a switch", () => {
  expect(() => parseArgs(["--worker-cmd", "--port", "7600"], SWITCHES)).toThrow("--worker-cmd requires a value");
  expect(() => parseArgs(["--human-pub"], SWITCHES)).toThrow("--human-pub requires a value");
});

test("a switch never swallows an operand", () => {
  expect(() => parseArgs(["--no-director", "stray"], SWITCHES)).toThrow("unexpected argument");
  expect(() => parseArgs(["--no-director=yes"], SWITCHES)).toThrow("takes no value");
});
