import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createClient, pick } from "../lib/coolify.mjs";
import { ensureDatabase } from "../lib/database.mjs";
import { setSharedVariables } from "../lib/shared-variables.mjs";
import { startCoolify } from "./mock-coolify.mjs";

const quiet = { info() {}, warning() {} };
let coolify;
let deps;
beforeEach(async () => {
  coolify = await startCoolify({ shared: ["BETTER_AUTH_SECRET"] });
  deps = {
    api: createClient({ pause: 0, token: "secret", url: coolify.url }),
    log: quiet,
    sleep: () => Promise.resolve(),
  };
});
afterEach(() => coolify.close());

// No project or server named: the mock Coolify has one of each.
const target = { environment: "production" };

describe("ensureDatabase", () => {
  it("creates and starts PostgreSQL, and returns its internal URL", async () => {
    const result = await ensureDatabase({ ...target, name: "postgres", type: "postgresql" }, deps);
    const [database] = coolify.state.databases;
    assert.equal(result.created, true);
    assert.equal(result.uuid, database.uuid);
    assert.equal(database.instant_deploy, true);
    assert.equal(database.project_uuid, "proj-1");
    assert.equal(database.server_uuid, "srv-1");
    assert.match(database.postgres_password, /^[0-9a-f]{48}$/u);
    assert.equal(
      result.url,
      `postgres://postgres:${database.postgres_password}@${database.uuid}:5432/postgres`
    );
  });

  it("sends Redis its configuration base64-encoded", async () => {
    const result = await ensureDatabase(
      { ...target, config: "appendonly yes\n", name: "redis", type: "redis" },
      deps
    );
    const [database] = coolify.state.databases;
    assert.equal(Buffer.from(database.redis_conf, "base64").toString(), "appendonly yes\n");
    assert.equal(result.url, `redis://default:${database.redis_password}@${database.uuid}:6379/0`);
  });

  it("leaves an existing database alone", async () => {
    await ensureDatabase({ ...target, name: "postgres", type: "postgresql" }, deps);
    coolify.state.requests.length = 0;
    const result = await ensureDatabase({ ...target, name: "postgres", type: "postgresql" }, deps);
    assert.deepEqual({ created: result.created, url: result.url }, { created: false, url: null });
    assert.deepEqual(coolify.writes(), []);
  });

  it("rejects an unknown type", async () => {
    await assert.rejects(ensureDatabase({ ...target, name: "x", type: "mysql" }, deps), /postgresql or redis/u);
  });
});

describe("pick", () => {
  const items = [{ name: "a", uuid: "1" }, { name: "b", uuid: "2" }];

  it("takes the only item when none is named", () => {
    assert.deepEqual(pick([items[0]], undefined, "project"), items[0]);
  });

  it("asks for a name when there are several", () => {
    assert.throws(() => pick(items, "", "project"), /several projects \(a, b\)\. Name the one to use/u);
  });
});

describe("setSharedVariables with onlyMissing", () => {
  it("creates missing keys and keeps existing values", async () => {
    const result = await setSharedVariables(
      {
        environment: "production",
        onlyMissing: true,
        scope: "environment",
        variables: new Map([
          ["BETTER_AUTH_SECRET", "new"],
          ["DATABASE_URL", "postgres://db"],
        ]),
      },
      deps
    );
    assert.deepEqual(result, { created: ["DATABASE_URL"], removed: [], updated: [] });
    assert.equal(coolify.state.shared.find((item) => item.key === "BETTER_AUTH_SECRET").value, "x");
  });
});
