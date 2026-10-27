import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "release-artifacts");
const entries = await readdir(directory, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

const setup = exactlyOne(
  files,
  (name) => /Setup\.exe$/i.test(name),
  "Setup.exe",
);
const nupkg = exactlyOne(
  files,
  (name) => /-full\.nupkg$/i.test(name),
  "full nupkg",
);
exactlyOne(files, (name) => /-win32-x64-.+\.zip$/i.test(name), "portable ZIP");
for (const required of [
  "RELEASES",
  "release.json",
  "release-notes.md",
  "signature-report.json",
]) {
  if (!files.includes(required)) throw new Error(`${required} is missing.`);
}

const releaseLine = (await readFile(path.join(directory, "RELEASES"), "utf8"))
  .trim()
  .split(/\r?\n/)
  .at(-1);
const releaseMatch = /^([0-9a-f]{40})\s+(\S+)\s+(\d+)$/i.exec(
  releaseLine ?? "",
);
if (!releaseMatch) throw new Error("RELEASES has an invalid final entry.");
if (path.basename(releaseMatch[2]) !== nupkg) {
  throw new Error("RELEASES does not reference the full nupkg artifact.");
}
const nupkgPath = path.join(directory, nupkg);
const nupkgBytes = await readFile(nupkgPath);
if (Number(releaseMatch[3]) !== nupkgBytes.length) {
  throw new Error("RELEASES contains the wrong nupkg size.");
}
if (releaseMatch[1].toLowerCase() !== digest(nupkgBytes, "sha1")) {
  throw new Error("RELEASES contains the wrong nupkg SHA-1.");
}

const metadata = JSON.parse(
  await readFile(path.join(directory, "release.json"), "utf8"),
);
if (metadata.schemaVersion !== 1) {
  throw new Error("release.json uses an unsupported schema version.");
}
if (!["chromecraft", "dependencies", "both"].includes(metadata.category)) {
  throw new Error("release.json has an invalid category.");
}
if (!nupkg.includes(`-${metadata.version}-`)) {
  throw new Error("The nupkg name does not match release.json.");
}
const releaseNotes = await readFile(
  path.join(directory, "release-notes.md"),
  "utf8",
);
const expectedCategoryMarker = `<!-- chromecraft-update: {"category":"${metadata.category}"} -->`;
if (!releaseNotes.includes(expectedCategoryMarker)) {
  throw new Error(
    "Release notes are missing the matching update category marker.",
  );
}

const signatures = JSON.parse(
  await readFile(path.join(directory, "signature-report.json"), "utf8"),
);
if (
  signatures.schemaVersion !== 2 ||
  signatures.allValid !== true ||
  !/^[0-9A-F]{40}$/.test(signatures.expectedThumbprint ?? "") ||
  !Array.isArray(signatures.files) ||
  signatures.packageFilesMatchedInNupkg !== 1
) {
  throw new Error("The Windows signature report is not valid.");
}
for (const item of signatures.files) {
  if (
    item.status !== "Valid" ||
    item.thumbprint !== signatures.expectedThumbprint ||
    !/^[0-9a-f]{64}$/.test(item.sha256 ?? "")
  ) {
    throw new Error(`Invalid Authenticode evidence for ${item.name}.`);
  }
}
const requiredSignatures = [
  { scope: "setup", name: setup },
  { scope: "package", name: "chromecraft.exe" },
  { scope: "nupkg", name: "lib/net45/chromecraft.exe" },
];
if (
  requiredSignatures.some(
    (required) =>
      !signatures.files.some(
        (item) => item.scope === required.scope && item.name === required.name,
      ),
  )
) {
  throw new Error("Required release executables are not Authenticode signed.");
}
const packageExecutable = signatures.files.find(
  (item) => item.scope === "package" && item.name === "chromecraft.exe",
);
const nupkgExecutable = signatures.files.find(
  (item) => item.scope === "nupkg" && item.name === "lib/net45/chromecraft.exe",
);
if (packageExecutable.sha256 !== nupkgExecutable.sha256) {
  throw new Error(
    "The full nupkg contains a different application executable.",
  );
}
const setupSignature = signatures.files.find(
  (item) => item.scope === "setup" && item.name === setup,
);
if (
  setupSignature.sha256 !==
  digest(await readFile(path.join(directory, setup)), "sha256")
) {
  throw new Error(
    "The setup executable does not match its signature evidence.",
  );
}

const checksumFiles = files.filter((name) => name !== "SHA256SUMS");
const checksums = [];
for (const name of checksumFiles) {
  const filePath = path.join(directory, name);
  if (!(await stat(filePath)).isFile()) continue;
  checksums.push(`${digest(await readFile(filePath), "sha256")}  ${name}`);
}
await writeFile(
  path.join(directory, "SHA256SUMS"),
  `${checksums.join("\n")}\n`,
  "utf8",
);

function exactlyOne(values, predicate, label) {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${matches.length}.`);
  }
  return matches[0];
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex");
}
