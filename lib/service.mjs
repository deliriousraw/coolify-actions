// Makes one Coolify service (a Docker Compose stack) match what was declared,
// and restarts it when something changed. Used by the `compose` action.

import { createHash } from "node:crypto";
import { checkSharedVariables, resolveTarget } from "./application.mjs";
import { list } from "./coolify.mjs";

// What this action last deployed, kept at the end of the description.
const MARKER = /\s*\[deployed (?<hash>[0-9a-f]{12})\]$/u;
const STOPPED = /^(?:exited|degraded|restarting)/u;

const waitUntilRunning = async ({ api, uuid, name, timeout, sleep, log }) => {
  const deadline = Date.now() + timeout * 1000;
  // Coolify takes the old containers down first: give it a moment, so the
  // status read below is the new stack's.
  await sleep(10);
  let last = "";
  for (;;) {
    const { status = "" } = await api("GET", `/services/${uuid}`);
    if (status !== last) {
      log.info(`${name}: ${status || "starting"}`);
      last = status;
    }
    if (status.startsWith("running")) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Service ${name} is "${status || "starting"}" after ${timeout}s${STOPPED.test(status) ? ": a container keeps stopping" : ""}. Open it in Coolify and read its logs.`
      );
    }
    await sleep(5);
  }
};

/**
 * @param spec { name, compose: the file's content, urls: Map of compose
 *   service name to URL(s), env: Map, project, environment, server,
 *   destination, force, wait, timeout }
 * @returns { uuid, created, changed }
 */
export const deployService = async (spec, { api, log, sleep }) => {
  const { environment, project, server } = await resolveTarget(api, spec);
  const env = new Map([...spec.env].filter(([, value]) => value !== ""));
  await checkSharedVariables(api, { env, environment, project });

  const services = list(await api("GET", "/services")).filter(
    (service) =>
      service.name === spec.name && service.environment_id === environment.id
  );
  if (services.length > 1) {
    throw new Error(
      `Several services in "${project.name}/${environment.name}" are called "${spec.name}": ${services
        .map((service) => service.uuid)
        .join(", ")}. Rename or delete the extra ones.`
    );
  }
  const current = services[0];

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        compose: spec.compose,
        env: [...env].sort(),
        urls: [...spec.urls].sort(),
      })
    )
    .digest("hex")
    .slice(0, 12);
  const description = String(current?.description ?? "");
  const deployed = MARKER.exec(description)?.groups.hash;
  const running = String(current?.status ?? "").startsWith("running");
  if (!spec.force && deployed === fingerprint && running) {
    log.info(`${spec.name}: unchanged (same file and settings, ${current.status}).`);
    return { changed: false, created: false, uuid: current.uuid };
  }

  const settings = {
    connect_to_docker_network: true,
    docker_compose_raw: Buffer.from(spec.compose).toString("base64"),
    ...(spec.urls.size > 0 && {
      urls: [...spec.urls].map(([name, url]) => ({ name, url })),
    }),
  };
  let uuid = current?.uuid;
  if (uuid) {
    log.info(`${spec.name}: updating ${uuid}`);
    await api("PATCH", `/services/${uuid}`, settings);
  } else {
    log.info(`${spec.name}: creating in ${project.name}/${environment.name}`);
    const created = await api("POST", "/services", {
      ...settings,
      environment_name: environment.name,
      instant_deploy: false,
      name: spec.name,
      project_uuid: project.uuid,
      server_uuid: server.uuid,
      ...(spec.destination && { destination_uuid: spec.destination }),
    });
    uuid = created.uuid;
  }

  if (env.size > 0) {
    log.info(`${spec.name}: environment ${[...env.keys()].join(", ")}`);
    await api("PATCH", `/services/${uuid}/envs/bulk`, {
      data: [...env].map(([key, value]) => ({ key, value })),
    });
  }

  // A service that runs is restarted with fresh images; a new or stopped
  // one is started.
  await api(
    "POST",
    running ? `/services/${uuid}/restart?latest=true` : `/services/${uuid}/start`
  );
  if (spec.wait) {
    await waitUntilRunning({
      api,
      log,
      name: spec.name,
      sleep,
      timeout: spec.timeout,
      uuid,
    });
  } else {
    log.info(`${spec.name}: start requested, not waiting.`);
  }

  // Only now, so a failed start is tried again by the next run.
  await api("PATCH", `/services/${uuid}`, {
    description: `${description.replace(MARKER, "")} [deployed ${fingerprint}]`.trim(),
  });
  return { changed: true, created: !current, uuid };
};
