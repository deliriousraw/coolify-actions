# Coolify actions

Small GitHub Actions for deploying to [Coolify](https://coolify.io). Each does
one thing, and you describe the result you want instead of the commands to
get there.

| Action | What it does |
| --- | --- |
| [`image`](#image) | Declares one Coolify application that runs a registry image. Creates or updates it, deploys only when something changed, waits for the result. |
| [`wait-for-http`](#wait-for-http) | Waits until a URL answers with the expected status and JSON values. |
| [`warm-sitemap`](#warm-sitemap) | Requests every page of a sitemap, to refill a cache after a deploy. |

They are plain JavaScript with no dependencies and no build step: what you
read in this repository is what runs.

## Connecting to Coolify

Set the connection once for the workflow (or a job), and every `image` step
uses it:

```yaml
env:
  COOLIFY_URL: ${{ vars.COOLIFY_URL }}        # https://coolify.example.com
  COOLIFY_TOKEN: ${{ secrets.COOLIFY_TOKEN }}  # API token: read, write, deploy
  COOLIFY_PROJECT: production                  # project name or uuid
  COOLIFY_SERVER: localhost                    # server name or uuid
```

`COOLIFY_ENVIRONMENT` defaults to `production`. Each of these also exists as
an input (`coolify-url`, `coolify-token`, `project`, `server`, `environment`)
when one step needs a different value. GitHub's runners must be able to reach
`COOLIFY_URL`.

## image

```yaml
- name: Deploy the API
  uses: deliriousraw/coolify-actions/image@v1
  with:
    name: api
    image: ghcr.io/acme/shop/api:${{ github.sha }}
    domain: https://api.example.com
    port: 3000
    env: |
      LOG_LEVEL=info
      DATABASE_URL={{environment.DATABASE_URL}}
    volumes: |
      api_uploads:/data
```

What happens, in order:

1. The application called `name` is looked up in the project and environment.
   There is no uuid to store anywhere.
2. If it does not exist, it is created. If it does, what you declared is
   compared with what was last deployed.
3. Nothing changed and the application is running: the step ends, with
   `changed=false`. No restart.
4. Otherwise the settings, environment, labels and volumes are written, and a
   Coolify deployment is queued (a rolling update: the old container serves
   until the new one is healthy).
5. The step waits for the deployment and fails if it fails.

"Changed" compares image **digests**, not tags. Pushing the same image under a
new tag (a new commit that did not touch this service) does not restart it;
only the application's tag is moved. Reading a private image's digest needs
registry credentials:

```yaml
    registry-username: ${{ github.actor }}
    registry-password: ${{ secrets.GITHUB_TOKEN }}   # the job needs packages: read
```

Without them the action warns and compares tags instead.

### Secrets

A value such as `{{environment.DATABASE_URL}}` refers to a Coolify
[shared variable](https://coolify.io/docs/knowledge-base/environment-variables),
so the secret itself lives only in Coolify. `{{project.X}}` and `{{team.X}}`
work too. The action checks that every variable you refer to exists before it
changes anything.

### Inputs

| Input | Default | |
| --- | --- | --- |
| `name` | required | The application's name in Coolify. |
| `image` | required | The image and tag. The name is lowercased for you. |
| `domain` | none | Address with scheme, e.g. `https://api.example.com`. Omit for a worker. |
| `port` | `80` | The port the container listens on. |
| `env` | none | `KEY=value` lines. |
| `env-files` | none | Paths of `KEY=value` files, one per line. Later files win, and `env` wins over files. Needs a checkout step. |
| `labels` | none | `key=value` container labels, added to the ones Coolify generates for the domain. |
| `volumes` | none | `name:/path` lines, persistent volumes. |
| `stop-grace-period` | Coolify's | Seconds between SIGTERM and SIGKILL. |
| `prune-env` | `false` | Remove variables that are in Coolify but not declared here. |
| `force` | `false` | Deploy even when nothing changed. |
| `wait` | `true` | Wait for the deployment and fail when it fails. |
| `timeout` | `15m` | How long to wait. |

A variable declared with an empty value (`KEY=`) is treated as not declared.
Volumes are only ever added, never removed.

### Outputs

| Output | |
| --- | --- |
| `uuid` | The application's uuid. |
| `created` | `true` when this run created it. |
| `changed` | `true` when this run deployed. |
| `deployment` | The deployment's uuid, empty when unchanged. |
| `digest` | The image digest, empty when the registry could not be read. |
| `revision` | The commit the image was built from (`org.opencontainers.image.revision`), when the image has that label. |

## wait-for-http

```yaml
- name: Wait until the new build serves
  uses: deliriousraw/coolify-actions/wait-for-http@v1
  with:
    url: https://example.com/api/health
    json: |
      version=${{ github.sha }}
    timeout: 5m
```

Passes as soon as the URL answers with `status` (default `200`) and every
`path=value` line of `json` matches the response body (`checks.database=ok`
reads a nested value). Fails after `timeout`, saying what was still wrong.
`interval` (default `10s`) is the pause between attempts.

## warm-sitemap

```yaml
- name: Refill the cache
  uses: deliriousraw/coolify-actions/warm-sitemap@v1
  with:
    url: https://example.com
```

Reads `<url>/sitemap.xml` (and the sitemaps a sitemap index lists) and
requests every page on the same origin. A page that fails is logged as a
warning; the step only fails with `fail-on-error: true`.

| Input | Default | |
| --- | --- | --- |
| `url` | required | A site, or a sitemap's own URL. One per line for several. |
| `limit` | `500` | Most pages per site, `0` for no limit. |
| `concurrency` | `4` | Pages requested at once. |
| `timeout` | `15s` | Per page. |
| `fail-on-error` | `false` | |

## Putting them together

```yaml
name: Deploy
on:
  push:
    branches: [main]

env:
  COOLIFY_URL: ${{ vars.COOLIFY_URL }}
  COOLIFY_TOKEN: ${{ secrets.COOLIFY_TOKEN }}
  COOLIFY_PROJECT: production
  COOLIFY_SERVER: localhost

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy the site
        id: site
        uses: deliriousraw/coolify-actions/image@v1
        with:
          name: site
          image: ghcr.io/acme/site:${{ github.sha }}
          domain: https://example.com
          port: 3000

      - name: Wait until it serves
        if: steps.site.outputs.changed == 'true'
        uses: deliriousraw/coolify-actions/wait-for-http@v1
        with:
          url: https://example.com/api/health

      - name: Refill the cache
        if: steps.site.outputs.changed == 'true'
        uses: deliriousraw/coolify-actions/warm-sitemap@v1
        with:
          url: https://example.com
```

## Development

```bash
npm test
```

The tests run the actions against an in-memory Coolify (`test/mock-coolify.mjs`)
shaped like Coolify's OpenAPI description. Node 22 or newer; nothing to install.

Release by moving the major tag: `git tag -f v1 && git push -f origin v1`.
