// Makes one Coolify application that runs a registry image match what was
// declared, and deploys it when something changed. Used by the `image` action.

import { createHash } from "node:crypto";
import { list, pick } from "./coolify.mjs";

const VOLUME = /^(?<name>[\w.-]+):(?<path>\/\S*)$/u;
const BASE64 = /^[A-Za-z0-9+/\s]+={0,2}$/u;
const LABEL = /^(?<key>[^=\s]+)=(?<value>.*)$/u;
// {{environment.KEY}}, {{project.KEY}}, {{team.KEY}}: Coolify shared variables.
const SHARED_REFERENCE =
  /\{\{\s*(?<scope>environment|project|team)\.(?<key>[^}\s]+)\s*\}\}/gu;
// What this action last deployed, kept at the end of the description.
const MARKER = /\s*\[deployed (?<hash>[0-9a-f]{12})\]$/u;
const FAILED = /^(?:failed|cancelled)/u;

export const parseVolumes = (entries) =>
  entries.map((entry) => {
    const match = VOLUME.exec(entry);
    if (!match) {
      throw new Error(`Write each volume as name:/path, not "${entry}".`);
    }
    return { name: match.groups.name, path: match.groups.path };
  });

/** Coolify stores labels base64-encoded; older versions kept them plain. */
const decodeLabels = (text) => {
  if (!text) {
    return new Map();
  }
  // Plain labels contain dots, which base64 never does.
  const plain = BASE64.test(text)
    ? Buffer.from(text, "base64").toString("utf8")
    : text;
  const labels = new Map();
  for (const line of plain.split("\n")) {
    const match = LABEL.exec(line.trim());
    if (match) {
      labels.set(match.groups.key, match.groups.value);
    }
  }
  return labels;
};

const fingerprintOf = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/**
 * Every shared variable the environment refers to must exist, or the
 * container would receive the literal "{{environment.KEY}}".
 */
const checkSharedVariables = async (api, { project, environment, env }) => {
  const wanted = new Map();
  for (const [key, value] of env) {
    for (const match of value.matchAll(SHARED_REFERENCE)) {
      const name = `${match.groups.scope}.${match.groups.key}`;
      wanted.set(name, [...(wanted.get(name) ?? []), key]);
    }
  }
  if (wanted.size === 0) {
    return;
  }
  const paths = {
    environment: `/projects/${project.uuid}/environments/${encodeURIComponent(environment.name)}/envs`,
    project: `/projects/${project.uuid}/envs`,
    team: "/team/envs",
  };
  const scopes = [...new Set([...wanted.keys()].map((name) => name.split(".")[0]))];
  const responses = await Promise.all(
    scopes.map((scope) => api("GET", paths[scope]))
  );
  const defined = new Set(
    responses.flatMap((response, index) =>
      list(response).map((item) => `${scopes[index]}.${item.key}`)
    )
  );
  const missing = [...wanted].filter(([name]) => !defined.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Create these shared variables in Coolify first (Shared Variables; environment.* ones in the "${environment.name}" environment): ${missing
        .map(([name, keys]) => `${name} (used by ${keys.join(", ")})`)
        .join("; ")}.`
    );
  }
};

const waitForDeployment = async ({ api, deployment, timeout, sleep, log }) => {
  const deadline = Date.now() + timeout * 1000;
  let last = "";
  for (;;) {
    const { status = "" } = await api("GET", `/deployments/${deployment}`);
    if (status !== last) {
      log.info(`Deployment ${deployment}: ${status || "queued"}`);
      last = status;
    }
    if (status === "finished") {
      return;
    }
    if (FAILED.test(status)) {
      throw new Error(
        `Coolify deployment ${deployment} ${status}. Open the application in Coolify and read the deployment's log.`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Coolify deployment ${deployment} is still "${status}" after ${timeout}s. It keeps running in Coolify; raise \`timeout\` if this is normal.`
      );
    }
    await sleep(5);
  }
};

/**
 * @param spec what was declared: { name, image: {name, tag}, digest, domain,
 *   port, env: Map, labels: Map, volumes: [{name, path}], stopGracePeriod,
 *   project, environment, server, destination, pruneEnv, force, wait, timeout }
 * @returns { uuid, created, changed, deployment }
 */
