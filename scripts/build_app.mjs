import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!["darwin", "win32"].includes(process.platform)) {
  throw new Error("应用构建支持 macOS 和 Windows。");
}
const worker = join(root, "src-tauri/resources/worker");
if (!existsSync(worker)) throw new Error("请先运行 pnpm worker:build。");
const args = [
  join(root, "node_modules/@tauri-apps/cli/tauri.js"),
  "build",
  ...(process.platform === "darwin" ? ["--bundles", "app"] : ["--no-bundle"]),
];
const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.platform === "win32") {
  const destination = join(
    root,
    "src-tauri/target/release/bundle/portable/DUO Killer",
  );
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(
    join(root, "src-tauri/target/release/duo-killer.exe"),
    join(destination, "DUO Killer.exe"),
  );
  cpSync(worker, join(destination, "worker"), { recursive: true });
  console.log(`应用目录：${destination}（请保留整个目录）`);
}
