import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!["darwin", "win32", "linux"].includes(process.platform)) {
  throw new Error("应用构建支持 macOS、Windows 和 Linux。");
}
const worker = join(root, "src-tauri/resources/worker");
if (!existsSync(worker)) throw new Error("请先运行 pnpm worker:build。");
// Windows 产出 NSIS 安装包（单文件 setup.exe）与 MSI；macOS 产出 .app 与 DMG；
// Linux 产出 deb 与 AppImage。
const bundles =
  process.platform === "darwin"
    ? "app,dmg"
    : process.platform === "win32"
      ? "nsis,msi"
      : "deb,appimage";
const args = [
  join(root, "node_modules/@tauri-apps/cli/tauri.js"),
  "build",
  "--bundles",
  bundles,
];
const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const bundle = join(root, "src-tauri/target/release/bundle");
if (process.platform === "win32") {
  const destination = join(bundle, "portable/DUO Killer");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(
    join(root, "src-tauri/target/release/duo-killer.exe"),
    join(destination, "DUO Killer.exe"),
  );
  cpSync(worker, join(destination, "worker"), { recursive: true });
  console.log(`免安装目录：${destination}（请保留整个目录）`);
}
const installers = [];
const { readdirSync } = await import("node:fs");
for (const folder of ["nsis", "msi", "dmg", "macos", "deb", "appimage", "rpm"]) {
  const dir = join(bundle, folder);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".app")) {
      installers.push(join(dir, name));
      continue;
    }
    const file = join(dir, name);
    const size = statSync(file).size;
    if (size > 1024 * 1024) installers.push(file);
  }
}
for (const file of installers) {
  const size = statSync(file).isDirectory()
    ? ""
    : ` · ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
  console.log(`安装包：${relative(root, file)}${size}`);
}
if (!installers.length && process.platform === "win32") {
  console.log("未找到安装包，请检查 src-tauri/target/release/bundle/nsis。");
}
