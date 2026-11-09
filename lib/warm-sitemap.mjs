// Requests every page a sitemap lists, so a CDN or the app's own cache holds
// them before visitors ask. Used by the `warm-sitemap` action.

const LOCATION = /<loc>\s*(?<loc>[^<\s]+)\s*<\/loc>|<xhtml:link[^>]+href="(?<href>[^"]+)"/gu;
const SITEMAP = /\.xml(?:\.gz)?(?:\?.*)?$/u;

const get = (url, timeout) =>
  fetch(url, { signal: AbortSignal.timeout(timeout * 1000) });

/** Every <loc> and xhtml:link href of a sitemap, with &amp; decoded. */
export const locationsIn = (xml) =>
  [...xml.matchAll(LOCATION)].map((match) =>
    (match.groups.loc ?? match.groups.href).replaceAll("&amp;", "&")
  );

/** The pages of a site's sitemap (and of the sitemaps an index lists), same origin only. */
const pagesOf = async (site, { timeout }) => {
  const origin = new URL(site).origin;
  const root = SITEMAP.test(site)
    ? site
    : `${site.replace(/\/+$/u, "")}/sitemap.xml`;
  const response = await get(root, timeout);
  if (!response.ok) {
    throw new Error(`${root} answered ${response.status}`);
  }
  const found = locationsIn(await response.text());
  const pages = found.filter((url) => !SITEMAP.test(url));
  // A sitemap index lists more sitemaps: read those too (one level).
  const children = found.filter(
    (url) => SITEMAP.test(url) && url.startsWith(`${origin}/`)
  );
  for (const child of children) {
    const childResponse = await get(child, timeout);
    if (childResponse.ok) {
      pages.push(
        ...locationsIn(await childResponse.text()).filter(
          (url) => !SITEMAP.test(url)
        )
      );
    }
  }
  return [...new Set(pages.filter((url) => url.startsWith(`${origin}/`)))];
};

/**
 * @param options { urls: string[], limit, concurrency, timeout (seconds per request) }
 * @returns { requested, failed: ["<status> <url>"] }
 */
export const warmSitemap = async (options, { log }) => {
  let requested = 0;
  const failed = [];
  for (const site of options.urls) {
    let pages;
    try {
      pages = (await pagesOf(site, options)).slice(0, options.limit || undefined);
    } catch (error) {
      failed.push(`sitemap ${site} (${error.message})`);
      continue;
    }
    log.info(`Requesting ${pages.length} page(s) of ${site}`);
    const queue = [...pages];
    const worker = async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        requested += 1;
        try {
          const response = await get(url, options.timeout);
          await response.arrayBuffer();
          if (response.status >= 400) {
            failed.push(`${response.status} ${url}`);
          }
        } catch (error) {
          failed.push(`no answer ${url} (${error.cause?.code ?? error.name})`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, options.concurrency) }, worker)
    );
  }
  return { failed, requested };
};
