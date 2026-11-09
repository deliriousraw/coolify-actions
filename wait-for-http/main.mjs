import { duration, input, integer, log, main, setOutput, sleep } from "../lib/action.mjs";
import { waitForHttp } from "../lib/wait-for-http.mjs";

await main(async () => {
  const attempts = await waitForHttp(
    {
      interval: duration("interval", input("interval", { fallback: "10s" })),
      json: input("json"),
      status: integer("status", input("status", { fallback: "200" })),
      timeout: duration("timeout", input("timeout", { fallback: "5m" })),
      url: input("url", { required: true }),
    },
    { log, sleep }
  );
  setOutput("attempts", attempts);
});
