import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [crateDir, binName] = process.argv.slice(2);
if (!crateDir || !binName)
  throw new Error("usage: build-sidecar.mjs <crate-dir> <bin-name>");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const hostTriple = () =>
  execFileSync("rustc", ["-vV"])
    .toString()
    .match(/^host:\s*(\S+)$/m)?.[1];

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
if (!triple) throw new Error("could not determine the Rust target triple");

const args = [
  "build",
  "--release",
  "--manifest-path",
  `${crateDir}/Cargo.toml`,
];
// A universal bundle is a lipo of per-arch builds, not a rustc target; let cargo
// build for the host and Tauri lipos the slices it bundles.
if (triple !== hostTriple() && !triple.includes("universal"))
  args.push("--target", triple);

execFileSync("cargo", args, { cwd: root, stdio: "inherit" });

const built = resolve(
  root,
  args.includes("--target")
    ? `${crateDir}/target/${triple}/release/${binName}`
    : `${crateDir}/target/release/${binName}`,
);
const dest = resolve(root, "src-tauri/binaries", `${binName}-${triple}`);
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(built, dest);
console.log(`sidecar staged: ${dest}`);
