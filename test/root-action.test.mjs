import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Everything from `branding:` on: branding, inputs, outputs and runs.
const body = (text) => text.slice(text.indexOf("\nbranding:"));

describe("root action.yml", () => {
  it("mirrors image/action.yml apart from name, description and entry point", async () => {
    const [root, image] = await Promise.all([read("action.yml"), read("image/action.yml")]);
    assert.equal(
      body(root),
      body(image).replace("\n  main: main.mjs\n", "\n  main: image/main.mjs\n")
    );
  });

  it("keeps the description within the Marketplace's 125 characters", async () => {
    const root = await read("action.yml");
    const folded = root.match(/^description: >-\n((?: {2}.*\n)+)/m)[1];
    assert.ok(folded.replace(/\s+/g, " ").trim().length <= 125);
  });
});
