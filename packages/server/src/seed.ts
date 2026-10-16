import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  audit,
  setEntitlements,
  upsertOrg,
  upsertReader,
  upsertRepo,
  withTransaction,
  type Pool,
} from '@opend/store';
import { entitlementsSchema } from './admin.js';

const seedSchema = z.object({
  repos: z
    .array(
      z.object({
        fullName: z.string().min(1),
        sourceUrl: z.string().min(1),
        installationId: z.number().int().positive().optional(),
        releaseRefs: z.array(z.string().min(1)).optional(),
        docsPath: z.string().optional(),
      }),
    )
    .default([]),
  orgs: z
    .array(
      z.object({
        slug: z.string().min(1),
        name: z.string().min(1),
        entitlements: entitlementsSchema.optional(),
        readers: z
          .array(z.union([z.email(), z.object({ email: z.email(), name: z.string().optional() })]))
          .default([]),
      }),
    )
    .default([]),
});

export type SeedFile = z.infer<typeof seedSchema>;

/** Loads repos, orgs, entitlements and readers from YAML, in one transaction. Idempotent. */
export async function applySeed(
  pool: Pool,
  source: string,
): Promise<{ repos: number; orgs: number; readers: number }> {
  const parsed = seedSchema.safeParse(parseYaml(source));
  if (!parsed.success) {
    throw new Error(
      `invalid seed file:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  const seed = parsed.data;
  let readers = 0;
  await withTransaction(pool, async (db) => {
    for (const repo of seed.repos) await upsertRepo(db, repo);
    for (const org of seed.orgs) {
      await upsertOrg(db, org);
      if (org.entitlements) await setEntitlements(db, org.slug, org.entitlements);
      for (const r of org.readers) {
        const reader = typeof r === 'string' ? { email: r } : r;
        await upsertReader(db, {
          orgSlug: org.slug,
          email: reader.email,
          name: reader.name ?? null,
        });
        readers++;
      }
    }
    await audit(db, 'seed', 'seed.apply', {
      repos: seed.repos.length,
      orgs: seed.orgs.length,
      readers,
    });
  });
  return { repos: seed.repos.length, orgs: seed.orgs.length, readers };
}
