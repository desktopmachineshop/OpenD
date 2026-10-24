import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  audit,
  setEntitlements,
  setRepoAccess,
  upsertOrg,
  upsertReader,
  upsertRepo,
  withTransaction,
  type Pool,
} from '@opend/store';
import { RELEASE_LINES } from '@opend/model';
import { changeReleaseLines, entitlementsSchema } from './admin.js';

const seedSchema = z.object({
  repos: z
    .array(
      z.object({
        fullName: z.string().min(1),
        sourceUrl: z.string().min(1),
        installationId: z.number().int().positive().optional(),
        releaseRefs: z.array(z.string().min(1)).optional(),
        docsPath: z.string().optional(),
        /** Omitted: keep the repo's current access (new repos: private). */
        access: z.enum(['private', 'public']).optional(),
        publicEntitlements: entitlementsSchema.nullable().optional(),
        /** Omitted: keep the repo's release lines (new repos: major). */
        releaseLines: z.enum(RELEASE_LINES).optional(),
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
          .array(
            z.union([
              z.email(),
              z.object({
                email: z.email(),
                name: z.string().optional(),
                staff: z.boolean().optional(),
              }),
            ]),
          )
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
    for (const { access, publicEntitlements, releaseLines, ...input } of seed.repos) {
      const repo = await upsertRepo(db, input);
      if (releaseLines) await changeReleaseLines(db, repo.id, releaseLines, 'seed');
      if (access)
        await setRepoAccess(
          db,
          repo.id,
          access,
          publicEntitlements === undefined ? repo.publicEntitlements : publicEntitlements,
        );
    }
    for (const org of seed.orgs) {
      await upsertOrg(db, org);
      if (org.entitlements) await setEntitlements(db, org.slug, org.entitlements);
      for (const r of org.readers) {
        const reader: { email: string; name?: string; staff?: boolean } =
          typeof r === 'string' ? { email: r } : r;
        await upsertReader(db, {
          orgSlug: org.slug,
          email: reader.email,
          name: reader.name ?? null,
          ...(reader.staff === undefined ? {} : { staff: reader.staff }),
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
