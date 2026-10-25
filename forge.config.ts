import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  },
  hooks: {
    generateAssets: async (_forgeConfig, platform, arch) => {
      await execFileAsync(process.execPath, [
        path.resolve("scripts/prepare-media-tools.mjs"),
        platform,
        arch,
      ]);
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
        noMsi: true,
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
