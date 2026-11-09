import { input, log, main, mask, setOutput, sleep, summary } from "../lib/action.mjs";
import { deployImage } from "../lib/application.mjs";
import { application, connect } from "../lib/inputs.mjs";
import { inspectImage, parseImage } from "../lib/registry.mjs";

await main(async () => {
  const api = connect();
  const registryPassword = input("registry-password");
  mask(registryPassword);
  const image = parseImage(input("image", { required: true }));
  const spec = application();

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

  const result = await deployImage({ ...spec, digest, image }, { api, log, sleep });

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
    `- **${spec.name}**: ${outcome} \`${image.name}:${image.tag}\`${revision ? ` (built from \`${revision.slice(0, 12)}\`)` : ""}`
  );
});
