import { z } from 'zod';
import type { SyncMode } from '@opend/store';

/**
 * Environment settings for polling and entitlement sync, kept apart from the
 * core settings in config.ts and spread into its schema.
 */
export const selfHostingEnv = {
  POLL_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .refine((v) => v === 0 || v >= 10, 'POLL_INTERVAL_SECONDS must be 0 (off) or at least 10')
    .default(0),
  ENTITLEMENT_WEBHOOK_SECRET: z
    .string()
    .min(32, 'ENTITLEMENT_WEBHOOK_SECRET must be at least 32 characters')
    .optional(),
  ENTITLEMENT_SOURCE_URL: z.url('ENTITLEMENT_SOURCE_URL must be an http(s) URL').optional(),
  ENTITLEMENT_SOURCE_TOKEN: z.string().min(1).optional(),
  ENTITLEMENT_SYNC_MODE: z
    .enum(['merge', 'replace'], 'ENTITLEMENT_SYNC_MODE must be merge or replace')
    .default('merge'),
};

export interface SelfHostingConfig {
  /** Seconds between polls of each repo's release refs; 0 turns polling off. */
  pollIntervalSeconds: number;
  /** HMAC secret for `POST /webhooks/entitlements`; the endpoint is off without it. */
  entitlementWebhookSecret?: string;
  /** The CRM or billing export `opend-server reconcile` reads by default. */
  entitlementSource?: { url: string; token?: string };
  /** How `reconcile` applies the export unless `--mode` says otherwise. */
  entitlementSyncMode: SyncMode;
}

type SelfHostingEnv = z.infer<z.ZodObject<typeof selfHostingEnv>>;

export function selfHostingConfig(e: SelfHostingEnv): SelfHostingConfig {
  const config: SelfHostingConfig = {
    pollIntervalSeconds: e.POLL_INTERVAL_SECONDS,
    entitlementSyncMode: e.ENTITLEMENT_SYNC_MODE,
  };
  if (e.ENTITLEMENT_WEBHOOK_SECRET) config.entitlementWebhookSecret = e.ENTITLEMENT_WEBHOOK_SECRET;
  if (e.ENTITLEMENT_SOURCE_URL) {
    config.entitlementSource = { url: e.ENTITLEMENT_SOURCE_URL };
    if (e.ENTITLEMENT_SOURCE_TOKEN) config.entitlementSource.token = e.ENTITLEMENT_SOURCE_TOKEN;
  }
  return config;
}
