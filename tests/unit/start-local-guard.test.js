import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const launcher = fileURLToPath(new URL("../../scripts/start-local.mjs", import.meta.url));

function reject(env, args = []) {
  const vars = { ...process.env, ...env };
  if (env.DATA_DIR === undefined) delete vars.DATA_DIR;
  const result = spawnSync(process.execPath, [launcher, ...args], { env: vars, encoding: "utf8", timeout: 2000 });
  expect(result.status).toBe(1);
  return result.stderr;
}

// Every case exits before opening files, probing ports or spawning a server.
describe("local launcher production isolation guards", () => {
  it("requires an explicit isolated staging data directory", () => {
    expect(reject({ DATA_DIR: undefined })).toContain("Set an isolated DATA_DIR");
  });

  it("rejects the production port even with isolated data", () => {
    expect(reject({ DATA_DIR: "/tmp/synthetic-not-created", PORT: "20128" })).toContain("Staging must not use production port");
  });

  it("refuses production mode with a missing account database", () => {
    expect(reject({ DATA_DIR: "/tmp/synthetic-not-created", PORT: "20127" }, ["--production"])).toContain("Production account database does not exist");
  });

  it("rejects the production account directory on a staging port", () => {
    expect(reject({ DATA_DIR: path.join(os.homedir(), ".9router"), PORT: "20127" })).toContain("Staging must not use production port");
  });
});
