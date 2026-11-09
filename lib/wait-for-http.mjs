// Polls a URL until it answers as expected. Used by the `wait-for-http` action.

import { parsePairs } from "./pairs.mjs";

/** Reads "a.b.c" from an object; undefined when a step is missing. */
const at = (value, path) =>
  path.split(".").reduce((current, key) => current?.[key], value);

/** Why this response is not the expected one, or "" when it is. */
const mismatch = async (response, { status, json }) => {
  if (response.status !== status) {
    return `answered ${response.status}, expected ${status}`;
  }
  if (json.size === 0) {
    return "";
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return "the body is not JSON";
  }
  for (const [path, expected] of json) {
    const actual = at(body, path);
    if (String(actual) !== expected) {
      return `${path} is ${JSON.stringify(actual)}, expected "${expected}"`;
    }
  }
  return "";
};

/**
 * @param options { url, status, json: "path=value" lines, timeout, interval } (seconds)
 * @returns the number of attempts it took; throws when the timeout passes.
 */
export const waitForHttp = async (options, { log, sleep }) => {
  const expected = {
    json: parsePairs(options.json, "`json` line"),
    status: options.status,
  };
  const deadline = Date.now() + options.timeout * 1000;
  let last = "";
  for (let attempt = 1; ; attempt += 1) {
    let reason;
    try {
      const response = await fetch(options.url, {
        headers: { Accept: "application/json, */*" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      reason = await mismatch(response, expected);
    } catch (error) {
      reason = `no answer (${error.cause?.code ?? error.message})`;
    }
    if (!reason) {
      log.info(`${options.url} answers as expected.`);
      return attempt;
    }
    if (reason !== last) {
      log.info(`${options.url}: ${reason}`);
      last = reason;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `After ${options.timeout}s ${options.url} still does not answer as expected: ${reason}.`
      );
    }
    await sleep(options.interval);
  }
};
