// KEY=value text, as in a .env file: the format of the `env`, `env-files`
// and `labels` inputs.

import { readFileSync } from "node:fs";

const LINE = /^(?<key>[^=\s]+)\s*=\s*(?<value>.*)$/u;
const QUOTED = /^(?<quote>["'])(?<inner>.*)\k<quote>$/u;

/**
 * Parses KEY=value lines into a Map. Blank lines and lines starting with #
 * are skipped; quotes around a value are removed; a later line wins.
 */
export const parsePairs = (text, what = "line") => {
  const pairs = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = LINE.exec(line);
    if (!match) {
      throw new Error(`Write each ${what} as KEY=value, not "${line}".`);
    }
    const value = match.groups.value.trim();
    pairs.set(match.groups.key, QUOTED.exec(value)?.groups.inner ?? value);
  }
  return pairs;
};

/** The pairs of several files, then of `inline`; later ones win. */
export const readPairs = ({ files = [], inline = "", what }) => {
  const pairs = new Map();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new Error(
        `Cannot read ${file}. Paths are relative to the repository root, and the job needs an actions/checkout step first.`
      );
    }
    for (const [key, value] of parsePairs(text, what)) {
      pairs.set(key, value);
    }
  }
  for (const [key, value] of parsePairs(inline, what)) {
    pairs.set(key, value);
  }
  return pairs;
};
