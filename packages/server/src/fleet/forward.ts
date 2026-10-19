import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * A host the fleet answers for without serving it: requests are passed to the
 * upstream (a dedicated instance's own address) unchanged except for the
 * forwarding headers. The fleet holds the wildcard domain, so this is how a
 * dedicated site gets an address under it before it has a domain of its own.
 */
export interface Forward {
  host: string;
  /** The upstream's origin, such as `https://acme-web.up.railway.app`. */
  upstream: string;
}

/** Headers that describe one connection and must not be passed on. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** How long an upstream may take to start answering. */
const UPSTREAM_TIMEOUT_MS = 60_000;

export function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  forward: Forward,
  onError: (err: Error) => void,
): void {
  const upstream = new URL(forward.upstream);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === 'host') continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  headers['x-forwarded-host'] = forward.host;
  headers['x-forwarded-proto'] = 'https';
  const client = req.socket.remoteAddress;
  const prior = req.headers['x-forwarded-for'];
  if (!prior && client) headers['x-forwarded-for'] = client;

  const send = upstream.protocol === 'http:' ? httpRequest : httpsRequest;
  const out = send(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: req.method,
      path: req.url ?? '/',
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (answer) => {
      const back: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        back[name] = value;
      }
      // Redirects the upstream builds from its own address go back to the public one.
      const location = back.location;
      if (typeof location === 'string' && location.startsWith(upstream.origin))
        back.location = `https://${forward.host}${location.slice(upstream.origin.length)}`;
      res.writeHead(answer.statusCode ?? 502, back);
      answer.pipe(res);
    },
  );
  out.on('timeout', () => out.destroy(new Error('upstream timed out')));
  out.on('error', onError);
  req.on('aborted', () => out.destroy());
  req.pipe(out);
}
