import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { createClient } from "../lib/coolify.mjs";
import {
  deployImage,
  parseMemory,
  parseExtraHosts,
  parseNetworkAliases,
  parseVolumes,
} from "../lib/application.mjs";
import { inspectImage, parseImage } from "../lib/registry.mjs";
import { startCoolify, startRegistry } from "./mock-coolify.mjs";

const quiet = { info() {}, notice() {}, warning() {} };
const noSleep = () => Promise.resolve();

const spec = (overrides = {}) => ({
  digest: "sha256:aaa",
  domain: "https://api.example.com",
  env: new Map([
    ["LOG_LEVEL", "info"],
    ["DATABASE_URL", "{{environment.DATABASE_URL}}"],
    ["EMPTY", ""],
  ]),
  environment: "production",
  force: false,
  image: { name: "ghcr.io/acme/shop/api", tag: "one" },
  labels: new Map([["traefik.enable", "true"]]),
  name: "api",
  port: "3000",
  project: "shop",
  pruneEnv: false,
  server: "pi",
  stopGracePeriod: 30,
  timeout: 60,
  volumes: parseVolumes(["api_data:/data"]),
  wait: true,
  ...overrides,
});

describe("deployImage", () => {
  let coolify;
  let deps;
  beforeEach(async () => {
    coolify = await startCoolify({ shared: ["DATABASE_URL"] });
    deps = {
      api: createClient({ pause: 0, token: "secret", url: coolify.url }),
      log: quiet,
      sleep: noSleep,
    };
  });
  after(() => coolify?.close());

  it("creates the application, configures it and deploys", async () => {
    const result = await deployImage(spec(), deps);
    assert.deepEqual(
      { changed: result.changed, created: result.created, uuid: result.uuid },
      { changed: true, created: true, uuid: "app-1" }
    );
    const [application] = coolify.state.applications;
    assert.equal(application.name, "api");
    assert.equal(application.docker_registry_image_name, "ghcr.io/acme/shop/api");
    assert.equal(application.docker_registry_image_tag, "one");
    assert.equal(application.domains, "https://api.example.com");
    assert.equal(application.ports_exposes, "3000");
    assert.equal(application.stop_grace_period, 30);
    assert.equal(application.project_uuid, "proj-1");
    assert.equal(application.server_uuid, "srv-1");
    assert.equal(
      Buffer.from(application.custom_labels, "base64").toString(),
      "coolify.managed=true\ntraefik.enable=true"
    );
    assert.deepEqual(
      coolify.state.envs["app-1"].map((env) => env.key),
      ["LOG_LEVEL", "DATABASE_URL"]
    );
    assert.deepEqual(coolify.state.storages["app-1"], [
      { mount_path: "/data", name: "api_data", type: "persistent" },
    ]);
    assert.equal(coolify.state.deployments.length, 1);
    assert.match(application.description, /^\(deployed [0-9a-f]{12}\)$/u);
    await coolify.close();
  });

  it("does nothing on a second run with the same declaration", async () => {
    await deployImage(spec(), deps);
    coolify.state.requests.length = 0;
    const result = await deployImage(spec(), deps);
    assert.equal(result.changed, false);
    assert.deepEqual(coolify.writes(), []);
    await coolify.close();
  });

  it("only moves the tag when a new tag points at the same image", async () => {
    await deployImage(spec(), deps);
    coolify.state.requests.length = 0;
    const result = await deployImage(
      spec({ image: { name: "ghcr.io/acme/shop/api", tag: "two" } }),
      deps
    );
    assert.equal(result.changed, false);
    assert.deepEqual(coolify.writes(), ["PATCH /applications/app-1"]);
    assert.equal(coolify.state.applications[0].docker_registry_image_tag, "two");
    await coolify.close();
  });

  for (const [what, overrides] of [
    ["the image", { digest: "sha256:bbb" }],
    ["an environment variable", { env: new Map([["LOG_LEVEL", "debug"]]) }],
    ["the domain", { domain: "https://api2.example.com" }],
    ["a network alias", { networkAliases: ["api.internal"] }],
    ["an extra host", { extraHosts: ["host.docker.internal:host-gateway"] }],
    ["the memory limit", { memory: "768m" }],
    ["force", { force: true }],
  ]) {
    it(`deploys again when ${what} changed`, async () => {
      await deployImage(spec(), deps);
      const result = await deployImage(spec(overrides), deps);
      assert.deepEqual(
        { changed: result.changed, created: result.created },
        { changed: true, created: false }
      );
      assert.equal(coolify.state.deployments.length, 2);
      assert.equal(coolify.state.applications.length, 1);
      await coolify.close();
    });
  }

  it("sets network aliases, and leaves Coolify's alone when none are declared", async () => {
    await deployImage(spec(), deps);
    assert.equal(coolify.state.applications[0].custom_network_aliases, undefined);
    await deployImage(
      spec({ networkAliases: ["api.example.com.internal", "api"] }),
      deps
    );
    assert.equal(
      coolify.state.applications[0].custom_network_aliases,
      "api.example.com.internal,api"
    );
    await coolify.close();
  });

  it("sets extra hosts as docker run options, and leaves Coolify's alone when none are declared", async () => {
    await deployImage(spec(), deps);
    assert.equal(coolify.state.applications[0].custom_docker_run_options, undefined);
    await deployImage(
      spec({ extraHosts: ["host.docker.internal:host-gateway", "db:10.0.0.5"] }),
      deps
    );
    assert.equal(
      coolify.state.applications[0].custom_docker_run_options,
      "--add-host=host.docker.internal:host-gateway --add-host=db:10.0.0.5"
    );
    await coolify.close();
  });

  it("sets the memory limit, and leaves Coolify's alone when none is declared", async () => {
    await deployImage(spec(), deps);
    assert.equal(coolify.state.applications[0].limits_memory, undefined);
    await deployImage(spec({ memory: "1g" }), deps);
    assert.equal(coolify.state.applications[0].limits_memory, "1g");
    coolify.state.requests.length = 0;
    assert.equal((await deployImage(spec({ memory: "1g" }), deps)).changed, false);
    await deployImage(spec({ memory: "0" }), deps);
    assert.equal(coolify.state.applications[0].limits_memory, "0");
    await coolify.close();
  });

  it("deploys again when the application is not running", async () => {
    await deployImage(spec(), deps);
    coolify.state.applications[0].status = "exited:unhealthy";
    assert.equal((await deployImage(spec(), deps)).changed, true);
    await coolify.close();
  });

  it("keeps your description and adds no second volume", async () => {
    await deployImage(spec(), deps);
    coolify.state.applications[0].description = `The API ${coolify.state.applications[0].description}`;
    await deployImage(spec({ digest: "sha256:bbb" }), deps);
    assert.match(coolify.state.applications[0].description, /^The API \(deployed [0-9a-f]{12}\)$/u);
    assert.equal(coolify.state.storages["app-1"].length, 1);
    await coolify.close();
  });

  it("removes undeclared variables only with prune-env", async () => {
    await deployImage(spec(), deps);
    const fewer = { env: new Map([["LOG_LEVEL", "info"]]) };
    await deployImage(spec(fewer), deps);
    assert.equal(coolify.state.envs["app-1"].length, 2);
    await deployImage(spec({ ...fewer, pruneEnv: true, force: true }), deps);
    assert.deepEqual(
      coolify.state.envs["app-1"].map((env) => env.key),
      ["LOG_LEVEL"]
    );
    await coolify.close();
  });

  it("fails on a failed deployment and tries again next time", async () => {
    coolify.state.deploymentStatus = "failed";
    await assert.rejects(deployImage(spec(), deps), /deployment dep-2 failed/u);
    assert.equal(coolify.state.applications[0].description, null);
    coolify.state.deploymentStatus = "finished";
    assert.equal((await deployImage(spec(), deps)).changed, true);
    await coolify.close();
  });

  it("gives up after the timeout", async () => {
    coolify.state.deploymentStatus = "in_progress";
    await assert.rejects(deployImage(spec({ timeout: 0 }), deps), /still "in_progress" after 0s/u);
    await coolify.close();
  });

  it("does not wait when told not to", async () => {
    coolify.state.deploymentStatus = "in_progress";
    const result = await deployImage(spec({ wait: false }), deps);
    assert.equal(result.deployment, "dep-2");
    await coolify.close();
  });

  it("stops before any change when a shared variable is missing", async () => {
    const env = new Map([["API_KEY", "{{environment.API_KEY}}"]]);
    await assert.rejects(deployImage(spec({ env }), deps), /environment\.API_KEY \(used by API_KEY\)/u);
    assert.deepEqual(coolify.writes(), []);
    await coolify.close();
  });

  it("names the choices when the project or environment is unknown", async () => {
    await assert.rejects(deployImage(spec({ project: "nope" }), deps), /no project called "nope". It has: shop/u);
    await assert.rejects(deployImage(spec({ environment: "staging" }), deps), /no environment called "staging"/u);
    await coolify.close();
  });

  it("explains a rejected token", async () => {
    const api = createClient({ pause: 0, token: "wrong", url: coolify.url });
    await assert.rejects(deployImage(spec(), { ...deps, api }), /401.*Check the token/u);
    await coolify.close();
  });
});

