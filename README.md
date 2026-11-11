# Coolify actions

Small GitHub Actions for deploying to [Coolify](https://coolify.io). Each does
one thing, and you describe the result you want instead of the commands to
get there.

| Action | What it does |
| --- | --- |
| [`image`](#image) | Declares one Coolify application that runs a registry image. Creates or updates it, deploys only when something changed, waits for the result. |
| [`dockerfile`](#dockerfile) | The same for an application Coolify builds on the server from a Dockerfile. |
| [`compose`](#compose) | Declares one Coolify service from a Docker Compose file. |
| [`variables`](#variables) | Sets Coolify shared variables, for example from GitHub secrets. |
| [`wait-for-http`](#wait-for-http) | Waits until a URL answers with the expected status and JSON values. |
| [`warm-sitemap`](#warm-sitemap) | Requests every page of a sitemap, to refill a cache after a deploy. |

They are plain JavaScript with no dependencies and no build step: what you
read in this repository is what runs.

The repository root is the `image` action too, which is what the GitHub
Marketplace lists: `deliriousraw/coolify-actions@v1` and
`deliriousraw/coolify-actions/image@v1` run the same code.

## Connecting to Coolify

Set the connection once for the workflow (or a job), and every Coolify step
uses it:

```yaml
env:
  COOLIFY_URL: ${{ vars.COOLIFY_URL }}        # https://coolify.example.com
  COOLIFY_TOKEN: ${{ secrets.COOLIFY_TOKEN }}  # API token: read, write, deploy
```

`COOLIFY_PROJECT` and `COOLIFY_SERVER` (a name or uuid) are only needed when
Coolify has several projects or servers; otherwise the only one is used.
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
| `network-aliases` | none | More names the container answers to on the server's Docker network, one per line or comma-separated. |
| `memory` | Coolify's | The container's memory limit, e.g. `768m` or `1g`; `0` removes it. |
| `stop-grace-period` | Coolify's | Seconds between SIGTERM and SIGKILL. |
| `prune-env` | `false` | Remove variables that are in Coolify but not declared here. |
| `force` | `false` | Deploy even when nothing changed. |
| `wait` | `true` | Wait for the deployment and fail when it fails. |
| `timeout` | `15m` | How long to wait. |

A variable declared with an empty value (`KEY=`) is treated as not declared.
Volumes are only ever added, never removed.

### Reaching an application from another one

Coolify names each container after the application's uuid plus a timestamp,
so the name changes with every deployment. To call one application from
another without going out through its public domain (a CDN, a tunnel, TLS),
give it a stable name on the server's Docker network:

```yaml
    network-aliases: auth.example.com.internal
```

Other containers on that network (with `connect_to_docker_network`, which
this action turns on) then reach it at `http://auth.example.com.internal:3000`.
Every application on the network shares one namespace, so pick a name no
other project on the server uses: the public host plus `.internal` (a domain
reserved for private use, so it never hides a real one) is unique per
deployment. During a rolling update both containers answer to the alias
until the old one stops. Leaving the input empty keeps what Coolify has, so
to remove an alias, clear it in the application's settings in Coolify.

### Memory limit

Without a limit every container sees all of the server's memory, and a
Node.js process sizes its heap from that: on a small server, several apps
that each grow to what they think they may use can run it out together.
Declare one per application:

```yaml
    memory: 768m
```

It is Docker's `mem_limit` (Coolify's **Resource Limits → Maximum Memory
Limit**). Docker lets the container swap as much again unless the server has
no swap; Coolify's swap setting is left alone. Node.js reads the limit and sizes
its heap to about half of it (but never under about 256 MB, so give a
Node.js app at least `512m`): a limit also keeps the heap, and with it the
process's memory, smaller, at the cost of more frequent garbage collection. Changing the value redeploys the application, which is
how Docker applies it. Leaving the input empty keeps what Coolify has; `0`
removes the limit.

### Outputs

| Output | |
| --- | --- |
| `uuid` | The application's uuid. |
| `created` | `true` when this run created it. |
| `changed` | `true` when this run deployed. |
| `deployment` | The deployment's uuid, empty when unchanged. |
| `digest` | The image digest, empty when the registry could not be read. |
| `revision` | The commit the image was built from (`org.opencontainers.image.revision`), when the image has that label. |

## dockerfile

```yaml
- uses: actions/checkout@v5
- name: Deploy the status page
  uses: deliriousraw/coolify-actions/dockerfile@v1
  with:
    name: status
    file: infra/status/Dockerfile
    domain: https://status.example.com
    port: 8080
```

Coolify builds the image on the server, and rebuilds only when the Dockerfile
or the settings changed. Only the Dockerfile's **content** is sent, so it
cannot `COPY` files from your repository: this fits a Dockerfile that stands
on its own (`FROM`, `RUN`, a few `ENV`). For an image built from your code,
build it in CI and use [`image`](#image).

Every other input and output is the same as for `image`, except the registry
inputs and the `digest` and `revision` outputs.

## compose

```yaml
- uses: actions/checkout@v5
- name: Deploy the monitoring stack
  uses: deliriousraw/coolify-actions/compose@v1
  with:
    name: monitoring
    file: infra/monitoring/compose.yml
    urls: |
      grafana=https://grafana.example.com
    env: |
      GRAFANA_PASSWORD={{environment.GRAFANA_PASSWORD}}
```

Creates or updates a Coolify service from the file, and restarts it (pulling
fresh images) only when the file, `urls` or `env` changed. `urls` maps a
service of the Compose file to its address. The step waits until Coolify
reports the service as running.

Coolify replaces a Compose service by stopping it first, so expect a short
gap on each change. Use `image` where you need a rolling update.

| Input | Default | |
| --- | --- | --- |
| `name` | required | The service's name in Coolify. |
| `file` | `compose.yml` | The Compose file. |
| `urls` | none | `<compose service>=<url>` lines. |
| `env`, `env-files` | none | As for `image`. |
| `force`, `wait`, `timeout` | | As for `image`. |

Outputs: `uuid`, `created`, `changed`.

## variables

```yaml
- name: Set the shared secrets
  uses: deliriousraw/coolify-actions/variables@v1
  with:
    variables: |
      DATABASE_URL=${{ secrets.DATABASE_URL }}
      SESSION_SECRET=${{ secrets.SESSION_SECRET }}
```

Creates or updates [shared variables](https://coolify.io/docs/knowledge-base/environment-variables)
of the environment, which applications then read as
`{{environment.DATABASE_URL}}`. With it, your GitHub secrets are the one place
you edit secrets. The trade-off is that the values then pass through GitHub;
leave this action out if secrets should only ever live in Coolify.

`scope: project` or `scope: team` shares them more widely. `prune: true`
removes shared variables of that scope that are not listed, and
`only-missing: true` creates only the keys that do not exist yet, leaving the
others as they are. Values are masked
in the log. An application picks a new value up on its next deploy, so put
this step before the `image` steps; the `changed` output lists the keys that
changed.

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

## From a script

The code behind the actions is in `lib/` and runs anywhere Node 22 runs, for
example in a setup script that prepares a new Coolify. Install the repository
at a tag (`npm install -D github:deliriousraw/coolify-actions#v1.2.0`) and
import the files:

```js
import { createClient } from "coolify-actions/lib/coolify.mjs";
import { ensureDatabase } from "coolify-actions/lib/database.mjs";
import { setSharedVariables } from "coolify-actions/lib/shared-variables.mjs";

const api = createClient({ url: "https://coolify.example.com", token });
const deps = { api, log: { info: console.log, warning: console.warn }, sleep: (s) => new Promise((r) => setTimeout(r, s * 1000)) };
const postgres = await ensureDatabase({ type: "postgresql", name: "postgres", environment: "production" }, deps);
await setSharedVariables(
  { scope: "environment", environment: "production", onlyMissing: true, variables: new Map([["DATABASE_URL", postgres.url]]) },
  deps
);
```

- `ensureDatabase` finds a PostgreSQL or Redis database by name in the
  environment, or creates it with a generated password, starts it and waits
  until it runs. It returns its connection URL inside the server; for a
  database it did not create, that needs a token with `read:sensitive`.
- `deployImage`, `deployDockerfile` (`lib/application.mjs`) and
  `deployService` (`lib/service.mjs`) are what the actions run.
- `setSharedVariables` with `onlyMissing` never replaces a value that exists.

## Development

```bash
npm test
```

The tests run the actions against an in-memory Coolify (`test/mock-coolify.mjs`)
shaped like Coolify's OpenAPI description. Node 22 or newer; nothing to install.

Release by moving the major tag: `git tag -f v1 && git push -f origin v1`.
