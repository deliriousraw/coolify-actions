// Makes sure one of Coolify's standalone databases exists: finds it by name in
// the environment, or creates and starts it. An existing database is left as
// it is, since changing a running database's settings is never routine.

import { randomBytes } from "node:crypto";
import { resolveTarget } from "./application.mjs";
import { list } from "./coolify.mjs";

const RUNNING = /^running/u;

// What each type is created with, and its connection URL inside the server.
// Coolify builds the same URL as `internal_db_url`, which it only shows to
// tokens with read:sensitive; SSL is off for a new database.
const TYPES = {
  postgresql: {
    body: (password) => ({
      postgres_db: "postgres",
      postgres_password: password,
      postgres_user: "postgres",
    }),
    config: "postgres_conf",
    url: (uuid, password) =>
      `postgres://postgres:${encodeURIComponent(password)}@${uuid}:5432/postgres`,
  },
  redis: {
    body: (password) => ({ redis_password: password }),
    config: "redis_conf",
    url: (uuid, password) =>
      `redis://default:${encodeURIComponent(password)}@${uuid}:6379/0`,
  },
};

const waitUntilRunning = async ({ api, uuid, name, timeout, sleep, log }) => {
  const deadline = Date.now() + timeout * 1000;
  let last = "";
  for (;;) {
    const { status = "" } = await api("GET", `/databases/${uuid}`);
    if (status !== last) {
      log.info(`${name}: ${status || "starting"}`);
      last = status;
    }
    if (RUNNING.test(status)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Database ${name} is still "${status}" after ${timeout}s. Open it in Coolify and read its logs.`
      );
    }
    await sleep(5);
  }
};

/**
 * @param spec { type: "postgresql" | "redis", name, config (file content,
 *   optional), project, environment, server, destination, wait, timeout }
 * @returns { uuid, created, url }: `url` is the connection URL inside the
 *   server when it is known (always for a database created here), else null.
 */
export const ensureDatabase = async (spec, { api, log, sleep }) => {
  const type = TYPES[spec.type];
  if (!type) {
    throw new Error(
      `\`type\` must be ${Object.keys(TYPES).join(" or ")}, not "${spec.type}".`
    );
  }
  const { environment, project, server } = await resolveTarget(api, spec);

  const matches = list(await api("GET", "/databases")).filter(
    (database) =>
      database.name === spec.name && database.environment_id === environment.id
  );
  if (matches.length > 1) {
    throw new Error(
      `Several databases in "${project.name}/${environment.name}" are called "${spec.name}": ${matches
        .map((database) => database.uuid)
        .join(", ")}. Rename or delete the extra ones.`
    );
  }
  if (matches.length === 1) {
    const [current] = matches;
    log.info(`${spec.name}: exists (${current.status}), left as it is.`);
    return { created: false, url: current.internal_db_url ?? null, uuid: current.uuid };
  }

  log.info(`${spec.name}: creating in ${project.name}/${environment.name}`);
  const password = randomBytes(24).toString("hex");
  const created = await api("POST", `/databases/${spec.type}`, {
    ...type.body(password),
    environment_name: environment.name,
    instant_deploy: true,
    name: spec.name,
    project_uuid: project.uuid,
    server_uuid: server.uuid,
    ...(spec.config && {
      [type.config]: Buffer.from(spec.config).toString("base64"),
    }),
    ...(spec.destination && { destination_uuid: spec.destination }),
  });
  if (spec.wait !== false) {
    await waitUntilRunning({
      api,
      log,
      name: spec.name,
      sleep,
      timeout: spec.timeout ?? 300,
      uuid: created.uuid,
    });
  }
  return {
    created: true,
    url: created.internal_db_url ?? type.url(created.uuid, password),
    uuid: created.uuid,
  };
};
