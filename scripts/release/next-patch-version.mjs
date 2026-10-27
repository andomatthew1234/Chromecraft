import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
  packageJson.version,
);

if (!match) {
  throw new Error(
    `The package version must be a stable semantic version; received ${JSON.stringify(packageJson.version)}.`,
  );
}

const patch = Number(match[3]);
if (!Number.isSafeInteger(patch + 1)) {
  throw new Error("The next patch version is outside the safe integer range.");
}

process.stdout.write(`${match[1]}.${match[2]}.${patch + 1}`);
