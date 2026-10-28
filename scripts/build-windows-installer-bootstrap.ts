import { execFile } from "node:child_process";
import {
  appendFile,
  copyFile,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function wrapWindowsInstaller(setupPath: string): Promise<void> {
  const source = path.resolve(
    "installer/windows/ChromecraftInstallerBootstrap.cs",
  );
  const icon = path.resolve("resources/icons/chromecraft.ico");
  const outputDirectory = path.dirname(setupPath);
  const rawSetupPath = path.join(
    outputDirectory,
    "ChromecraftSquirrelSetup.exe",
  );
  const bootstrapPath = path.join(
    outputDirectory,
    "ChromecraftInstallerBootstrap.exe",
  );
  const csc = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );

  await rm(rawSetupPath, { force: true });
  await rm(bootstrapPath, { force: true });
  await rename(setupPath, rawSetupPath);

  try {
    await execFileAsync(csc, [
      "/nologo",
      "/target:winexe",
      "/optimize+",
      `/win32icon:${icon}`,
      `/out:${bootstrapPath}`,
      "/reference:System.dll",
      "/reference:System.Core.dll",
      "/reference:System.Drawing.dll",
      "/reference:System.Windows.Forms.dll",
      source,
    ]);

    const payloadSize = (await stat(rawSetupPath)).size;
    const footer = Buffer.alloc(8);
    footer.writeBigInt64LE(BigInt(payloadSize));
    await copyFile(bootstrapPath, setupPath);
    await appendFile(setupPath, await readFile(rawSetupPath));
    await appendFile(setupPath, footer);
  } catch (error) {
    await rm(setupPath, { force: true });
    await rename(rawSetupPath, setupPath);
    throw error;
  } finally {
    await rm(rawSetupPath, { force: true });
    await rm(bootstrapPath, { force: true });
  }
}