export const deployImage = async (spec, { api, log, sleep }) => {
  const [projects, servers] = await Promise.all([
    api("GET", "/projects"),
    api("GET", "/servers"),
  ]);
  const project = pick(list(projects), spec.project, "project");
  const server = pick(list(servers), spec.server, "server");
  let environment;
  try {
    environment = await api(
      "GET",
      `/projects/${project.uuid}/${encodeURIComponent(spec.environment)}`
    );
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    throw new Error(
      `Project "${project.name}" has no environment called "${spec.environment}".`
    );
  }

  const env = new Map([...spec.env].filter(([, value]) => value !== ""));
  await checkSharedVariables(api, { env, environment, project });

  const applications = list(await api("GET", "/applications")).filter(
    (application) =>
      application.name === spec.name &&
      application.environment_id === environment.id
  );
  if (applications.length > 1) {
    throw new Error(
      `Several applications in "${project.name}/${environment.name}" are called "${spec.name}": ${applications
        .map((application) => application.uuid)
        .join(", ")}. Rename or delete the extra ones.`
    );
  }
  const current = applications[0];

  // Everything a deploy would change. The image is its digest when the
  // registry could be read, so a new tag on the same image is not a change.
  const fingerprint = fingerprintOf({
    domain: spec.domain,
    env: [...env].sort(),
    image: [spec.image.name, spec.digest || spec.image.tag],
    labels: [...spec.labels].sort(),
    port: spec.port,
    stopGracePeriod: spec.stopGracePeriod,
    volumes: spec.volumes,
  });
  const description = String(current?.description ?? "");
  const deployed = MARKER.exec(description)?.groups.hash;
  const running = String(current?.status ?? "").startsWith("running");
  const changed = spec.force || deployed !== fingerprint || !running;

  if (!changed) {
    // Keep the tag current even so: registries prune old tags, and a restart
    // pulls whatever tag the application names.
    if (current.docker_registry_image_tag !== spec.image.tag) {
      await api("PATCH", `/applications/${current.uuid}`, {
        docker_registry_image_tag: spec.image.tag,
      });
    }
    log.info(
      `${spec.name}: unchanged (same image and settings, ${current.status}).`
    );
    return { changed: false, created: false, uuid: current.uuid };
  }

  const settings = {
    // Reach databases and other resources by their internal hostnames.
    connect_to_docker_network: true,
    docker_registry_image_name: spec.image.name,
    docker_registry_image_tag: spec.image.tag,
    domains: spec.domain,
    // Let Coolify write the proxy labels for the domain; ours are added below.
    is_container_label_readonly_enabled: true,
    ports_exposes: spec.port,
    ...(spec.stopGracePeriod && { stop_grace_period: spec.stopGracePeriod }),
  };
  let uuid = current?.uuid;
  if (uuid) {
    log.info(`${spec.name}: updating ${uuid}`);
    await api("PATCH", `/applications/${uuid}`, settings);
  } else {
    log.info(`${spec.name}: creating in ${project.name}/${environment.name}`);
    const created = await api("POST", "/applications/dockerimage", {
      ...settings,
      // Otherwise Coolify invents a domain for an application without one.
      autogenerate_domain: false,
      environment_name: environment.name,
      // The image's own HEALTHCHECK decides when a container is ready.
      health_check_enabled: false,
      instant_deploy: false,
      name: spec.name,
      project_uuid: project.uuid,
      server_uuid: server.uuid,
      ...(spec.destination && { destination_uuid: spec.destination }),
    });
    uuid = created.uuid;
  }

  if (spec.labels.size > 0) {
    // Add ours to the labels Coolify generated, then freeze the result.
    const fresh = await api("GET", `/applications/${uuid}`);
    const labels = new Map([
      ...decodeLabels(fresh.custom_labels ?? ""),
      ...spec.labels,
    ]);
    const text = [...labels].map(([key, value]) => `${key}=${value}`).join("\n");
    await api("PATCH", `/applications/${uuid}`, {
      custom_labels: Buffer.from(text).toString("base64"),
      is_container_label_escape_enabled: false,
      is_container_label_readonly_enabled: false,
    });
  }

  if (env.size > 0 || spec.pruneEnv) {
    const existing = list(await api("GET", `/applications/${uuid}/envs`)).filter(
      (item) => !item.is_preview
    );
    if (env.size > 0) {
      log.info(`${spec.name}: environment ${[...env.keys()].join(", ")}`);
      await api("PATCH", `/applications/${uuid}/envs/bulk`, {
        data: [...env].map(([key, value]) => ({ is_preview: false, key, value })),
      });
    }
    if (spec.pruneEnv) {
      for (const item of existing.filter((item) => !env.has(item.key))) {
        log.info(`${spec.name}: removing ${item.key}`);
        await api("DELETE", `/applications/${uuid}/envs/${item.uuid}`);
      }
    }
  }

  if (spec.volumes.length > 0) {
    const storages = await api("GET", `/applications/${uuid}/storages`);
    const mounted = Array.isArray(storages)
      ? storages
      : (storages.persistent_storages ?? []);
    for (const volume of spec.volumes) {
      if (!mounted.some((storage) => storage.mount_path === volume.path)) {
        log.info(`${spec.name}: volume ${volume.name} at ${volume.path}`);
        await api("POST", `/applications/${uuid}/storages`, {
          mount_path: volume.path,
          name: volume.name,
          type: "persistent",
        });
      }
    }
  }

  const queued = await api("POST", "/deploy", { force: false, uuid });
  const deployment = queued.deployments?.[0]?.deployment_uuid;
  if (!deployment) {
    throw new Error(
      `Coolify queued no deployment for ${spec.name}: ${JSON.stringify(queued)}`
    );
  }
  if (spec.wait) {
    await waitForDeployment({ api, deployment, log, sleep, timeout: spec.timeout });
  } else {
    log.info(`${spec.name}: deployment ${deployment} queued, not waiting.`);
  }

  // Only now, so a failed deployment is tried again by the next run.
  await api("PATCH", `/applications/${uuid}`, {
    description: `${description.replace(MARKER, "")} [deployed ${fingerprint}]`.trim(),
  });
  return { changed: true, created: !current, deployment, uuid };
};