describe("parseMemory", () => {
  it("accepts what Coolify accepts, and nothing", () => {
    assert.equal(parseMemory(""), "");
    assert.equal(parseMemory(" 768M "), "768m");
    assert.equal(parseMemory("0"), "0");
    assert.equal(parseMemory("1g"), "1g");
  });

  it("refuses a size without a unit or with Docker's long units", () => {
    assert.throws(() => parseMemory("512"), /not a memory size/u);
    assert.throws(() => parseMemory("1gb"), /not a memory size/u);
    assert.throws(() => parseMemory("1.5g"), /not a memory size/u);
  });
});

describe("parseNetworkAliases", () => {
  it("takes one per line or comma-separated", () => {
    assert.deepEqual(parseNetworkAliases(["a.internal, b", "c_d-e"]), [
      "a.internal",
      "b",
      "c_d-e",
    ]);
  });
  it("rejects what Docker would not resolve", () => {
    assert.throws(() => parseNetworkAliases(["http://auth"]), /not a valid network alias/u);
    assert.throws(() => parseNetworkAliases(["auth host"]), /not a valid network alias/u);
  });
});

describe("parseExtraHosts", () => {
  it("takes one per line or comma-separated", () => {
    assert.deepEqual(
      parseExtraHosts(["host.docker.internal:host-gateway, db:10.0.0.5", "v6:fd00::1"]),
      ["host.docker.internal:host-gateway", "db:10.0.0.5", "v6:fd00::1"]
    );
  });
  it("rejects what --add-host would not take", () => {
    assert.throws(() => parseExtraHosts(["host.docker.internal"]), /not an extra host/u);
    assert.throws(() => parseExtraHosts(["a b:1.2.3.4"]), /not an extra host/u);
    assert.throws(() => parseExtraHosts(["db:--privileged"]), /not an extra host/u);
  });
});

