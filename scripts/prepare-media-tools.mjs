import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(root, "resources", "media-tools");
const manifest = JSON.parse(
  await readFile(path.join(resources, "manifest.json"), "utf8"),
);
const key = `${process.platform}-${process.arch}`;
const platform = manifest.platforms[key];
if (!platform)
  throw new Error(`No pinned media tools are configured for ${key}.`);

const destination = path.join(resources, "bin", key);
const cache = path.join(root, ".artifacts", "media-tools-cache", key);
await mkdir(destination, { recursive: true });
await mkdir(cache, { recursive: true });

async function digest(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function download(url, output, expected) {
  try {
    if ((await digest(output)) === expected) return;
  } catch {}
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}) for ${url}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 100 * 1024 * 1024)
    throw new Error(`Refusing oversized media-tool asset from ${url}`);
  const temporary = `${output}.${process.pid}.download`;
  await rm(temporary, { force: true });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: "wx" }),
    );
    const actual = await digest(temporary);
    if (actual !== expected)
      throw new Error(
        `SHA-256 mismatch for ${url}: expected ${expected}, received ${actual}`,
      );
    await rm(output, { force: true });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

const ytDlpPath = path.join(destination, platform.ytDlp.filename);
await download(platform.ytDlp.url, ytDlpPath, platform.ytDlp.sha256);

const denoArchive = path.join(cache, "deno.zip");
const denoPath = path.join(destination, platform.deno.filename);
await download(platform.deno.url, denoArchive, platform.deno.sha256);
try {
  await access(denoPath);
} catch {
  if (process.platform === "win32") {
    await run("tar.exe", ["-xf", denoArchive, "-C", destination]);
  } else {
    await run("unzip", ["-o", denoArchive, "-d", destination]);
  }
}

if (process.platform !== "win32") {
  await chmod(ytDlpPath, 0o755);
  await chmod(denoPath, 0o755);
}

const licenseFiles = [
  [
    `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${manifest.ytDlpVersion}/LICENSE`,
    "YT_DLP_LICENSE",
  ],
  [
    `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${manifest.ytDlpVersion}/THIRD_PARTY_LICENSES.txt`,
    "YT_DLP_THIRD_PARTY_LICENSES.txt",
  ],
  [
    `https://raw.githubusercontent.com/denoland/deno/v${manifest.denoVersion}/LICENSE.md`,
    "DENO_LICENSE.md",
  ],
];
for (const [url, name] of licenseFiles) {
  const output = path.join(resources, name);
  try {
    await access(output);
  } catch {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Could not fetch license (${response.status}): ${url}`);
    await writeFile(output, await response.text(), "utf8");
  }
}

const integrity = {
  schemaVersion: 1,
  platform: key,
  ytDlp: { filename: platform.ytDlp.filename, sha256: await digest(ytDlpPath) },
  deno: { filename: platform.deno.filename, sha256: await digest(denoPath) },
};
await writeFile(
  path.join(destination, "integrity.json"),
  `${JSON.stringify(integrity, null, 2)}\n`,
  "utf8",
);
console.log(
  `Prepared yt-dlp ${manifest.ytDlpVersion} and Deno ${manifest.denoVersion} for ${key}.`,
);
