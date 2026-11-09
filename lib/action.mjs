// The few pieces of the GitHub Actions runtime these actions need: inputs,
// outputs, log commands and the run summary. No dependencies, so the actions
// run straight from the repository without a build step.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const escapeData = (text) =>
  String(text)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");

const command = (name, message) =>
  process.stdout.write(`::${name}::${escapeData(message)}\n`);

export const log = {
  info: (message) => process.stdout.write(`${message}\n`),
  notice: (message) => command("notice", message),
  warning: (message) => command("warning", message),
  error: (message) => command("error", message),
};

/** Hides a value in the logs of the rest of the job. */
export const mask = (value) => {
  if (value) {
    command("add-mask", value);
  }
};

/**
 * Reads an input. `env` names an environment variable used when the input is
 * empty, so a workflow can set the connection once for every step.
 */
export const input = (name, { env, required = false, fallback = "" } = {}) => {
  const value =
    (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim() ||
    (env ? (process.env[env] ?? "").trim() : "") ||
    fallback;
  if (required && !value) {
    throw new Error(
      env
        ? `Set the \`${name}\` input or the ${env} environment variable.`
        : `Set the \`${name}\` input.`
    );
  }
  return value;
};

/** The non-empty lines of a multi-line input; lines starting with # are comments. */
export const lines = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

export const boolean = (name, text) => {
  const value = String(text).trim().toLowerCase();
  if (value === "true" || value === "false") {
    return value === "true";
  }
  throw new Error(`\`${name}\` must be true or false, not "${text}".`);
};

const DURATION = /^(?<amount>\d+)\s*(?<unit>s|m|h)?$/u;
const SECONDS = { h: 3600, m: 60, s: 1 };

/** "90", "90s", "15m" or "1h", in seconds. */
export const duration = (name, text) => {
  const match = DURATION.exec(String(text).trim());
  if (!match) {
    throw new Error(
      `\`${name}\` must be a duration such as 30s, 15m or 1h, not "${text}".`
    );
  }
  return Number(match.groups.amount) * SECONDS[match.groups.unit ?? "s"];
};

export const integer = (name, text) => {
  const value = Number(String(text).trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`\`${name}\` must be a whole number, not "${text}".`);
  }
  return value;
};

export const setOutput = (name, value) => {
  if (!process.env.GITHUB_OUTPUT) {
    log.info(`${name}=${value}`);
    return;
  }
  const delimiter = `output_${randomUUID()}`;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`
  );
};

/** Appends Markdown to the run's summary page. */
export const summary = (markdown) => {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
};

export const sleep = (seconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });

/** Runs an action: an error fails the step with its message as an annotation. */
export const main = async (run) => {
  try {
    await run();
  } catch (error) {
    log.error(error.message);
    process.exitCode = 1;
  }
};
