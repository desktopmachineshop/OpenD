import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SECRET,
  SETTING,
  SecretBox,
  deleteSetting,
  deriveSecretKey,
  putSecret,
  putSetting,
  testDatabaseUrl,
} from '@opend/store';
import { REPO, signInGitHub, startEditor, type Harness } from './helpers.js';

const url = testDatabaseUrl();
const SESSION_SECRET = 'docs-site-session-secret-0123456789abcdef';

describe.skipIf(!url)('the editor with GitHub connected in the admin console', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('uses the stored app for author sign-in and commits, and follows changes', async () => {
    const key = deriveSecretKey({ sessionSecret: SESSION_SECRET })!;
    h = await startEditor(url!, {
      config: { github: undefined, githubOAuth: undefined, secretKey: key },
    });
    // Nothing connected yet: no GitHub sign-in, no installation tokens.
    expect(h.ctx.github.mode()).toBe('none');
    let login = await h.app.inject({ method: 'GET', url: '/auth/login' });
    expect(login.body).not.toContain('Sign in with GitHub');

    // What Connect GitHub stores on the docs site (same database, same key).
    const box = new SecretBox(key);
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString();
    await putSetting(
      h.db.pool,
      SETTING.githubApp,
      {
        appId: '1001',
        slug: 'acme-docs',
        name: 'Acme docs',
        clientId: 'Iv1.acme-docs',
        htmlUrl: `${h.gh.webUrl}/apps/acme-docs`,
        owner: 'acme',
        webUrl: h.gh.webUrl,
        apiUrl: h.gh.apiUrl,
        createdAt: new Date().toISOString(),
      },
      'test',
    );
    await putSecret(h.db.pool, box, SECRET.githubPrivateKey, privateKey, 'test');
    await putSecret(h.db.pool, box, SECRET.githubClientSecret, 'client-secret', 'test');
    // The editor listens: no restart.
    await expect.poll(() => h.ctx.github.mode(), { timeout: 15_000 }).toBe('stored');
    login = await h.app.inject({ method: 'GET', url: '/auth/login' });
    expect(login.body).toContain('Sign in with GitHub');

    h.gh.setCollaborator(REPO, 'ada', 'write');
    const ada = await signInGitHub(h, {
      id: 1,
      login: 'ada',
      name: 'Ada',
      email: 'ada@example.com',
    });
    expect(ada.session).toBeDefined();
    const files = await h.app.inject({
      method: 'GET',
      url: '/edit?path=topics/install.dita',
      headers: { cookie: ada.session!.cookie },
    });
    expect(files.statusCode).toBe(200);
    // Commits go through the stored app's installation token.
    expect(h.gh.requests).toContain('POST /app/installations/42/access_tokens');

    // Disconnecting on the docs site turns GitHub sign-in off here too.
    await deleteSetting(h.db.pool, SETTING.githubApp);
    await expect.poll(() => h.ctx.github.mode(), { timeout: 15_000 }).toBe('none');
    login = await h.app.inject({ method: 'GET', url: '/auth/login' });
    expect(login.body).not.toContain('Sign in with GitHub');
  });

  it('cannot open secrets sealed with another key', async () => {
    const key = deriveSecretKey({ sessionSecret: SESSION_SECRET })!;
    h = await startEditor(url!, {
      config: {
        github: undefined,
        githubOAuth: undefined,
        secretKey: deriveSecretKey({ sessionSecret: `${SESSION_SECRET}-other` }),
      },
    });
    await putSetting(h.db.pool, SETTING.githubApp, { appId: '1', clientId: 'x' }, 'test');
    await putSecret(h.db.pool, new SecretBox(key), SECRET.githubPrivateKey, 'pem', 'test');
    await h.ctx.settings!.reload();
    expect(h.ctx.settings!.current.unreadable).toEqual([SECRET.githubPrivateKey]);
    expect(h.ctx.github.mode()).toBe('none');
  });
});
