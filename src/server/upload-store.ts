import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type UploadLimits = {
  maxFileBytes: number;
  maxRequestBytes: number;
  maxFiles: number;
  maxDiskBytes: number;
  ttlMs: number;
  maxConcurrentRequests: number;
};

export type UploadPart = {
  filename?: string;
  file: Readable & { truncated?: boolean };
};

export type StoredUpload = {
  label: string;
  path: string;
  fsPath: string;
};

type StoredFile = {
  bytes: number;
  timer: NodeJS.Timeout;
};

export class UploadLimitError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 413) {
    super(message);
    this.name = "UploadLimitError";
    this.statusCode = statusCode;
  }
}

export function parsePositiveInteger(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return parsed;
}

export class UploadStore {
  private readonly files = new Map<string, StoredFile>();
  private storedBytes = 0;
  private inFlightBytes = 0;
  private activeRequests = 0;

  private constructor(
    private readonly root: string,
    private readonly limits: UploadLimits,
  ) {}

  static async create(
    limits: UploadLimits,
    parentDirectory = os.tmpdir(),
  ): Promise<UploadStore> {
    await fs.mkdir(parentDirectory, { recursive: true, mode: 0o700 });
    const root = await fs.mkdtemp(
      path.join(parentDirectory, "codex-web-uploads-"),
    );
    await fs.chmod(root, 0o700);
    return new UploadStore(root, limits);
  }

  async saveParts(parts: AsyncIterable<UploadPart>): Promise<StoredUpload[]> {
    if (this.activeRequests >= this.limits.maxConcurrentRequests) {
      throw new UploadLimitError(
        `more than ${this.limits.maxConcurrentRequests} uploads are already in progress`,
        429,
      );
    }
    this.activeRequests += 1;

    const uploads: StoredUpload[] = [];
    const committedPaths: string[] = [];
    const requestState = { bytes: 0, files: 0 };

    try {
      for await (const part of parts) {
        requestState.files += 1;
        if (requestState.files > this.limits.maxFiles) {
          throw new UploadLimitError(
            `upload contains more than ${this.limits.maxFiles} files`,
          );
        }

        const stored = await this.savePart(part, requestState);
        committedPaths.push(stored.fsPath);
        uploads.push(stored);
      }
      return uploads;
    } catch (error) {
      await Promise.all(committedPaths.map((filePath) => this.remove(filePath)));
      throw error;
    } finally {
      this.activeRequests -= 1;
    }
  }

  async dispose(): Promise<void> {
    for (const file of this.files.values()) {
      clearTimeout(file.timer);
    }
    this.files.clear();
    this.storedBytes = 0;
    this.inFlightBytes = 0;
    this.activeRequests = 0;
    await fs.rm(this.root, { recursive: true, force: true });
  }

  usage(): {
    storedBytes: number;
    inFlightBytes: number;
    files: number;
    activeRequests: number;
  } {
    return {
      storedBytes: this.storedBytes,
      inFlightBytes: this.inFlightBytes,
      files: this.files.size,
      activeRequests: this.activeRequests,
    };
  }

  private async savePart(
    part: UploadPart,
    requestState: { bytes: number },
  ): Promise<StoredUpload> {
    const uploadedPath = path.join(this.root, randomUUID());
    let fileBytes = 0;
    let committed = false;

    const meter = new Transform({
      transform: (chunk: Buffer | string, encoding, callback) => {
        const bytes =
          typeof chunk === "string"
            ? Buffer.byteLength(chunk, encoding as BufferEncoding)
            : chunk.byteLength;

        if (fileBytes + bytes > this.limits.maxFileBytes) {
          callback(
            new UploadLimitError(
              `file exceeds ${this.limits.maxFileBytes} byte limit`,
            ),
          );
          return;
        }
        if (requestState.bytes + bytes > this.limits.maxRequestBytes) {
          callback(
            new UploadLimitError(
              `upload exceeds ${this.limits.maxRequestBytes} byte request limit`,
            ),
          );
          return;
        }
        if (
          this.storedBytes + this.inFlightBytes + bytes >
          this.limits.maxDiskBytes
        ) {
          callback(
            new UploadLimitError(
              `upload storage exceeds ${this.limits.maxDiskBytes} byte quota`,
              507,
            ),
          );
          return;
        }

        fileBytes += bytes;
        requestState.bytes += bytes;
        this.inFlightBytes += bytes;
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        part.file,
        meter,
        createWriteStream(uploadedPath, { flags: "wx", mode: 0o600 }),
      );
      if (part.file.truncated) {
        throw new UploadLimitError(
          `file exceeds ${this.limits.maxFileBytes} byte limit`,
        );
      }

      this.inFlightBytes -= fileBytes;
      this.storedBytes += fileBytes;
      committed = true;

      const timer = setTimeout(() => {
        void this.remove(uploadedPath);
      }, this.limits.ttlMs);
      timer.unref();
      this.files.set(uploadedPath, { bytes: fileBytes, timer });

      return {
        label: part.filename?.trim() || "upload",
        path: uploadedPath,
        fsPath: uploadedPath,
      };
    } finally {
      if (!committed) {
        this.inFlightBytes -= fileBytes;
        await fs.rm(uploadedPath, { force: true });
      }
    }
  }

  private async remove(filePath: string): Promise<void> {
    const file = this.files.get(filePath);
    if (file) {
      clearTimeout(file.timer);
      this.files.delete(filePath);
      this.storedBytes = Math.max(0, this.storedBytes - file.bytes);
    }
    await fs.rm(filePath, { force: true });
  }
}
