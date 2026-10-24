import { promises as fs } from "node:fs";
import path from "node:path";

interface ReadingPosition {
  url: string;
  progress: number;
  updatedAt: number;
}

interface ReadingPositionDocument {
  version: 1;
  positions: ReadingPosition[];
}

const MAX_POSITIONS = 500;

function normalizedUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export class ReadingPositionStore {
  private positions: ReadingPosition[] = [];
  private queue: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as {
        version?: unknown;
        positions?: unknown;
      };
      if (raw.version !== 1 || !Array.isArray(raw.positions)) return;
      const seen = new Set<string>();
      this.positions = raw.positions
        .map((value): ReadingPosition | null => {
          if (!value || typeof value !== "object") return null;
          const source = value as Partial<ReadingPosition>;
          const url = normalizedUrl(source.url);
          const progress = Number(source.progress);
          const updatedAt = Number(source.updatedAt);
          if (
            !url ||
            !Number.isFinite(progress) ||
            !Number.isSafeInteger(updatedAt) ||
            updatedAt < 0 ||
            seen.has(url)
          ) {
            return null;
          }
          seen.add(url);
          return {
            url,
            progress: Math.min(1, Math.max(0, progress)),
            updatedAt,
          };
        })
        .filter((value): value is ReadingPosition => value !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_POSITIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not read Smart Reader positions.", error);
      }
      this.positions = [];
    }
  }

  get(url: string): number | null {
    const normalized = normalizedUrl(url);
    return normalized
      ? (this.positions.find((entry) => entry.url === normalized)?.progress ??
          null)
      : null;
  }

  async set(url: string, progress: number): Promise<void> {
    const normalized = normalizedUrl(url);
    if (!normalized || !Number.isFinite(progress)) {
      throw new TypeError("Reading progress is invalid.");
    }
    const bounded = Math.min(1, Math.max(0, progress));
    const operation = this.queue.then(async () => {
      this.positions = [
        { url: normalized, progress: bounded, updatedAt: Date.now() },
        ...this.positions.filter((entry) => entry.url !== normalized),
      ].slice(0, MAX_POSITIONS);
      const document: ReadingPositionDocument = {
        version: 1,
        positions: this.positions,
      };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${++this.counter}.tmp`;
      try {
        await fs.writeFile(
          temporaryPath,
          `${JSON.stringify(document, null, 2)}\n`,
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          },
        );
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}
