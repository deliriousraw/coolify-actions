import {
  boolean,
  duration,
  input,
  lines,
  log,
  main,
  mask,
  setOutput,
  sleep,
  summary,
} from "../lib/action.mjs";
import { createClient } from "../lib/coolify.mjs";
import { deployImage, parseVolumes } from "../lib/image-app.mjs";
import { readPairs } from "../lib/pairs.mjs";
import { inspectImage, parseImage } from "../lib/registry.mjs";

await main(async () => {
  const url = input("coolify-url", { env: "COOLIFY_URL", required: true });
  const token = input("coolify-token", { env: "COOLIFY_TOKEN", required: true });
  mask(token);
  const registryPassword = input("registry-password");
  mask(registryPassword);

  const name = input("name", { required: true });
  const image = parseImage(input("image", { required: true }));

  // The digest tells a rebuilt image from the same image under a new tag.
  let digest = "";
  let revision = "";
  try {
    ({ digest, revision } = await inspectImage(image, {
      password: registryPassword,
      username: input("registry-username"),
    }));
  } catch (error) {
    log.warning(
      `Could not read ${image.name}:${image.tag} from its registry (${error.message}). Comparing tags instead of digests: a new tag will redeploy even when the image is the same. For a private image, pass \`registry-username\` and \`registry-password\`.`
    );
  }

  const result = await deployImage(
    {
      destination: input("destination", { env: "COOLIFY_DESTINATION" }),
      digest,
      domain: input("domain"),
      env: readPairs({
        files: lines(input("env-files")),
        inline: input("env"),
        what: "environment variable",
      }),
      environment: input("environment", {
        env: "COOLIFY_ENVIRONMENT",
        fallback: "production",
      }),
      force: boolean("force", input("force", { fallback: "false" })),
      image,
      labels: readPairs({ inline: input("labels"), what: "label" }),
      name,
      port: input("port", { fallback: "80" }),
      project: input("project", { env: "COOLIFY_PROJECT", required: true }),
      pruneEnv: boolean("prune-env", input("prune-env", { fallback: "false" })),
      server: input("server", { env: "COOLIFY_SERVER", required: true }),
      stopGracePeriod: Number(input("stop-grace-period")) || undefined,
      timeout: duration("timeout", input("timeout", { fallback: "15m" })),
      volumes: parseVolumes(lines(input("volumes"))),
      wait: boolean("wait", input("wait", { fallback: "true" })),
    },
    { api: createClient({ token, url }), log, sleep }
  );

  setOutput("uuid", result.uuid);
  setOutput("created", result.created);
  setOutput("changed", result.changed);
  setOutput("deployment", result.deployment ?? "");
  setOutput("digest", digest);
  setOutput("revision", revision);

  let outcome = "unchanged";
  if (result.changed) {
    outcome = result.created ? "created and deployed" : "deployed";
  }
  summary(
    `- **${name}**: ${outcome} \`${image.name}:${image.tag}\`${revision ? ` (built from \`${revision.slice(0, 12)}\`)` : ""}`
  );
});
