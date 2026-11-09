import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deployDockerfile } from "../lib/application.mjs";
import { createClient } from "../lib/coolify.mjs";
import { deployService } from "../lib/service.mjs";
import { setSharedVariables } from "../lib/shared-variables.mjs";
import { startCoolify } from "./mock-coolify.mjs";

const quiet = { info() {}, warning() {} };
let coolify;
let deps;
beforeEach(async () => {
  coolify = await startCoolify({ shared: ["GRAFANA_PASSWORD"] });
  deps = {
    api: createClient({ pause: 0, token: "secret", url: coolify.url }),
    log: quiet,
    sleep: () => Promise.resolve(),
  };
});
afterEach(() => coolify.close());

const target = { environment: "production", project: "shop", server: "pi" };

describe("deployDockerfile", () => {
  const spec = (dockerfile) => ({
    ...target,
    dockerfile,
    domain: "https://docs.example.com",
    env: new Map(),
    force: false,
    labels: new Map(),
    name: "docs",
    port: "80",
    pruneEnv: false,
    timeout: 60,
    volumes: [],
    wait: true,
  });

  it("creates the application from the Dockerfile's content", async () => {
    const result = await deployDockerfile(spec("FROM nginx\n"), deps);
    assert.deepEqual({ changed: result.changed, created: result.created }, { changed: true, created: true });
    assert.ok(coolify.writes().includes("POST /applications/dockerfile"));
    assert.equal(Buffer.from(coolify.state.applications[0].dockerfile, "base64").toString(), "FROM nginx\n");
  });

  it("rebuilds only when the Dockerfile changed", async () => {
    await deployDockerfile(spec("FROM nginx\n"), deps);
    assert.equal((await deployDockerfile(spec("FROM nginx\n"), deps)).changed, false);
    assert.equal((await deployDockerfile(spec("FROM caddy\n"), deps)).changed, true);
    assert.equal(coolify.state.deployments.length, 2);
  });
});

describe("deployService", () => {
  const spec = (overrides = {}) => ({
    ...target,
    compose: "services:\n  grafana:\n    image: grafana/grafana\n",
    env: new Map([["GRAFANA_PASSWORD", "{{environment.GRAFANA_PASSWORD}}"]]),
    force: false,
    name: "monitoring",
    timeout: 60,
    urls: new Map([["grafana", "https://grafana.example.com"]]),
    wait: true,
    ...overrides,
  });

  it("creates, configures and starts the service", async () => {
    const result = await deployService(spec(), deps);
    assert.deepEqual(result, { changed: true, created: true, uuid: "svc-1" });
    const [service] = coolify.state.services;
    assert.equal(Buffer.from(service.docker_compose_raw, "base64").toString(), spec().compose);
    assert.deepEqual(service.urls, [{ name: "grafana", url: "https://grafana.example.com" }]);
    assert.deepEqual(coolify.state.envs["svc-1"], [
      { key: "GRAFANA_PASSWORD", value: "{{environment.GRAFANA_PASSWORD}}" },
    ]);
    assert.ok(coolify.writes().includes("POST /services/svc-1/start"));
    assert.match(service.description, /^\[deployed [0-9a-f]{12}\]$/u);
  });

  it("does nothing the second time, and restarts when the file changed", async () => {
    await deployService(spec(), deps);
    coolify.state.requests.length = 0;
    assert.equal((await deployService(spec(), deps)).changed, false);
    assert.deepEqual(coolify.writes(), []);
    const result = await deployService(spec({ compose: "services: {}\n" }), deps);
    assert.deepEqual({ changed: result.changed, created: result.created }, { changed: true, created: false });
    assert.ok(coolify.writes().includes("POST /services/svc-1/restart?latest=true"));
  });

  it("fails when the service does not come up", async () => {
    coolify.state.serviceStatus = "exited:unhealthy";
    await assert.rejects(deployService(spec({ timeout: 0 }), deps), /"exited:unhealthy" after 0s: a container keeps stopping/u);
    assert.equal(coolify.state.services[0].description, null);
  });
});

describe("setSharedVariables", () => {
  const spec = (variables, overrides = {}) => ({
    environment: "production",
    project: "shop",
    prune: false,
    scope: "environment",
    variables: new Map(Object.entries(variables)),
    ...overrides,
  });

  it("creates new variables and updates changed ones", async () => {
    const result = await setSharedVariables(spec({ DATABASE_URL: "postgres://db", GRAFANA_PASSWORD: "new" }), deps);
    assert.deepEqual(result, { created: ["DATABASE_URL"], removed: [], updated: ["GRAFANA_PASSWORD"] });
    assert.deepEqual(
      coolify.state.shared.map((item) => `${item.key}=${item.value}`),
      ["GRAFANA_PASSWORD=new", "DATABASE_URL=postgres://db"]
    );
  });

  it("writes nothing when they already match", async () => {
    const result = await setSharedVariables(spec({ GRAFANA_PASSWORD: "x" }), deps);
    assert.deepEqual(result, { created: [], removed: [], updated: [] });
    assert.deepEqual(coolify.writes(), []);
  });

  it("removes the others only with prune", async () => {
    const result = await setSharedVariables(spec({ A: "1" }, { prune: true }), deps);
    assert.deepEqual(result.removed, ["GRAFANA_PASSWORD"]);
    assert.deepEqual(coolify.state.shared.map((item) => item.key), ["A"]);
  });

  it("rejects an unknown scope", async () => {
    await assert.rejects(setSharedVariables(spec({}, { scope: "global" }), deps), /environment, project or team/u);
  });
});
