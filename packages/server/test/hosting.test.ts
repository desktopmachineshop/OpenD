import { describe, expect, it } from 'vitest';
import { HostingClient, HostingError } from '../src/index.js';

const URL_ = 'https://control.test/site/v1';
const TOKEN = 'hosting-token-0123456789';

describe('HostingClient: the site’s custom domain', () => {
  const answer = {
    site: 'acme',
    domain: 'docs.acme.example',
    status: 'awaiting-dns',
    records: [
      { type: 'CNAME', name: 'docs', value: 'x.up.railway.app', propagated: false },
      { type: 'TXT', name: '_railway-verify.docs.acme.example', value: 'v', propagated: true },
      { type: 'CNAME', name: 42, value: 'ignored' },
    ],
    checkedAt: '2026-10-25T10:00:00.000Z',
    defaultAddress: 'https://acme.opend.app',
    publicUrl: 'https://acme.opend.app',
    available: true,
    unavailableReason: null,
    error: null,
  };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, body });
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`)
      return new Response('{"error":"unauthorized"}', { status: 401 });
    const domain = (body as { domain?: string | null } | null)?.domain;
    if (domain === 'taken.example')
      return Response.json(
        { error: 'taken.example is already another site’s domain' },
        { status: 409 },
      );
    if (domain === 'boom.example') return Response.json({ error: 'internal' }, { status: 500 });
    return Response.json(answer);
  }) as typeof fetch;

  it('reads and sets the domain with the site’s token, keeping only known fields', async () => {
    const hosting = new HostingClient({ url: `${URL_}/`, token: TOKEN }, fetchImpl);
    const read = await hosting.domain();
    expect(read.status).toBe('awaiting-dns');
    expect(read.records).toEqual([
      { type: 'CNAME', name: 'docs', value: 'x.up.railway.app', propagated: false },
      { type: 'TXT', name: '_railway-verify.docs.acme.example', value: 'v', propagated: true },
    ]);
    expect(read).not.toHaveProperty('site');
    await hosting.setDomain('docs.acme.example', 'olive@acme.example');
    await hosting.setDomain(null);
    expect(calls).toEqual([
      { method: 'GET', path: '/site/v1/domain', body: null },
      {
        method: 'PUT',
        path: '/site/v1/domain',
        body: { domain: 'docs.acme.example', actor: 'olive@acme.example' },
      },
      { method: 'PUT', path: '/site/v1/domain', body: { domain: null } },
    ]);
  });

  it('passes on the host’s reason for a refusal, and nothing from a failure', async () => {
    const hosting = new HostingClient({ url: URL_, token: TOKEN }, fetchImpl);
    await expect(hosting.setDomain('taken.example')).rejects.toMatchObject({
      status: 409,
      message: 'taken.example is already another site’s domain',
    });
    await expect(hosting.setDomain('boom.example')).rejects.toMatchObject({
      status: 500,
      message: 'hosting request failed: 500',
    });
    const wrong = new HostingClient({ url: URL_, token: 'nope-nope-nope-nope' }, fetchImpl);
    await expect(wrong.domain()).rejects.toBeInstanceOf(HostingError);
    await expect(wrong.domain()).rejects.toMatchObject({ status: 401 });
  });
});
