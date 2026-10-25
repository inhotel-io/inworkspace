#!/usr/bin/env node
// Builds the patched web admin: the upstream web UI at the pinned commit, this directory's overlay
// and patches, upstream's own checks, then a webui.zip laid out like upstream's release asset.
//
//   node webadmin/build.mjs --out webui.zip [--source-url <url>] [--local] [--keep]
//
// By default the npm steps run in Docker (upstream.json names the image), as upstream's release
// does: upstream's lockfile carries native build tools for Linux only. --local uses this machine's
// npm instead. Run from the console directory, after `npm ci` (the zip is written with fflate).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = JSON.parse(readFileSync(path.join(here, "upstream.json"), "utf8"));

function option(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}
const out = option("--out");
if (!out) {
  console.error("usage: node webadmin/build.mjs --out webui.zip [--source-url <url>] [--local] [--keep]");
  process.exit(2);
}
/** The source this build is made from: this checkout's commit on its GitHub remote. */
function defaultSourceUrl() {
  const git = (...args) => execFileSync("git", ["-C", here, ...args], { encoding: "utf8" }).trim();
  const remote = git("remote", "get-url", "origin").replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(remote)) throw new Error(`cannot link the source on ${remote}; pass --source-url`);
  if (git("status", "--porcelain", "--", ".") !== "") console.warn("warning: webadmin/ has uncommitted changes, which the source link does not show");
  const prefix = git("rev-parse", "--show-prefix");
  return `${remote}/tree/${git("rev-parse", "HEAD")}/${prefix}`.replace(/\/$/, "");
}
const sourceUrl = option("--source-url") ?? defaultSourceUrl();
const local = process.argv.includes("--local");
const keep = process.argv.includes("--keep");
const work = path.join(here, "work");
const tree = path.join(work, "webui");

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

step(`Fetching ${upstream.repository} at ${upstream.tag}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
run("git", ["clone", "--quiet", "--depth", "1", "--branch", upstream.tag, upstream.repository, tree]);
const commit = execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (commit !== upstream.commit) throw new Error(`${upstream.tag} is ${commit}, not the pinned ${upstream.commit}`);

step("Adding the overlay and applying the patches");
cpSync(path.join(here, "overlay"), tree, { recursive: true });
const patches = readdirSync(path.join(here, "patches"))
  .filter((name) => name.endsWith(".patch"))
  .sort();
for (const patch of patches) run("git", ["-C", tree, "apply", "--whitespace=error", path.join(here, "patches", patch)]);

step(`Running upstream's checks and build ${local ? "with this machine's npm" : `in ${upstream.node}`}`);
const script = "npm ci --no-audit --no-fund && npm run typecheck && npx eslint src/ && npx vitest run && npm run build";
const env = { VITE_INWORKSPACE_SOURCE_URL: sourceUrl };
if (local) {
  run("sh", ["-c", script], { cwd: tree, env: { ...process.env, ...env } });
} else {
  const user = typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
  run("docker", [
    "run", "--rm", ...user,
    "-e", "HOME=/tmp",
    "-e", `VITE_INWORKSPACE_SOURCE_URL=${sourceUrl}`,
    "-v", `${tree}:/webui`, "-w", "/webui",
    upstream.node, "sh", "-c", script,
  ]);
}

step("Packing dist/ as the release asset");
const dist = path.join(tree, "dist");
const entries = {};
// A fixed time and order for every entry, so the same build always gives the same zip.
const mtime = new Date("2000-01-01T00:00:00Z");
function add(directory, prefix) {
  for (const name of readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) add(full, `${prefix}${name}/`);
    else entries[`${prefix}${name}`] = [readFileSync(full), { mtime }];
  }
}
add(dist, "");
if (!entries["index.html"]) throw new Error("the build has no index.html");
const zip = zipSync(entries, { level: 9, mtime });
const target = path.resolve(out);
writeFileSync(target, zip);
const sha256 = createHash("sha256").update(zip).digest("hex");
console.log(`\n${target}\n${zip.length} bytes, sha256 ${sha256}\nweb UI ${upstream.tag} (${commit.slice(0, 12)}) with ${patches.length} patches`);

if (!keep && existsSync(work)) rmSync(work, { recursive: true, force: true });
