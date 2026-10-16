import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S3BlobStore, contentTypeForKey, type S3BlobStoreOptions } from '../src/index.js';

interface StoredObject {
  body: Buffer;
  contentType: string | undefined;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

/** Minimal path-style S3: PUT, GET and HEAD on /<bucket>/<key>. */
function fakeS3(bucket: string) {
  const objects = new Map<string, StoredObject>();
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      requests.push({ method, url: url.pathname, headers: req.headers });
      const [, b, ...rest] = url.pathname.split('/');
      const key = rest.map((p) => decodeURIComponent(p)).join('/');
      if (b !== bucket || !key) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code>' +
            '<Message>The specified bucket does not exist</Message></Error>',
        );
        return;
      }
      if (method === 'PUT') {
        objects.set(key, { body: Buffer.concat(chunks), contentType: req.headers['content-type'] });
        res.writeHead(200, { etag: '"etag"' });
        res.end();
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        const obj = objects.get(key);
        if (!obj) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          res.end(
            method === 'HEAD'
              ? undefined
              : '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code>' +
                  '<Message>The specified key does not exist.</Message>' +
                  `<Key>${key}</Key><RequestId>test</RequestId></Error>`,
          );
          return;
        }
        res.writeHead(200, {
          'content-type': obj.contentType ?? 'application/octet-stream',
          'content-length': String(obj.body.length),
          etag: '"etag"',
        });
        res.end(method === 'HEAD' ? undefined : obj.body);
        return;
      }
      if (method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  return { server, objects, requests };
}

describe('S3BlobStore', () => {
  const fake = fakeS3('docs');
  let options: S3BlobStoreOptions;
  const stores: S3BlobStore[] = [];
  const store = (extra: Partial<S3BlobStoreOptions> = {}) => {
    const s = new S3BlobStore({ ...options, ...extra });
    stores.push(s);
    return s;
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    const { port } = fake.server.address() as AddressInfo;
    options = {
      endpoint: `http://127.0.0.1:${port}`,
      bucket: 'docs',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      forcePathStyle: true,
    };
  });
  afterAll(async () => {
    for (const s of stores) s.destroy();
    await new Promise<void>((resolve, reject) =>
      (fake.server as Server).close((err) => (err ? reject(err) : resolve())),
    );
  });
  beforeEach(() => {
    fake.objects.clear();
    fake.requests.length = 0;
  });

  it('round-trips blobs with a signed, typed PUT', async () => {
    const blobs = store();
    await blobs.put('repos/1/abc/images/a.svg', Buffer.from('<svg/>'));
    expect((await blobs.get('repos/1/abc/images/a.svg'))?.toString()).toBe('<svg/>');

    expect(fake.objects.get('repos/1/abc/images/a.svg')?.contentType).toBe('image/svg+xml');
    const put = fake.requests.find((r) => r.method === 'PUT');
    expect(put?.url).toBe('/docs/repos/1/abc/images/a.svg');
    expect(put?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-key\/\d{8}\/auto\/s3\/aws4_request, /,
    );
    const get = fake.requests.find((r) => r.method === 'GET');
    expect(get?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('stores binary data byte for byte and falls back to octet-stream', async () => {
    const blobs = store();
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
    await blobs.put('repos/1/abc/data.bin', bytes);
    expect(await blobs.get('repos/1/abc/data.bin')).toEqual(bytes);
    expect(fake.objects.get('repos/1/abc/data.bin')?.contentType).toBe('application/octet-stream');
  });

  it('returns null for a missing key', async () => {
    expect(await store().get('repos/1/abc/missing.png')).toBeNull();
  });

  it('rethrows errors other than a missing key', async () => {
    await expect(store({ bucket: 'other' }).get('repos/1/abc/a.png')).rejects.toMatchObject({
      name: 'NoSuchBucket',
    });
  });

  it('applies the key prefix', async () => {
    const blobs = store({ prefix: '/opend/prod/' });
    await blobs.put('repos/2/def/theme/brand.css', Buffer.from('body{}'));
    expect([...fake.objects.keys()]).toEqual(['opend/prod/repos/2/def/theme/brand.css']);
    expect(fake.objects.get('opend/prod/repos/2/def/theme/brand.css')?.contentType).toMatch(
      /^text\/css/,
    );
    expect((await blobs.get('repos/2/def/theme/brand.css'))?.toString()).toBe('body{}');
    expect(await store().get('repos/2/def/theme/brand.css')).toBeNull();
    expect(() => store({ prefix: '../escape' })).toThrow(/unsafe/);
  });

  it('rejects unsafe keys before any request', async () => {
    const blobs = store();
    for (const key of ['../x', '/etc/passwd', 'a//b', 'a\\b', 'a/./b', '']) {
      await expect(blobs.put(key, Buffer.from('x'))).rejects.toThrow(/unsafe/);
      await expect(blobs.get(key)).rejects.toThrow(/unsafe/);
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe('contentTypeForKey', () => {
  it.each([
    ['a/b.svg', 'image/svg+xml'],
    ['a/b.PNG', 'image/png'],
    ['a/b.jpg', 'image/jpeg'],
    ['a/b.jpeg', 'image/jpeg'],
    ['a/b.gif', 'image/gif'],
    ['a/b.webp', 'image/webp'],
    ['a/b.pdf', 'application/pdf'],
    ['a/b.json', 'application/json'],
    ['a/b.css', 'text/css; charset=utf-8'],
    ['a/b.dita', 'application/octet-stream'],
    ['a/.svg', 'application/octet-stream'],
    ['a/noext', 'application/octet-stream'],
  ])('%s → %s', (key, expected) => {
    expect(contentTypeForKey(key)).toBe(expected);
  });
});
