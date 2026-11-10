// Sets Coolify shared variables, the values applications refer to as
// {{environment.KEY}}, {{project.KEY}} or {{team.KEY}}. Used by the
// `variables` action.

import { list, pick } from "./coolify.mjs";

const SCOPES = ["environment", "project", "team"];

/**
 * @param spec { scope, variables: Map, project, environment, prune,
 *   onlyMissing: create the missing keys and leave existing ones as they are,
 *   so a generated secret is never replaced }
 * @returns { created: [keys], updated: [keys], removed: [keys] }
 */
export const setSharedVariables = async (spec, { api, log }) => {
  if (!SCOPES.includes(spec.scope)) {
    throw new Error(
      `\`scope\` must be environment, project or team, not "${spec.scope}".`
    );
  }
  let path = "/team/envs";
  if (spec.scope !== "team") {
    const project = pick(list(await api("GET", "/projects")), spec.project, "project");
    path =
      spec.scope === "project"
        ? `/projects/${project.uuid}/envs`
        : `/projects/${project.uuid}/environments/${encodeURIComponent(spec.environment)}/envs`;
  }

  const existing = new Map(
    list(await api("GET", path)).map((item) => [item.key, item])
  );
  const result = { created: [], removed: [], updated: [] };
  for (const [key, value] of spec.variables) {
    const current = existing.get(key);
    if (!current) {
      await api("POST", path, { key, value });
      result.created.push(key);
    } else if (!spec.onlyMissing && current.value !== value) {
      // Coolify hides locked values, so those are always written again.
      await api("PATCH", `${path}/${current.id}`, { value });
      result.updated.push(key);
    }
  }
  if (spec.prune) {
    for (const [key, current] of existing) {
      if (!spec.variables.has(key)) {
        await api("DELETE", `${path}/${current.id}`);
        result.removed.push(key);
      }
    }
  }
  for (const [what, keys] of Object.entries(result)) {
    if (keys.length > 0) {
      log.info(`${what}: ${keys.join(", ")}`);
    }
  }
  if (Object.values(result).every((keys) => keys.length === 0)) {
    log.info(
      `All ${spec.variables.size} ${spec.scope} variable(s) already ${spec.onlyMissing ? "exist" : "match"}.`
    );
  }
  return result;
};
