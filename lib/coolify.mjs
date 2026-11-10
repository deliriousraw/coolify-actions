// A small client for Coolify's API (https://coolify.io/docs/api-reference).

const TRAILING_SLASHES = /\/+$/u;
const RETRIES = 3;

export class CoolifyError extends Error {
  constructor(method, path, status, body) {
    super(`Coolify answered ${status} to ${method} ${path}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

const HINTS = {
  401: "Check the token: it may be wrong, expired or from another Coolify.",
  403: "The token lacks a permission. This action needs read, write and deploy.",
};

/**
 * Returns `api(method, path, body)`, which resolves to the parsed response.
 * Reads are retried on a network error or a 5xx; writes are never repeated.
 */
export const createClient = ({ url, token, pause = 2 }) => {
  const base = `${url.replace(TRAILING_SLASHES, "")}/api/v1`;
  const request = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const hint = HINTS[response.status];
      throw new CoolifyError(
        method,
        path,
        response.status,
        hint ? `${text} (${hint})` : text
      );
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new CoolifyError(
        method,
        path,
        response.status,
        `not JSON. Is ${url} the address of Coolify itself?`
      );
    }
  };

  return async (method, path, body) => {
    const attempts = method === "GET" ? RETRIES : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await request(method, path, body);
      } catch (error) {
        const transient = !(error instanceof CoolifyError) || error.status >= 500;
        if (!transient || attempt >= attempts) {
          if (error instanceof CoolifyError) {
            throw error;
          }
          throw new Error(
            `Could not reach Coolify at ${url} (${method} ${path}): ${error.message}`
          );
        }
        await new Promise((resolve) => {
          setTimeout(resolve, pause * 1000 * attempt);
        });
      }
    }
  };
};

/** Coolify answers lists as an array, or wrapped in `data`. */
export const list = (response) =>
  Array.isArray(response) ? response : (response?.data ?? []);

/**
 * Finds one item of a list by uuid or by name, or fails naming the choices.
 * With nothing named, the only item is the one: a Coolify with a single
 * project or server needs no setting.
 */
export const pick = (items, wanted, what) => {
  const names = items.map((item) => item.name).join(", ") || "none";
  if (!wanted) {
    if (items.length === 1) {
      return items[0];
    }
    throw new Error(
      items.length === 0
        ? `Coolify has no ${what} yet. Create one first.`
        : `Coolify has several ${what}s (${names}). Name the one to use.`
    );
  }
  const matches = items.filter(
    (item) => item.uuid === wanted || item.name === wanted
  );
  if (matches.length === 1) {
    return matches[0];
  }
  throw new Error(
    matches.length === 0
      ? `Coolify has no ${what} called "${wanted}". It has: ${names}.`
      : `Coolify has several ${what}s called "${wanted}". Pass its uuid instead.`
  );
};
