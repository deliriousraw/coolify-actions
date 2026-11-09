// An in-memory Coolify and image registry for the tests: just the endpoints
// the actions call, shaped like Coolify's OpenAPI description.

import { createServer } from "node:http";

const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        close: () => new Promise((done) => server.close(done)),
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });

const readBody = async (request) => {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
  }
  return text ? JSON.parse(text) : undefined;
};

export const startCoolify = async ({ shared = [], deploymentStatus = "finished" } = {}) => {
  const state = {
    applications: [],
    deploymentStatus,
    deployments: [],
    serviceStatus: "running:healthy",
    envs: {},
    requests: [],
    services: [],
    shared: shared.map((key, index) => ({ id: index + 1, key, value: "x" })),
    storages: {},
  };
  let counter = 0;
  const routes = [
    ["GET", /^\/projects$/u, () => [{ id: 1, name: "shop", uuid: "proj-1" }]],
    ["GET", /^\/servers$/u, () => [{ id: 1, name: "pi", uuid: "srv-1" }]],
    ["GET", /^\/projects\/proj-1\/environments\/production\/envs$/u, () => state.shared],
    [
      "POST",
      /^\/projects\/proj-1\/environments\/production\/envs$/u,
      (_, body) => {
        counter += 1;
        state.shared.push({ ...body, id: 100 + counter });
        return body;
      },
    ],
    [
      "PATCH",
      /^\/projects\/proj-1\/environments\/production\/envs\/(?<id>\d+)$/u,
      ({ id }, body) => Object.assign(state.shared.find((item) => item.id === Number(id)), body),
    ],
    [
      "DELETE",
      /^\/projects\/proj-1\/environments\/production\/envs\/(?<id>\d+)$/u,
      ({ id }) => {
        state.shared = state.shared.filter((item) => item.id !== Number(id));
        return { message: "deleted" };
      },
    ],
    ["GET", /^\/services$/u, () => state.services],
    [
      "POST",
      /^\/services$/u,
      (_, body) => {
        counter += 1;
        const service = { ...body, description: null, environment_id: 7, status: "exited", uuid: `svc-${counter}` };
        state.services.push(service);
        return { domains: [], uuid: service.uuid };
      },
    ],
    [
      "GET",
      /^\/services\/(?<uuid>[^/]+)$/u,
      ({ uuid }) => state.services.find((service) => service.uuid === uuid),
    ],
    [
      "PATCH",
      /^\/services\/(?<uuid>[^/]+)$/u,
      ({ uuid }, body) => Object.assign(state.services.find((service) => service.uuid === uuid), body),
    ],
    [
      "PATCH",
      /^\/services\/(?<uuid>[^/]+)\/envs\/bulk$/u,
      ({ uuid }, body) => {
        state.envs[uuid] = body.data;
        return body.data;
      },
    ],
    [
      "POST",
      /^\/services\/(?<uuid>[^/]+)\/(?:start|restart\?latest=true)$/u,
      ({ uuid }) => {
        state.services.find((service) => service.uuid === uuid).status = state.serviceStatus;
        return { message: "queued" };
      },
    ],
    [
      "GET",
      /^\/projects\/proj-1\/(?<name>[^/]+)$/u,
      ({ name }) =>
        name === "production" ? { id: 7, name: "production" } : undefined,
    ],
    ["GET", /^\/applications$/u, () => state.applications],
    [
      "POST",
      /^\/applications\/(?:dockerimage|dockerfile)$/u,
      (_, body) => {
        counter += 1;
        const application = {
          ...body,
          custom_labels: Buffer.from("coolify.managed=true").toString("base64"),
          description: null,
          environment_id: 7,
          status: "exited",
          uuid: `app-${counter}`,
        };
        state.applications.push(application);
        return { uuid: application.uuid };
      },
    ],
    [
      "GET",
      /^\/applications\/(?<uuid>[^/]+)$/u,
      ({ uuid }) => state.applications.find((app) => app.uuid === uuid),
    ],
    [
      "PATCH",
      /^\/applications\/(?<uuid>[^/]+)$/u,
      ({ uuid }, body) => {
        const application = state.applications.find((app) => app.uuid === uuid);
        return application && Object.assign(application, body);
      },
    ],
    [
      "GET",
      /^\/applications\/(?<uuid>[^/]+)\/envs$/u,
      ({ uuid }) => state.envs[uuid] ?? [],
    ],
    [
      "PATCH",
      /^\/applications\/(?<uuid>[^/]+)\/envs\/bulk$/u,
      ({ uuid }, body) => {
        const envs = (state.envs[uuid] ??= []);
        for (const item of body.data) {
          const existing = envs.find((env) => env.key === item.key);
          if (existing) {
            existing.value = item.value;
          } else {
            envs.push({ ...item, uuid: `env-${item.key}` });
          }
        }
        return envs;
      },
    ],
    [
      "DELETE",
      /^\/applications\/(?<uuid>[^/]+)\/envs\/(?<env>[^/]+)$/u,
      ({ uuid, env }) => {
        state.envs[uuid] = (state.envs[uuid] ?? []).filter((item) => item.uuid !== env);
        return { message: "Environment variable deleted." };
      },
    ],
    [
      "GET",
      /^\/applications\/(?<uuid>[^/]+)\/storages$/u,
      ({ uuid }) => ({ file_storages: [], persistent_storages: state.storages[uuid] ?? [] }),
    ],
    [
      "POST",
      /^\/applications\/(?<uuid>[^/]+)\/storages$/u,
      ({ uuid }, body) => {
        (state.storages[uuid] ??= []).push(body);
        return body;
      },
    ],
    [
      "POST",
      /^\/deploy$/u,
      (_, body) => {
        counter += 1;
        const deployment = { deployment_uuid: `dep-${counter}`, resource_uuid: body.uuid };
        state.deployments.push(deployment);
        const application = state.applications.find((app) => app.uuid === body.uuid);
        if (state.deploymentStatus === "finished") {
          application.status = "running:healthy";
        }
        return { deployments: [deployment] };
      },
    ],
    [
      "GET",
      /^\/deployments\/(?<uuid>[^/]+)$/u,
      () => ({ status: state.deploymentStatus }),
    ],
  ];

  const server = await listen(async (request, response) => {
    const path = request.url.replace(/^\/api\/v1/u, "");
    const body = await readBody(request);
    state.requests.push({ body, method: request.method, path });
    if (request.headers.authorization !== "Bearer secret") {
      response.writeHead(401).end('{"message":"Unauthenticated."}');
      return;
    }
    for (const [method, pattern, handle] of routes) {
      const match = request.method === method && pattern.exec(path);
      if (match) {
        const result = handle(match.groups ?? {}, body);
        if (result === undefined) {
          break;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }
    }
    response.writeHead(404).end('{"message":"Not found."}');
  });
  return {
    ...server,
    state,
    /** The requests that changed something, as "METHOD path". */
    writes: () =>
      state.requests
        .filter((request) => request.method !== "GET")
        .map((request) => `${request.method} ${request.path}`),
  };
};

/** A registry holding `tags`: { "<repository>:<tag>": { digest, revision } }. */
export const startRegistry = (tags) =>
  listen((request, response) => {
    const manifest = /^\/v2\/(?<repository>.+)\/manifests\/(?<tag>[^/]+)$/u.exec(request.url);
    const blob = /^\/v2\/(?<repository>.+)\/blobs\/(?<digest>[^/]+)$/u.exec(request.url);
    const image =
      tags[`${(manifest ?? blob)?.groups.repository}:${manifest?.groups.tag}`] ??
      Object.values(tags).find((item) => `sha256:config-${item.digest}` === blob?.groups.digest);
    if (!image) {
      response.writeHead(404).end("{}");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      ...(manifest && { "Docker-Content-Digest": image.digest }),
    });
    response.end(
      JSON.stringify(
        manifest
          ? { config: { digest: `sha256:config-${image.digest}` } }
          : { config: { Labels: { "org.opencontainers.image.revision": image.revision } } }
      )
    );
  });
