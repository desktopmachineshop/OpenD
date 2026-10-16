import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { assertSafeKey, type BlobStore } from './blobs.js';

export interface S3BlobStoreOptions {
  /** Service URL, e.g. `https://t3.storageapi.dev` or `http://127.0.0.1:9000`. */
  endpoint: string;
  bucket: string;
  /** Defaults to `auto`, which most S3-compatible services accept. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Address the bucket as `/<bucket>/<key>` instead of `<bucket>.<host>`. Defaults to false. */
  forcePathStyle?: boolean;
  /** Prepended to every key, e.g. `opend/` to share a bucket. */
  prefix?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  css: 'text/css; charset=utf-8',
  pdf: 'application/pdf',
  json: 'application/json',
};

/** Content type for a key from its file extension, `application/octet-stream` when unknown. */
export function contentTypeForKey(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Blob store on any S3-compatible service (AWS S3, Railway buckets, R2, MinIO). */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = normalisePrefix(options.prefix);
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? 'auto',
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      // Only send/verify checksums when an operation requires them: not every
      // S3-compatible service supports the newer default integrity headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, data: Buffer): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: data,
        ContentType: contentTypeForKey(key),
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
      );
      if (!res.Body) return Buffer.alloc(0);
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Closes the client's sockets. */
  destroy(): void {
    this.client.destroy();
  }
}

function normalisePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  assertSafeKey(trimmed);
  return `${trimmed}/`;
}

/** A missing key; a missing bucket or any other failure is rethrown. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name } = err as { name?: unknown };
  // `NotFound` is how the SDK names a bodyless 404.
  return name === 'NoSuchKey' || name === 'NotFound';
}
