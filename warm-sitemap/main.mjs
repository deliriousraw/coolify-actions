import {
  boolean,
  duration,
  input,
  integer,
  lines,
  log,
  main,
  setOutput,
} from "../lib/action.mjs";
import { warmSitemap } from "../lib/warm-sitemap.mjs";

await main(async () => {
  const { failed, requested } = await warmSitemap(
    {
      concurrency: integer("concurrency", input("concurrency", { fallback: "4" })),
      limit: integer("limit", input("limit", { fallback: "500" })),
      timeout: duration("timeout", input("timeout", { fallback: "15s" })),
      urls: lines(input("url", { required: true })),
    },
    { log }
  );
  for (const line of failed) {
    log.warning(`Not warmed: ${line}`);
  }
  log.info(`${requested - failed.length} of ${requested} page(s) answered.`);
  setOutput("requested", requested);
  setOutput("failed", failed.length);
  if (failed.length > 0 && boolean("fail-on-error", input("fail-on-error", { fallback: "false" }))) {
    throw new Error(`${failed.length} page(s) did not answer.`);
  }
});
