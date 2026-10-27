import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const platformArgument = process.argv.find((value) =>
  value.startsWith("--platform="),
);
const platform =
  platformArgument?.slice("--platform=".length) ?? process.platform;
const coreOnly = process.argv.includes("--core-only");
const root = process.cwd();
const artifacts = path.join(root, ".artifacts");
const profileRoot = path.join(os.tmpdir(), "chromecraft-smoke-profiles");

const executable =
  platform === "win32"
    ? path.join(root, "out", "Chromecraft-win32-x64", "chromecraft.exe")
    : path.join(root, "out", "Chromecraft-linux-x64", "chromecraft");

await fs.access(executable);
await fs.mkdir(artifacts, { recursive: true });

let adRequests = 0;
let suggestionRequests = [];
const server = http.createServer((request, response) => {
  const host = request.headers.host?.split(":")[0] ?? "";
  if (host === "doubleclick.net") {
    adRequests += 1;
    response.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
    });
    response.end("window.adScriptLoaded = true;");
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/suggest") {
    const query = requestUrl.searchParams.get("q") ?? "";
    suggestionRequests.push(query);
    const sendSuggestions = () => {
      if (response.destroyed) return;
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify([
          query,
          [`${query} result`, `${query} guide`, `${query} example`],
        ]),
      );
    };
    if (query === "phase14 old") setTimeout(sendSuggestions, 700);
    else sendSuggestions();
    return;
  }

  if (request.url === "/download") {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="chromecraft-smoke.txt"',
    });
    response.end("Chromecraft download smoke test.\n");
    return;
  }

  const sendFixture = () => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="en">
        <head><meta charset="utf-8"><title>Chromecraft fixture</title></head>
        <body>
          <h1>Chromecraft fixture</h1>
          <p id="status">The browser loaded this deterministic page.</p>
          <script>window.adScriptLoaded = false;</script>
          <script src="http://doubleclick.net:${server.address().port}/pagead/id"></script>
        </body>
      </html>`);
  };

  if (request.url?.includes("loading-indicator=1")) {
    setTimeout(sendFixture, 1_500);
    return;
  }
  sendFixture();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Could not start fixture server.");

async function runCase(
  name,
  ublockEnabled,
  includeLivePage,
  profileName = name,
  resetProfile = true,
  theme = "dark",
  remoteSearchSuggestionsEnabled = false,
) {
  const profile = path.join(profileRoot, `profile-${profileName}`);
  const reportPath = path.join(artifacts, `${name}-report.json`);
  const screenshotPath = path.join(artifacts, `${name}.png`);
  const shellScreenshotPath = path.join(artifacts, `${name}-shell.png`);
  const logPath = path.join(artifacts, `${name}.log`);
  if (resetProfile) await fs.rm(profile, { recursive: true, force: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(
    path.join(profile, "preferences.json"),
    `${JSON.stringify({ ublockEnabled, remoteSearchSuggestionsEnabled }, null, 2)}\n`,
    "utf8",
  );

  adRequests = 0;
  suggestionRequests = [];
  const args = [
    `--chromecraft-user-data=${profile}`,
    `--chromecraft-smoke-url=http://publisher.test:${address.port}/fixture`,
    `--chromecraft-smoke-report=${reportPath}`,
    `--chromecraft-smoke-screenshot=${screenshotPath}`,
    `--chromecraft-smoke-shell-screenshot=${shellScreenshotPath}`,
    `--chromecraft-smoke-theme=${theme}`,
    `--chromecraft-smoke-suggestions-url=http://127.0.0.1:${address.port}/suggest`,
  ];
  if (includeLivePage) args.push("--chromecraft-live-url=https://example.com/");

  const child = spawn(executable, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} smoke test timed out.\n${log}`));
    }, 90_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await fs.writeFile(logPath, log, "utf8");

  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${name} produced no readable report (exit ${exitCode}).\n${log}`,
      {
        cause: error,
      },
    );
  }

  return {
    name,
    exitCode,
    adRequests,
    suggestionRequests: [...suggestionRequests],
    report,
    reportPath,
    screenshotPath,
    shellScreenshotPath,
    logPath,
  };
}

try {
  const baseline = await runCase(
    "material3-after-ublock-disabled",
    false,
    false,
    "ublock-disabled",
    true,
    "light",
    false,
  );
  const protectedRun = coreOnly
    ? null
    : await runCase(
        "material3-after-ublock-enabled",
        true,
        true,
        "ublock-enabled",
        true,
        "dark",
        true,
      );
  const warmRun = coreOnly
    ? null
    : await runCase(
        "material3-after-ublock-enabled-warm",
        true,
        true,
        "ublock-enabled",
        false,
        "dark",
        true,
      );
  const failures = [];

  if (baseline.exitCode !== 0 || !baseline.report.success) {
    failures.push("The uBlock-disabled browser smoke run failed.");
  }
  if (!baseline.report.adScriptLoaded || baseline.adRequests < 1) {
    failures.push(
      "The unblocked control request did not reach the fixture server.",
    );
  }
  if (baseline.suggestionRequests.length !== 0) {
    failures.push("Remote suggestions connected while the setting was off.");
  }
  if (protectedRun && warmRun) {
    if (protectedRun.exitCode !== 0 || !protectedRun.report.success) {
      failures.push("The uBlock-enabled browser smoke run failed.");
    }
    if (
      !protectedRun.report.ublock.ready ||
      protectedRun.report.ublock.version !== "1.75.0"
    ) {
      failures.push("uBlock Origin 1.75.0 was not ready in the protected run.");
    }
    if (protectedRun.report.adScriptLoaded || protectedRun.adRequests !== 0) {
      failures.push(
        "uBlock Origin did not block the deterministic doubleclick.net request.",
      );
    }
    if (!protectedRun.report.ublockDashboardLoaded) {
      failures.push("The uBlock Origin dashboard did not load.");
    }
    if (
      protectedRun.suggestionRequests.length === 0 ||
      !protectedRun.report.remoteSearchSuggestionsWorked
    ) {
      failures.push("Opted-in remote search suggestions did not work.");
    }
    if (
      warmRun.exitCode !== 0 ||
      !warmRun.report.success ||
      warmRun.report.adScriptLoaded ||
      warmRun.adRequests !== 0
    ) {
      failures.push(
        "The warm restart did not preserve working uBlock protection.",
      );
    }
    if (warmRun.report.shellReadyMs > 5_000) {
      failures.push(
        `Warm startup exceeded 5 seconds (${warmRun.report.shellReadyMs} ms).`,
      );
    }
  }

  const summary = {
    success: failures.length === 0,
    platform,
    fixturePort: address.port,
    baseline,
    protectedRun,
    warmRun,
    failures,
  };
  await fs.writeFile(
    path.join(artifacts, "smoke-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
}
