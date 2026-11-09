// The inputs the Coolify actions share, read the same way in each.

import { boolean, duration, input, lines, mask } from "./action.mjs";
import { parseVolumes } from "./application.mjs";
import { createClient } from "./coolify.mjs";
import { readPairs } from "./pairs.mjs";

/** The API client, from `coolify-url` and `coolify-token` or the environment. */
export const connect = () => {
  const url = input("coolify-url", { env: "COOLIFY_URL", required: true });
  const token = input("coolify-token", { env: "COOLIFY_TOKEN", required: true });
  mask(token);
  return createClient({ token, url });
};

/** Where a resource lives: the project, its environment and the server. */
export const target = ({ server = true } = {}) => ({
  destination: input("destination", { env: "COOLIFY_DESTINATION" }),
  environment: input("environment", {
    env: "COOLIFY_ENVIRONMENT",
    fallback: "production",
  }),
  project: input("project", { env: "COOLIFY_PROJECT", required: true }),
  server: input("server", { env: "COOLIFY_SERVER", required: server }),
});

/** `env-files`, then `env`. */
export const environmentVariables = () =>
  readPairs({
    files: lines(input("env-files")),
    inline: input("env"),
    what: "environment variable",
  });

export const rollout = () => ({
  force: boolean("force", input("force", { fallback: "false" })),
  timeout: duration("timeout", input("timeout", { fallback: "15m" })),
  wait: boolean("wait", input("wait", { fallback: "true" })),
});

/** Everything an application declares besides its source. */
export const application = () => ({
  ...target(),
  ...rollout(),
  domain: input("domain"),
  env: environmentVariables(),
  labels: readPairs({ inline: input("labels"), what: "label" }),
  name: input("name", { required: true }),
  port: input("port", { fallback: "80" }),
  pruneEnv: boolean("prune-env", input("prune-env", { fallback: "false" })),
  stopGracePeriod: Number(input("stop-grace-period")) || undefined,
  volumes: parseVolumes(lines(input("volumes"))),
});
