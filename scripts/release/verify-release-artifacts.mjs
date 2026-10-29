import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "release-artifacts");
const requireLinux = process.argv.includes("--require-linux");
const sums = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
const records = sums
  .trim()
  .split(/\r?\n/)
  .map((line) => /^([0-9a-f]{64})  (.+)$/i.exec(line))
  .map((match) => {
    if (!match) throw new Error("SHA256SUMS contains an invalid line.");
    return { digest: match[1].toLowerCase(), name: match[2] };
  });

if (records.length === 0) throw new Error("SHA256SUMS is empty.");
const checksummedNames = new Set(records.map((record) => record.name));
if (checksummedNames.size !== records.length) {
  throw new Error("SHA256SUMS contains duplicate artifact names.");
}
const artifactNames = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));
const recordedNames = [...checksummedNames].sort((left, right) =>
  left.localeCompare(right),
);
if (JSON.stringify(artifactNames) !== JSON.stringify(recordedNames)) {
  throw new Error(
    "SHA256SUMS does not cover every release artifact exactly once.",
  );
}
for (const [label, predicate] of [
  ["Setup.exe", (name) => /Setup\.exe$/i.test(name)],
  ["full nupkg", (name) => /-full\.nupkg$/i.test(name)],
  ["portable ZIP", (name) => /-win32-x64-.+\.zip$/i.test(name)],
]) {
  const matches = artifactNames.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${matches.length}.`);
  }
}
if (requireLinux) {
  const linuxPackages = artifactNames.filter((name) =>
    /_amd64\.deb$/i.test(name),
  );
  if (linuxPackages.length !== 1) {
    throw new Error(
      `Expected exactly one Linux amd64 DEB; found ${linuxPackages.length}.`,
    );
  }
}
const actualDigests = new Map();
for (const record of records) {
  if (
    path.basename(record.name) !== record.name ||
    record.name === "SHA256SUMS"
  ) {
    throw new Error(`Unsafe checksum path: ${record.name}.`);
  }
  const filePath = path.join(directory, record.name);
  if (!(await stat(filePath)).isFile()) {
    throw new Error(`Checksummed artifact is missing: ${record.name}.`);
  }
  const actual = createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
  if (actual !== record.digest) {
    throw new Error(`SHA-256 mismatch for ${record.name}.`);
  }
  actualDigests.set(record.name, actual);
}

const metadata = JSON.parse(
  await readFile(path.join(directory, "release.json"), "utf8"),
);
const signatures = JSON.parse(
  await readFile(path.join(directory, "signature-report.json"), "utf8"),
);
if (
  metadata.schemaVersion !== 1 ||
  !["chromecraft", "dependencies", "both"].includes(metadata.category) ||
  signatures.schemaVersion !== 2 ||
  signatures.allValid !== true ||
  !/^[0-9A-F]{40}$/.test(signatures.expectedThumbprint ?? "") ||
  signatures.packageFilesMatchedInNupkg !== 1 ||
  !Array.isArray(signatures.files)
) {
  throw new Error("Release metadata or signature evidence is invalid.");
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
  {
    scope: "setup",
    name: records.find((record) => /Setup\.exe$/i.test(record.name))?.name,
  },
  { scope: "package", name: "chromecraft.exe" },
  { scope: "nupkg", name: "lib/net45/chromecraft.exe" },
];
if (
  requiredSignatures.some(
    (required) =>
      !required.name ||
      !signatures.files.some(
        (item) => item.scope === required.scope && item.name === required.name,
      ),
  )
) {
  throw new Error("Required release signature evidence is missing.");
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
const setupSignature = signatures.files.find((item) => item.scope === "setup");
if (setupSignature.sha256 !== actualDigests.get(setupSignature.name)) {
  throw new Error(
    "The setup executable does not match its signature evidence.",
  );
}

console.log(
  `Verified ${records.length} release artifacts for ${metadata.version}.`,
);
