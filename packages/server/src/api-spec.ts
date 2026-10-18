/**
 * The OpenAPI 3.1 description of `/api/v1`, served at `/api/v1/openapi.json`
 * with the site's own server URL. A test checks every API route is described.
 */

const json = (schema: object) => ({ 'application/json': { schema } });
const ok = (description: string, schema: object) => ({
  description,
  content: json(schema),
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errors = {
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { $ref: '#/components/responses/Forbidden' },
  '429': { $ref: '#/components/responses/RateLimited' },
};
const versionParam = {
  name: 'version',
  in: 'query',
  required: false,
  description:
    'Release line to read, such as `2`. Staff keys only; org and public keys read their own line.',
  schema: { type: 'string' },
};
const refParam = {
  name: 'ref',
  in: 'query',
  required: false,
  description: '`base` (the published branch, default) or `working` (this key’s working branch).',
  schema: { type: 'string', enum: ['base', 'working'] },
};
const filesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: {
    type: 'object',
    required: ['path', 'content'],
    properties: {
      path: {
        type: 'string',
        description: 'Docs-relative path of a .dita, .ditamap or .bookmap file.',
      },
      content: { type: 'string' },
    },
  },
};
const filesBody = {
  required: true,
  content: json({ type: 'object', required: ['files'], properties: { files: filesSchema } }),
};

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'OpenD API',
    version: '1',
    description:
      'Read the docs as a key’s audience sees them, and propose changes to the docs source as pull requests. Every response is filtered for the key’s audience exactly as the site is. Keys are created by staff in the admin console (API & AI) or the admin API.',
  },
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'An API key, `opd_<prefix>_<secret>`, sent as `Authorization: Bearer <key>`.',
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing, invalid, revoked or expired key.',
        content: json(ref('Error')),
      },
      Forbidden: {
        description: 'The key lacks the scope, or its audience cannot read this.',
        content: json(ref('Error')),
      },
      RateLimited: {
        description: 'Over 300 requests a minute for this key; see Retry-After.',
        content: json(ref('Error')),
      },
    },
    schemas: {
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      Diagnostic: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['error', 'warning'] },
          code: { type: 'string' },
          message: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
        },
      },
      NavEntry: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          topicId: { type: 'string' },
          url: { type: 'string' },
          children: { type: 'array', items: { $ref: '#/components/schemas/NavEntry' } },
        },
      },
      Topic: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          version: { type: 'string' },
          title: { type: 'string' },
          shortdesc: { type: 'string' },
          source: { type: 'string', description: 'Source file of the topic.' },
          url: { type: 'string' },
          format: { type: 'string', enum: ['markdown', 'html', 'text'] },
          content: { type: 'string' },
        },
      },
      PullRequest: {
        type: ['object', 'null'],
        properties: {
          number: { type: 'integer' },
          url: { type: 'string' },
          state: { type: 'string', enum: ['open', 'closed'] },
          merged: { type: 'boolean' },
          title: { type: 'string' },
        },
      },
      Review: {
        type: 'object',
        properties: {
          blockers: { type: 'array', items: { type: 'string' } },
          canMerge: { type: 'boolean' },
          approvedBy: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  paths: {
    '/me': {
      get: {
        summary: 'The calling key: name, scopes, audience and expiry.',
        responses: { '200': ok('The key.', { type: 'object' }), ...errors },
      },
    },
    '/versions': {
      get: {
        summary: 'Live release lines this key can read, and the one it reads by default.',
        responses: { '200': ok('Release lines.', { type: 'object' }), ...errors },
      },
    },
    '/nav': {
      get: {
        summary: 'The navigation tree.',
        parameters: [versionParam],
        responses: {
          '200': ok('Navigation.', {
            type: 'object',
            properties: {
              version: { type: 'string' },
              title: { type: 'string' },
              nav: { type: 'array', items: ref('NavEntry') },
            },
          }),
          ...errors,
        },
      },
    },
    '/topics': {
      get: {
        summary: 'Every topic this key can read: id, title, short description and URL.',
        parameters: [versionParam],
        responses: { '200': ok('Topics.', { type: 'object' }), ...errors },
      },
    },
    '/topics/{id}': {
      get: {
        summary: 'One topic, as Markdown (default), HTML or plain text.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Topic id, such as `topics/install`.',
            schema: { type: 'string' },
          },
          {
            name: 'format',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['markdown', 'html', 'text'] },
          },
          versionParam,
        ],
        responses: {
          '200': ok('The topic.', ref('Topic')),
          '404': { description: 'No such topic for this key.' },
          ...errors,
        },
      },
    },
    '/search': {
      get: {
        summary: 'Full-text search over the topics this key can read.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 200 } },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
          versionParam,
        ],
        responses: { '200': ok('Hits, best first.', { type: 'object' }), ...errors },
      },
    },
    '/source/files': {
      get: {
        summary: 'Files in the docs source (scope: write).',
        parameters: [refParam],
        responses: { '200': ok('Paths and blob shas.', { type: 'object' }), ...errors },
      },
    },
    '/source/files/{path}': {
      get: {
        summary: 'One source file (scope: write).',
        parameters: [
          { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
          refParam,
        ],
        responses: {
          '200': ok('The file.', { type: 'object' }),
          '404': { description: 'No such file.' },
          ...errors,
        },
      },
    },
    '/validate': {
      post: {
        summary: 'Validates files laid over the working branch, without saving (scope: write).',
        requestBody: filesBody,
        responses: {
          '200': ok('Diagnostics.', {
            type: 'object',
            properties: {
              valid: { type: 'boolean' },
              diagnostics: { type: 'array', items: ref('Diagnostic') },
            },
          }),
          ...errors,
        },
      },
    },
    '/changes': {
      get: {
        summary:
          'This key’s working branch, its pull request and what still blocks merging (scope: write).',
        responses: { '200': ok('State.', { type: 'object' }), ...errors },
      },
      post: {
        summary:
          'Saves files as a commit to this key’s working branch, then merges the published branch in (scope: write). Malformed XML is refused; validation problems are returned but do not stop the save.',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['files'],
            properties: {
              files: filesSchema,
              message: { type: 'string', maxLength: 200 },
              expectSha: {
                type: 'string',
                description: 'Blob sha the change started from; refused if the file changed since.',
              },
            },
          }),
        },
        responses: {
          '200': ok('The commit.', { type: 'object' }),
          '409': { description: 'The file changed since, or a conflict.' },
          ...errors,
        },
      },
    },
    '/changes/publish': {
      post: {
        summary:
          'Opens (or updates) one pull request for the working branch. With `merge: true` and the publish scope, merges it when the branch rules allow.',
        requestBody: {
          required: false,
          content: json({
            type: 'object',
            properties: { merge: { type: 'boolean', default: false } },
          }),
        },
        responses: {
          '200': ok('The pull request.', {
            type: 'object',
            properties: {
              pull: ref('PullRequest'),
              merged: { type: 'boolean' },
              review: ref('Review'),
            },
          }),
          '422': { description: 'Validation errors block publishing.' },
          ...errors,
        },
      },
    },
    '/builds': {
      get: {
        summary: 'Recent builds (scope: builds).',
        responses: { '200': ok('Builds.', { type: 'object' }), ...errors },
      },
      post: {
        summary: 'Builds the release refs now, or one `ref` (scope: builds).',
        requestBody: {
          required: false,
          content: json({ type: 'object', properties: { ref: { type: 'string' } } }),
        },
        responses: { '200': ok('Queued builds.', { type: 'object' }), ...errors },
      },
    },
  },
} as const;
