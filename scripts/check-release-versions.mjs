import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const readText = relative => fs.readFileSync(path.join(root, relative), "utf8");

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const launcher = readJson("marketplace/antigravity-acp/package.json");
const marketplace = readJson(".omp-plugin/marketplace.json");
const provision = readText("marketplace/antigravity-acp/provision.ts");
const plugin = marketplace.plugins?.find(entry => entry.name === "omp-antigravity-acp-provider");

const nameChecks = [
  ["package-lock.json name", lock.name],
  ["package-lock.json packages[''].name", lock.packages?.[""]?.name],
  ["marketplace launcher name", launcher.name],
  ["ADAPTER_NAME", provision.match(/export const ADAPTER_NAME = "([^"]+)"/)?.[1]],
];

const versionChecks = [
  ["package-lock.json version", lock.version],
  ["package-lock.json packages[''].version", lock.packages?.[""]?.version],
  ["marketplace launcher version", launcher.version],
  ["ADAPTER_VERSION", provision.match(/export const ADAPTER_VERSION = "([^"]+)"/)?.[1]],
  ["marketplace plugin version", plugin?.version],
];

const tagArg = process.argv.find(argument => argument.startsWith("--tag="));
if (tagArg) versionChecks.push(["tag", tagArg.slice("--tag=".length).replace(/^v/, "")]);

const failures = [];
for (const [label, actual] of nameChecks) {
  if (actual !== pkg.name) failures.push(`${label}: expected ${pkg.name}, got ${actual}`);
}
for (const [label, actual] of versionChecks) {
  if (actual !== pkg.version) failures.push(`${label}: expected ${pkg.version}, got ${actual}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`release metadata consistent: ${pkg.name}@${pkg.version}`);
