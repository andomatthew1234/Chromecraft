import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const executable = path.join(
  root,
  "out",
  "Chromecraft-win32-x64",
  "chromecraft.exe",
);
const artifacts = path.join(root, ".artifacts");
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-youtube-smoke-"),
);
const reportPath = path.join(artifacts, "youtube-utility-report.json");
const screenshotPath = path.join(artifacts, "youtube-utility-banner.png");
await fs.mkdir(artifacts, { recursive: true });

const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    "--chromecraft-youtube-smoke-url=https://www.youtube.com/watch?v=jNQXAC9IVRw",
    `--chromecraft-youtube-smoke-report=${reportPath}`,
    `--chromecraft-youtube-smoke-screenshot=${screenshotPath}`,
  ],
  {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
child.stdout.on("data", (chunk) => (log += chunk.toString()));
child.stderr.on("data", (chunk) => (log += chunk.toString()));
const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error(`YouTube utility smoke test timed out.\n${log}`));
  }, 150_000);
  child.once("error", reject);
  child.once("exit", (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
});
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
console.log(JSON.stringify({ exitCode, report, screenshotPath, log }, null, 2));
await fs.rm(profile, { recursive: true, force: true });
if (exitCode !== 0 || !report.success) process.exitCode = 1;
