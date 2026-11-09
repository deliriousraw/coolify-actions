import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { duration } from "../lib/action.mjs";
import { parsePairs } from "../lib/pairs.mjs";
import { waitForHttp } from "../lib/wait-for-http.mjs";
import { locationsIn, warmSitemap } from "../lib/warm-sitemap.mjs";

const quiet = { info() {}, warning() {} };
const noSleep = () => Promise.resolve();

describe("a small site", () => {
  let server;
  let url;
  let hits;
  let readyAfter;
  before(async () => {
    server = createServer((request, response) => {
      hits.push(request.url);
      const origin = `http://${request.headers.host}`;
      const send = (status, body) => response.writeHead(status).end(body);
      if (request.url === "/api/ready") {
        readyAfter -= 1;
        return readyAfter >= 0
          ? send(503, '{"status":"warming"}')
          : send(200, '{"version":"abc","checks":{"database":"ok"}}');
      }
      if (request.url === "/sitemap.xml") {
        return send(200, `<sitemapindex><sitemap><loc>${origin}/pages.xml</loc></sitemap><sitemap><loc>https://elsewhere.test/other.xml</loc></sitemap></sitemapindex>`);
      }
      if (request.url === "/pages.xml") {
        return send(200, `<urlset><url><loc>${origin}/</loc><xhtml:link rel="alternate" hreflang="uk" href="${origin}/uk?a=1&amp;b=2"/></url><url><loc>${origin}/broken</loc></url><url><loc>https://elsewhere.test/x</loc></url></urlset>`);
      }
      return send(request.url === "/broken" ? 500 : 200, "ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  const wait = (overrides = {}) =>
    waitForHttp(
      { interval: 0, json: "", status: 200, timeout: 30, url: `${url}/api/ready`, ...overrides },
      { log: quiet, sleep: noSleep }
    );

  it("waits until the status is right", async () => {
    hits = [];
    readyAfter = 2;
    assert.equal(await wait(), 3);
  });

  it("waits for values in the JSON body", async () => {
    hits = [];
    readyAfter = 0;
    assert.equal(await wait({ json: "version=abc\nchecks.database=ok" }), 1);
  });

  it("fails after the timeout, saying what was wrong", async () => {
    hits = [];
    readyAfter = 0;
    await assert.rejects(wait({ json: "version=xyz", timeout: 0 }), /version is "abc", expected "xyz"/u);
    readyAfter = 99;
    await assert.rejects(wait({ timeout: 0 }), /answered 503, expected 200/u);
  });

  it("requests every page of the sitemap on the same origin", async () => {
    hits = [];
    const result = await warmSitemap(
      { concurrency: 2, limit: 500, timeout: 5, urls: [url] },
      { log: quiet }
    );
    assert.deepEqual(hits.filter((hit) => !hit.endsWith(".xml")).sort(), ["/", "/broken", "/uk?a=1&b=2"]);
    assert.equal(result.requested, 3);
    assert.deepEqual(result.failed, [`500 ${url}/broken`]);
  });

  it("respects the limit and reports an unreadable sitemap", async () => {
    hits = [];
    const result = await warmSitemap(
      { concurrency: 1, limit: 1, timeout: 5, urls: [url, "http://127.0.0.1:1"] },
      { log: quiet }
    );
    assert.equal(result.requested, 1);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0], /^sitemap http:\/\/127\.0\.0\.1:1/u);
  });
});

describe("input formats", () => {
  it("reads KEY=value lines", () => {
    assert.deepEqual(
      [...parsePairs('A=1\n# note\n\nB = "two words"\nC=x=y\nA=3')],
      [["A", "3"], ["B", "two words"], ["C", "x=y"]]
    );
    assert.throws(() => parsePairs("nonsense", "label"), /each label as KEY=value/u);
  });
  it("reads durations", () => {
    assert.equal(duration("timeout", "90"), 90);
    assert.equal(duration("timeout", "15m"), 900);
    assert.equal(duration("timeout", "1h"), 3600);
    assert.throws(() => duration("timeout", "soon"), /30s, 15m or 1h/u);
  });
  it("finds locations in a sitemap", () => {
    assert.deepEqual(locationsIn("<loc> https://a.test/ </loc>"), ["https://a.test/"]);
  });
});
