fn main() {
    // tauri.conf.json 的 bundle.resources 声明了 resources/worker/，tauri-build 会强校验该
    // 路径存在。开发态它可能还没生成（打包时由 scripts/build_worker.py 填入，且已被 git 忽略），
    // 这里先保证目录存在，避免全新克隆后 `pnpm desktop` 直接构建失败。
    let worker = std::path::Path::new("resources/worker");
    if !worker.is_dir() {
        let _ = std::fs::create_dir_all(worker);
    }
    tauri_build::build()
}
