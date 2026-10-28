import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { wrapWindowsInstaller } from "./scripts/build-windows-installer-bootstrap";

const execFileAsync = promisify(execFile);
const installerLoadingGif = path.resolve(
  "resources/installer/chromecraft-vanilla-installing.gif",
);
const signingCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE?.trim();
const signingCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;

if (Boolean(signingCertificateFile) !== Boolean(signingCertificatePassword)) {
  throw new Error(
    "Windows signing requires both WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD.",
  );
}

const windowsSigning =
  signingCertificateFile && signingCertificatePassword
    ? {
        certificateFile: signingCertificateFile,
        certificatePassword: signingCertificatePassword,
        hash: "sha256" as const,
      }
    : undefined;

async function verifyInstallerArtwork(): Promise<void> {
  const artwork = await readFile(installerLoadingGif);
  const signature = artwork.subarray(0, 6).toString("ascii");
  const width = artwork.readUInt16LE(6);
  const height = artwork.readUInt16LE(8);

  if (
    (signature !== "GIF87a" && signature !== "GIF89a") ||
    width !== 268 ||
    height !== 167
  ) {
    throw new Error(
      "The Squirrel loading animation must be a 268x167 GIF so Windows does not crop it.",
    );
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon:
      process.platform === "win32"
        ? path.resolve("resources/icons/chromecraft.ico")
        : path.resolve("resources/icons/chromecraft.png"),
    extraResource: [
      "resources/extensions",
      "resources/icons",
      "resources/media-tools",
    ],
    executableName: "chromecraft",
    ...(windowsSigning ? { windowsSign: windowsSigning } : {}),
  },
  hooks: {
    generateAssets: async (_forgeConfig, platform, arch) => {
      if (platform === "win32") {
        await verifyInstallerArtwork();
      }
      await execFileAsync(process.execPath, [
        path.resolve("scripts/prepare-media-tools.mjs"),
        platform,
        arch,
      ]);
    },
    postMake: async (_forgeConfig, makeResults) => {
      for (const result of makeResults) {
        if (result.platform !== "win32") continue;
        const setupPath = result.artifacts.find(
          (artifact) => path.basename(artifact) === "ChromecraftSetup.exe",
        );
        if (setupPath) await wrapWindowsInstaller(setupPath);
      }
    },
  },
  makers: [
    new MakerSquirrel(
      {
        name: "Chromecraft",
        authors: "Chromecraft contributors",
        description:
          "A dependable, local-first Electron browser for Windows and Linux.",
        setupExe: "ChromecraftSetup.exe",
        setupIcon: path.resolve("resources/icons/chromecraft.ico"),
        loadingGif: installerLoadingGif,
        noMsi: true,
        ...(windowsSigning
          ? {
              certificateFile: windowsSigning.certificateFile,
              certificatePassword: windowsSigning.certificatePassword,
            }
          : {}),
      },
      ["win32"],
    ),
    new MakerZIP({}, ["win32", "linux"]),
    new MakerDeb(
      {
        options: {
          name: "chromecraft",
          productName: "Chromecraft",
          icon: path.resolve("resources/icons/chromecraft.png"),
          categories: ["Network"],
        },
      },
      ["linux"],
    ),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/preload/page-preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/preload/performance-centre-preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/preload/smart-reader-preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/preload/extension-service-worker-preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/preload/extension-network-observer-preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/preload/extension-frame-preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
