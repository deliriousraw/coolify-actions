// Reads an image's digest and source commit from its registry, over the
// registry HTTP API (no Docker needed on the runner).

import { createHash } from "node:crypto";

const TAGGED = /^(?<name>.+?)(?::(?<tag>[^:/@]+))?$/u;
const CHALLENGE_PART = /(?<key>\w+)="(?<value>[^"]*)"/gu;
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const REVISION = "org.opencontainers.image.revision";

/**
 * Splits "ghcr.io/Acme/Shop/api:1.2" into the name Coolify stores
 * ("ghcr.io/acme/shop/api", lowercase as registries require), the tag
 * ("1.2", `latest` when absent), and where the registry serves it.
 */
export const parseImage = (reference) => {
  const text = String(reference).trim();
  if (!text || /\s/u.test(text)) {
    throw new Error(`\`image\` must be an image reference, not "${reference}".`);
  }
  if (text.includes("@")) {
    throw new Error(
      `\`image\` must end in a tag, not a digest ("${reference}"): Coolify deploys tags.`
    );
  }
  const { name: rawName, tag = "latest" } = TAGGED.exec(text).groups;
  const name = rawName.toLowerCase();
  const [first, ...rest] = name.split("/");
  const hasRegistry =
    rest.length > 0 &&
    (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasRegistry) {
    return { name, registry: first, repository: rest.join("/"), tag };
  }
  return {
    name,
    registry: "registry-1.docker.io",
    repository: rest.length > 0 ? name : `library/${name}`,
    tag,
  };
};

const scheme = (registry) =>
  registry.startsWith("localhost") || registry.startsWith("127.0.0.1")
    ? "http"
    : "https";

/** Trades the registry's 401 challenge for a pull token. */
const authorize = async (challenge, credentials) => {
  const parts = Object.fromEntries(
    [...challenge.matchAll(CHALLENGE_PART)].map((match) => [
      match.groups.key,
      match.groups.value,
    ])
  );
  if (!parts.realm) {
    throw new Error(`unsupported registry authentication: ${challenge}`);
  }
  const url = new URL(parts.realm);
  for (const key of ["service", "scope"]) {
    if (parts[key]) {
      url.searchParams.set(key, parts[key]);
    }
  }
  const headers = {};
  if (credentials.password) {
    headers.Authorization = `Basic ${Buffer.from(
      `${credentials.username || "token"}:${credentials.password}`
    ).toString("base64")}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`the registry refused the credentials (${response.status})`);
  }
  const body = await response.json();
  return body.token ?? body.access_token;
};

/**
 * Returns `{ digest, revision }` of an image: the digest its tag points at,
 * and the commit it was built from (the org.opencontainers.image.revision
 * label, "" when the image has none). Throws when the registry cannot be
 * read or the tag does not exist.
 */
export const inspectImage = async (image, credentials = {}) => {
  const base = `${scheme(image.registry)}://${image.registry}/v2/${image.repository}`;
  let token;
  const get = async (path, accept) => {
    const request = () =>
      fetch(`${base}${path}`, {
        headers: {
          Accept: accept,
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        signal: AbortSignal.timeout(30_000),
      });
    let response = await request();
    if (response.status === 401 && !token) {
      token = await authorize(
        response.headers.get("www-authenticate") ?? "",
        credentials
      );
      response = await request();
    }
    if (response.status === 404) {
      throw new Error(`${image.name}:${image.tag} does not exist`);
    }
    if (!response.ok) {
      throw new Error(`the registry answered ${response.status} for ${path}`);
    }
    return response;
  };

  const response = await get(`/manifests/${image.tag}`, ACCEPT);
  const text = await response.text();
  const digest =
    response.headers.get("docker-content-digest") ??
    `sha256:${createHash("sha256").update(text).digest("hex")}`;

  let revision = "";
  try {
    let manifest = JSON.parse(text);
    if (Array.isArray(manifest.manifests)) {
      // An index: read the first real platform (attestations are "unknown").
      const entry =
        manifest.manifests.find(
          (item) => item.platform?.os && item.platform.os !== "unknown"
        ) ?? manifest.manifests[0];
      manifest = await (await get(`/manifests/${entry.digest}`, ACCEPT)).json();
    }
    if (manifest.config?.digest) {
      const config = await (
        await get(`/blobs/${manifest.config.digest}`, "application/json")
      ).json();
      revision = config.config?.Labels?.[REVISION] ?? "";
    }
  } catch {
    // The revision is a nicety; the digest is what decides a deploy.
  }
  return { digest, revision };
};
