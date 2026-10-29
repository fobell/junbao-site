import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rename, unlink, readdir, chown } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "./config.js";
export interface BlobStore {
  put(key: string, body: Buffer | Readable, mime: string): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  size(key: string): Promise<number>;
  keys(): AsyncGenerator<string>;
  cleanTemporary?(): Promise<void>;
}
export function checkKey(key: string) {
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((s) => !s || s === "." || s === "..") ||
    /[\x00-\x1f]/.test(key)
  )
    throw new Error("Invalid storage key");
  return key;
}
export class LocalStore implements BlobStore {
  constructor(public root = join(config.dataDir, "blobs")) {}
  path(key: string) {
    return resolve(this.root, checkKey(key));
  }
  async put(key: string, body: Buffer | Readable) {
    const path = this.path(key);
    const firstCreated = await mkdir(dirname(path), { recursive: true });
    const owner =
      process.getuid?.() === 0 && process.env.BLOB_OWNER_UID
        ? Number(process.env.BLOB_OWNER_UID)
        : undefined;
    const group = Number(process.env.BLOB_OWNER_GID ?? owner);
    if (owner !== undefined && firstCreated) {
      let dir = dirname(path);
      while (dir.startsWith(firstCreated)) {
        await chown(dir, owner, group);
        if (dir === firstCreated) break;
        dir = dirname(dir);
      }
    }
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      await pipeline(
        Buffer.isBuffer(body) ? Readable.from(body) : body,
        createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
      );
      await rename(tmp, path);
      if (owner !== undefined) await chown(path, owner, group);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
  async get(key: string) {
    const path = this.path(key);
    await stat(path);
    return createReadStream(path);
  }
  async remove(key: string) {
    await unlink(this.path(key)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  async size(key: string) {
    return (await stat(this.path(key))).size;
  }
  async *keys(): AsyncGenerator<string> {
    const walk = async function* (
      root: string,
      prefix = "",
    ): AsyncGenerator<string> {
      for (const file of await readdir(join(root, prefix), {
        withFileTypes: true,
      }).catch((e) => {
        if (e.code === "ENOENT") return [];
        throw e;
      })) {
        const key = prefix ? `${prefix}/${file.name}` : file.name;
        if (file.isDirectory()) yield* walk(root, key);
        else if (!file.name.includes(".tmp-")) yield key;
      }
    };
    yield* walk(this.root);
  }
  async cleanTemporary() {
    const walk = async (root: string) => {
      for (const f of await readdir(root, { withFileTypes: true }).catch(
        () => [],
      )) {
        const path = join(root, f.name);
        if (f.isDirectory()) await walk(path);
        else if (
          f.name.includes(".tmp-") &&
          (await stat(path)).mtimeMs < Date.now() - 86400000
        )
          await unlink(path).catch(() => {});
      }
    };
    await walk(this.root);
  }
}
export class S3Store implements BlobStore {
  client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: config.s3PathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3Secret,
    },
  });
  async put(key: string, body: Buffer | Readable, mime: string) {
    await new Upload({
      client: this.client,
      params: {
        Bucket: config.s3Bucket,
        Key: checkKey(key),
        Body: body,
        ContentType: mime,
      },
      queueSize: 2,
      partSize: 8 * 1024 ** 2,
      leavePartsOnError: false,
    }).done();
  }
  async get(key: string) {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: config.s3Bucket, Key: checkKey(key) }),
    );
    return r.Body as Readable;
  }
  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: checkKey(key) }),
    );
  }
  async size(key: string) {
    return (
      (
        await this.client.send(
          new HeadObjectCommand({
            Bucket: config.s3Bucket,
            Key: checkKey(key),
          }),
        )
      ).ContentLength ?? 0
    );
  }
  async *keys() {
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: config.s3Bucket,
          ContinuationToken: token,
        }),
      );
      for (const x of r.Contents ?? []) if (x.Key) yield x.Key;
      token = r.NextContinuationToken;
    } while (token);
  }
}
export const store: BlobStore =
  config.storageDriver === "s3" ? new S3Store() : new LocalStore();
