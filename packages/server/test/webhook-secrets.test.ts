import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRET, SETTING, putSecret, putSetting, testDatabaseUrl } from '@opend/store';
import { webhookSecrets } from '../src/index.js';
import { WEBHOOK_SECRET, pushPayload, startHarness, webhook, type Harness } from './helpers.js';

const url = testDatabaseUrl();

describe('webhookSecrets', () => {
  it('lists the environment secret and a different console app secret', () => {
    expect(webhookSecrets({})).toEqual([]);
    expect(webhookSecrets({ webhookSecret: 'env' })).toEqual(['env']);
    expect(webhookSecrets({ webhookSecret: 'env', appWebhookSecret: 'app' })).toEqual([
      'env',
      'app',
    ]);
  });
});

// A managed site gets GITHUB_WEBHOOK_SECRET from its host, while a GitHub App
// created in its console signs pushes with that app's own secret.
describe.skipIf(!url)('webhooks with an environment secret and a console app', () => {
  let h: Harness;
  const APP_SECRET = 'console-app-webhook-secret';
  const push = () => pushPayload('acme/docs', 'refs/heads/main', randomBytes(20).toString('hex'));

  beforeAll(async () => {
    h = await startHarness(url!);
    const box = h.ctx.settings.secretBox!;
    await putSetting(
      h.db.pool,
      SETTING.githubApp,
      { appId: '42', slug: 'acme-docs', name: 'Acme docs', clientId: 'Iv1.acme' },
      'test',
    );
    await putSecret(h.db.pool, box, SECRET.githubPrivateKey, 'pem', 'test');
    await putSecret(h.db.pool, box, SECRET.githubWebhookSecret, APP_SECRET, 'test');
    await h.ctx.reloadSettings();
  });
  afterAll(async () => h?.close());

  it('accepts pushes signed by the console app', async () => {
    expect(h.ctx.config.webhookSecret).toBe(WEBHOOK_SECRET);
    const res = await webhook(h.app, push(), { secret: APP_SECRET });
    expect(res.statusCode).not.toBe(401);
  });

  it('still accepts the environment secret, and refuses any other', async () => {
    expect((await webhook(h.app, push())).statusCode).not.toBe(401);
    expect((await webhook(h.app, push(), { secret: 'wrong' })).statusCode).toBe(401);
  });
});
