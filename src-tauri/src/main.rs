#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod engine;
use engine::{Account, Engine, PresetItem, Snapshot, TaskHost};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn snapshot(state: State<'_, Arc<Engine>>) -> Snapshot {
    state.snapshot()
}
#[tauri::command]
fn add_account(state: State<'_, Arc<Engine>>, email: String) -> Result<Account, String> {
    state.add_account(email)
}
#[tauri::command]
async fn remove_account(
    host: State<'_, TaskHost>,
    state: State<'_, Arc<Engine>>,
    account_id: String,
) -> Result<(), String> {
    state.remove_account(host.inner(), &account_id).await
}
#[tauri::command]
fn save_preset(
    state: State<'_, Arc<Engine>>,
    account_id: String,
    items: Vec<PresetItem>,
) -> Result<Account, String> {
    state.save_preset(&account_id, items)
}
#[tauri::command]
async fn start_task(
    host: State<'_, TaskHost>,
    state: State<'_, Arc<Engine>>,
    account_id: String,
    action: String,
    params: Option<Value>,
) -> Result<String, String> {
    state.inner().start(
        host.inner().clone(),
        account_id,
        action,
        params.unwrap_or_else(|| json!({})),
    )
}
#[tauri::command]
fn reply_task(
    host: State<'_, TaskHost>,
    state: State<'_, Arc<Engine>>,
    account_id: String,
    task_id: String,
    request_id: String,
    value: Value,
) -> Result<(), String> {
    state.reply(host.inner(), &account_id, &task_id, &request_id, value)
}
// 桌面版的 webview 不接管 target=_blank：用系统默认浏览器打开官网页面。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() > 2048 {
        return Err("只允许打开 http(s) 链接".into());
    }
    #[cfg(target_os = "windows")]
    let program = "cmd";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    let mut command = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    command.args(["/C", "start", "", url]);
    #[cfg(not(target_os = "windows"))]
    command.arg(url);
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开浏览器：{e}"))
}

#[tauri::command]
fn cancel_task(
    state: State<'_, Arc<Engine>>,
    account_id: String,
    task_id: String,
) -> Result<(), String> {
    state.cancel(&account_id, &task_id)
}

fn main() {
    let closing = Arc::new(AtomicBool::new(false));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let engine = Engine::new(app.path().app_data_dir()?).map_err(std::io::Error::other)?;
            let handle = app.handle().clone();
            #[cfg(debug_assertions)]
            let (worker, script) = {
                let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap();
                (
                    root.join(if cfg!(windows) {
                        ".venv/Scripts/python.exe"
                    } else {
                        ".venv/bin/python"
                    }),
                    Some(root.join("worker/main.py")),
                )
            };
            #[cfg(not(debug_assertions))]
            let (worker, script) = (
                app.path()
                    .resource_dir()?
                    .join("worker")
                    .join(if cfg!(windows) {
                        "duo-killer-worker.exe"
                    } else {
                        "duo-killer-worker"
                    }),
                None,
            );
            app.manage(TaskHost {
                worker,
                script,
                on_update: Arc::new(move |task| {
                    let _ = handle.emit("task-updated", task);
                }),
            });
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            add_account,
            remove_account,
            save_preset,
            open_url,
            start_task,
            reply_task,
            cancel_task
        ])
        .build(tauri::generate_context!())
        .expect("无法启动 DUO Killer");
    app.run(move |app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !closing.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let app = app.clone();
                let engine = app.state::<Arc<Engine>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    engine.shutdown().await;
                    app.exit(0);
                });
            }
        }
    });
}
