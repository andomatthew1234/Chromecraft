import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const options = parseArguments(process.argv.slice(2));
const category = requireChoice(options.category, "category", [
  "chromecraft",
  "dependencies",
  "both",
]);
const output = requireText(options.output, "output");
const commit = requireCommit(options.commit);
const publishedAt = requireIsoDate(
  options["published-at"] ?? new Date().toISOString(),
);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const mediaTools = JSON.parse(
  await readFile("resources/media-tools/manifest.json", "utf8"),
);
const version = requireSemver(packageJson.version, "package version");
const expectedVersion = options.version
  ? requireSemver(options.version, "requested version")
  : version;

if (version !== expectedVersion) {
  throw new Error(
    `The package version ${version} does not match requested release ${expectedVersion}.`,
  );
}

const runtime = readElectronRuntime();
if (runtime.electron !== packageJson.devDependencies?.electron) {
  throw new Error(
    `Electron runtime ${runtime.electron} does not match package.json ${packageJson.devDependencies?.electron ?? "(missing)"}.`,
  );
}

const metadata = {
  schemaVersion: 1,
  version,
  applicationBuildVersion: version,
  category,
  changeCategories:
    category === "both" ? ["chromecraft", "dependencies"] : [category],
  commit,
  publishedAt,
  installerFormat: "squirrel.windows",
  runtime: {
    electron: runtime.electron,
    chromium: runtime.chrome,
    node: runtime.node,
    v8: runtime.v8,
  },
  bundledTools: {
    ytDlp: requireText(mediaTools.ytDlpVersion, "yt-dlp version"),
    deno: requireText(mediaTools.denoVersion, "Deno version"),
  },
};

await writeFile(output, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

function readElectronRuntime() {
  const executable =
    process.platform === "win32"
      ? path.resolve("node_modules/electron/dist/electron.exe")
      : path.resolve("node_modules/electron/dist/electron");
  const raw = execFileSync(
    executable,
    ["-e", "process.stdout.write(JSON.stringify(process.versions))"],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
    },
  );
  const versions = JSON.parse(raw);
  for (const key of ["electron", "chrome", "node", "v8"]) {
    requireText(versions[key], `${key} runtime version`);
  }
  return versions;
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument sequence near ${JSON.stringify(key)}.`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function requireChoice(value, label, choices) {
  if (!choices.includes(value)) {
    throw new Error(`${label} must be one of: ${choices.join(", ")}.`);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requireSemver(value, label) {
  const clean = requireText(value, label);
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
      clean,
    )
  ) {
    throw new Error(`${label} is not a supported semantic version.`);
  }
  return clean;
}

function requireCommit(value) {
  const clean = requireText(value, "commit");
  if (!/^[0-9a-f]{40}$/i.test(clean)) {
    throw new Error("commit must be a full Git SHA.");
  }
  return clean.toLowerCase();
}

function requireIsoDate(value) {
  const clean = requireText(value, "published-at");
  const timestamp = Date.parse(clean);
  if (!Number.isFinite(timestamp)) throw new Error("published-at is invalid.");
  return new Date(timestamp).toISOString();
}
