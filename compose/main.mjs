import { readFileSync } from "node:fs";
import { input, log, main, setOutput, sleep, summary } from "../lib/action.mjs";
import { connect, environmentVariables, rollout, target } from "../lib/inputs.mjs";
import { parsePairs } from "../lib/pairs.mjs";
import { deployService } from "../lib/service.mjs";

await main(async () => {
  const api = connect();
  const file = input("file", { fallback: "compose.yml" });
  let compose;
  try {
    compose = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `Cannot read ${file}. The path is relative to the repository root, and the job needs an actions/checkout step first.`
    );
  }
  const name = input("name", { required: true });
  const result = await deployService(
    {
      ...target(),
      ...rollout(),
      compose,
      env: environmentVariables(),
      name,
      urls: parsePairs(input("urls"), "`urls` line"),
    },
    { api, log, sleep }
  );

  setOutput("uuid", result.uuid);
  setOutput("created", result.created);
  setOutput("changed", result.changed);

  let outcome = "unchanged";
  if (result.changed) {
    outcome = result.created ? "created and started" : "restarted";
  }
  summary(`- **${name}**: ${outcome} from \`${file}\``);
});
