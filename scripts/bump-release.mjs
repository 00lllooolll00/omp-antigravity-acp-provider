import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/bump-release.mjs <semver>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const writeJson = (relative, value) => fs.writeFileSync(path.join(root, relative), JSON.stringify(value, null, 2) + "\n");
const writeText = (relative, value) => fs.writeFileSync(path.join(root, relative), value);

const pkg = readJson("package.json");
pkg.version = version;
writeJson("package.json", pkg);

const lock = readJson("package-lock.json");
lock.version = version;
lock.packages[""].version = version;
writeJson("package-lock.json", lock);

const launcher = readJson("marketplace/antigravity-acp/package.json");
launcher.version = version;
writeJson("marketplace/antigravity-acp/package.json", launcher);

const provisionPath = "marketplace/antigravity-acp/provision.ts";
const provision = fs.readFileSync(path.join(root, provisionPath), "utf8")
  .replace(/(export const ADAPTER_VERSION = ")[^"]+(";)/, `$1${version}$2`);
writeText(provisionPath, provision);

const marketplace = readJson(".omp-plugin/marketplace.json");
const plugin = marketplace.plugins?.find(entry => entry.name === "omp-antigravity-acp-provider");
if (!plugin) {
  console.error("marketplace plugin entry not found");
  process.exit(1);
}
plugin.version = version;
writeJson(".omp-plugin/marketplace.json", marketplace);

console.log(`bumped release metadata to ${version}`);
