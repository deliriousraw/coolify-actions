import { readFileSync } from "node:fs";
import { input, log, main, setOutput, sleep, summary } from "../lib/action.mjs";
import { deployDockerfile } from "../lib/application.mjs";
import { application, connect } from "../lib/inputs.mjs";

await main(async () => {
  const api = connect();
  const file = input("file", { fallback: "Dockerfile" });
  let dockerfile;
  try {
    dockerfile = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `Cannot read ${file}. The path is relative to the repository root, and the job needs an actions/checkout step first.`
    );
  }
  const spec = application();
  const result = await deployDockerfile({ ...spec, dockerfile }, { api, log, sleep });

  setOutput("uuid", result.uuid);
  setOutput("created", result.created);
  setOutput("changed", result.changed);
  setOutput("deployment", result.deployment ?? "");

  let outcome = "unchanged";
  if (result.changed) {
    outcome = result.created ? "created and built" : "built and deployed";
  }
  summary(`- **${spec.name}**: ${outcome} from \`${file}\``);
});
