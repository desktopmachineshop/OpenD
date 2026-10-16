# Docs starter

A starting point for docs published with OpenD. Copy this folder into a new repository.

## Layout

| Path                             | What it holds                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `opend.config.yaml`              | Release, root map, publications, declared attribute values, build filter, theme     |
| `maps/user-guide.ditamap`        | Website navigation and key definitions                                              |
| `maps/admin-guide.bookmap`       | A curated publication (PDF in a later release)                                      |
| `topics/`                        | One file per page                                                                   |
| `reuse/`                         | Reusable chunks, pulled in with `conref` or `conkeyref`. Not published on their own |
| `filters/publish.ditaval`        | Build-time filter: drops `audience="internal"` for everyone                         |
| `preview-contexts.yaml`          | Sample readers for local preview                                                    |
| `theme/site.css`                 | Brand colours and fonts                                                             |
| `.github/workflows/validate.yml` | Validates every pull request                                                        |

## Writing conditional content

Put filtering attributes on any element, topic or map entry:

```xml
<step release="2.0..">...</step>          <!-- 2.0 and later -->
<p product="gadget">...</p>               <!-- readers who own the Gadget -->
<topicref href="sso.dita" feature="sso"/> <!-- the whole page, for SSO customers -->
```

- Values in one attribute are alternatives: `product="widget gadget"` matches readers who hold either.
- Separate attributes must all match.
- Declare every `product`, `feature` and `audience` value in `opend.config.yaml`. An undeclared value fails validation, and readers never see that content.

## Preview locally

```sh
npx @opend/cli preview                 # everything, with conditions marked
npx @opend/cli preview --as v1-basic   # as a reader from preview-contexts.yaml
npx @opend/cli preview --ref v1        # a release branch or tag, without checking it out
npx @opend/cli validate                # the same checks as CI
```

The previewer serves on `http://127.0.0.1:4000` and rebuilds when you save. Nothing leaves your machine.

> Until `@opend/cli` is published to npm, run it from a checkout of the OpenD repository: `pnpm opend preview path/to/your/docs`.

## Releases

Keep one branch or tag per release (`v1`, `v2`) and set `release` in `opend.config.yaml` on each. Inside a release, use `release` ranges for changes between minor versions.