describe("parseImage", () => {
  for (const [reference, expected] of [
    ["ghcr.io/Acme/Shop/api:abc", { name: "ghcr.io/acme/shop/api", registry: "ghcr.io", repository: "acme/shop/api", tag: "abc" }],
    ["nginx", { name: "nginx", registry: "registry-1.docker.io", repository: "library/nginx", tag: "latest" }],
    ["acme/api:1.2", { name: "acme/api", registry: "registry-1.docker.io", repository: "acme/api", tag: "1.2" }],
    ["localhost:5000/api", { name: "localhost:5000/api", registry: "localhost:5000", repository: "api", tag: "latest" }],
  ]) {
    it(reference, () => assert.deepEqual(parseImage(reference), expected));
  }
  it("rejects digests and blanks", () => {
    assert.throws(() => parseImage("nginx@sha256:abc"), /not a digest/u);
    assert.throws(() => parseImage(""), /image reference/u);
  });
});

describe("the image action, end to end", () => {
  let coolify;
  let registry;
  before(async () => {
    coolify = await startCoolify();
    registry = await startRegistry({
      "acme/api:one": { digest: "sha256:aaa", revision: "0123456789abcdef" },
    });
  });
  after(() => Promise.all([coolify.close(), registry.close()]));

  it("reads the digest and revision from the registry", async () => {
    const host = registry.url.replace("http://", "");
    assert.deepEqual(await inspectImage(parseImage(`${host}/acme/api:one`)), {
      digest: "sha256:aaa",
      revision: "0123456789abcdef",
    });
    await assert.rejects(inspectImage(parseImage(`${host}/acme/api:two`)), /does not exist/u);
  });

  it("runs from inputs and writes outputs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "coolify-actions-"));
    const output = join(directory, "output");
    writeFileSync(output, "");
    writeFileSync(join(directory, "api.env"), "LOG_LEVEL=info\nMODE=file\n");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(import.meta.dirname, "../image/main.mjs")],
      {
        cwd: directory,
        env: {
          COOLIFY_PROJECT: "shop",
          COOLIFY_SERVER: "pi",
          COOLIFY_TOKEN: "secret",
          COOLIFY_URL: coolify.url,
          GITHUB_OUTPUT: output,
          INPUT_ENV: "MODE=inline",
          "INPUT_ENV-FILES": "api.env",
          INPUT_IMAGE: `${registry.url.replace("http://", "")}/acme/api:one`,
          INPUT_NAME: "api",
          INPUT_PORT: "3000",
          PATH: process.env.PATH,
        },
      }
    );
    assert.match(stdout, /::add-mask::secret/u);
    const outputs = readFileSync(output, "utf8");
    for (const expected of ["uuid<<", "\napp-1\n", "changed<<", "\ntrue\n", "\nsha256:aaa\n", "\n0123456789abcdef\n"]) {
      assert.ok(outputs.includes(expected), `outputs should include ${JSON.stringify(expected)}`);
    }
    assert.deepEqual(
      coolify.state.envs["app-1"].map((env) => `${env.key}=${env.value}`),
      ["LOG_LEVEL=info", "MODE=inline"]
    );
  });
});
