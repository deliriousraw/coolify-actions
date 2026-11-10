import { boolean, input, log, main, mask, setOutput, summary } from "../lib/action.mjs";
import { connect } from "../lib/inputs.mjs";
import { parsePairs } from "../lib/pairs.mjs";
import { setSharedVariables } from "../lib/shared-variables.mjs";

await main(async () => {
  const api = connect();
  const variables = parsePairs(input("variables", { required: true }), "variable");
  // Values are usually secrets, and a secret that reaches this action
  // through an expression is no longer masked by GitHub.
  for (const value of variables.values()) {
    mask(value);
  }
  const scope = input("scope", { fallback: "environment" });
  const result = await setSharedVariables(
    {
      environment: input("environment", {
        env: "COOLIFY_ENVIRONMENT",
        fallback: "production",
      }),
      onlyMissing: boolean("only-missing", input("only-missing", { fallback: "false" })),
      project: input("project", { env: "COOLIFY_PROJECT" }),
      prune: boolean("prune", input("prune", { fallback: "false" })),
      scope,
      variables,
    },
    { api, log }
  );
  const changed = [...result.created, ...result.updated, ...result.removed];
  setOutput("changed", changed.join(" "));
  summary(
    `- **${scope} variables**: ${changed.length > 0 ? `changed ${changed.map((key) => `\`${key}\``).join(", ")}` : "unchanged"}`
  );
});
