import { promises as fs } from "node:fs";
import path from "node:path";

import { safeStorage } from "electron";

export class GeminiCredentialStore {
  private sessionKey: string | null = null;

  constructor(private readonly filePath: string) {}

  get secureStorageAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform !== "linux") return true;
    const backend = safeStorage.getSelectedStorageBackend();
    return backend !== "basic_text" && backend !== "unknown";
  }

  async get(): Promise<string | null> {
    if (this.sessionKey) return this.sessionKey;
    if (!this.secureStorageAvailable) return null;
    try {
      const encoded = await fs.readFile(this.filePath, "utf8");
      return safeStorage.decryptString(Buffer.from(encoded.trim(), "base64"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not read the encrypted Gemini credential.", error);
      }
      return null;
    }
  }

  async set(apiKey: string, persist: boolean): Promise<void> {
    this.sessionKey = apiKey;
    if (!persist) {
      await fs.rm(this.filePath, { force: true });
      return;
    }
    if (!this.secureStorageAvailable) {
      throw new Error(
        "Secure credential storage is unavailable. Use the session-only option instead.",
      );
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(apiKey).toString("base64");
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${encrypted}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rm(this.filePath, { force: true });
    await fs.rename(temporary, this.filePath);
  }

  async remove(): Promise<void> {
    this.sessionKey = null;
    await fs.rm(this.filePath, { force: true });
  }
}
