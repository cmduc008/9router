import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const production = process.argv.includes("--production");
const productionDataDir = path.join(os.homedir(), ".9router");
if (!production && !process.env.DATA_DIR) {
  throw new Error("Set an isolated DATA_DIR for staging. Production requires explicit --production after a separate cutover");
}
const dataDir = path.resolve(process.env.DATA_DIR || productionDataDir);
const canonicalDir = (dir) => fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
if (!production && canonicalDir(dataDir) === canonicalDir(productionDataDir)) {
  throw new Error("Staging must not use production port 20128 or the production account directory");
}
const port = Number(process.env.PORT || (production ? 20128 : 20127));
const host = process.env.ROUTER_HOST || "127.0.0.1";
if (!production && (port === 20128 || dataDir === productionDataDir)) {
  throw new Error("Staging must not use production port 20128 or the production account directory");
}
const server = path.join(root, ".next", "standalone", "custom-server.js");

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
if (!fs.existsSync(server)) throw new Error("Run npm run build before starting the local router");
if (production) {
  if (fs.existsSync(path.join(dataDir, "snapshot-pending-refresh"))) {
    throw new Error("Local snapshot must be refreshed after stopping package: python3 -I scripts/sync-local-data.py");
  }
  const db = path.join(dataDir, "db", "data.sqlite");
  if (!fs.existsSync(db)) throw new Error("Production account database does not exist; refusing to start with empty accounts");
  const packageDb = path.join(productionDataDir, "db", "data.sqlite");
  if (canonicalDir(dataDir) !== canonicalDir(productionDataDir) && fs.existsSync(packageDb)) {
    const packageWriters = spawnSync("lsof", ["-t", packageDb], { encoding: "utf8" });
    if (packageWriters.error || packageWriters.stderr.trim() ||
        (packageWriters.status !== 0 && packageWriters.status !== 1) || packageWriters.stdout.trim()) {
      throw new Error("Package account database is open or its state is unknown; do not run duplicate OAuth accounts");
    }
  }
  const writers = spawnSync("lsof", ["-t", db], { encoding: "utf8" });
  if (writers.status === 0 && writers.stdout.trim()) {
    throw new Error("Account database is still open by another process; close the package router before running local");
  }
  if (writers.error || writers.stderr.trim() || (writers.status !== 0 && writers.status !== 1)) {
    throw new Error("Cannot verify production database ownership; refusing to launch");
  }
}
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);

// Check every bind address before opening a database or launching Next.
const listeners = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
if (listeners.status === 0 && listeners.stdout.trim()) {
  throw new Error(`Port ${port} is occupied; leave the existing router running`);
}
if (listeners.error || listeners.stderr.trim() || (listeners.status !== 0 && listeners.status !== 1)) {
  throw new Error("Cannot verify router listener state; refusing to launch");
}
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", () => reject(new Error(`Port ${port} is occupied; stop the old router before starting this one`)));
  probe.listen(port, host, () => probe.close(resolve));
});

console.log(`Starting local router at http://${host}:${port}; data stays outside Git at ${dataDir}`);
const child = spawn(process.execPath, [server], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    HOSTNAME: host,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
