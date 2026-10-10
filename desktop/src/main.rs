//! Cline Pass 上游控制台 —— 桌面壳
//!
//! 职责只有一个：把 Node 服务进程管起来，并保证「退出就是真退出」。
//!
//! 防残留的三道闸（自我审计清单，缺一不可）：
//! 1. **Job Object（kill-on-close）**：服务进程从 spawn 起就挂进本壳的作业对象。
//!    作业句柄随壳进程消亡而关闭 → OS 层面无条件终止整棵子进程树。
//!    无论壳是正常退出、崩溃、被任务管理器强杀，子进程都不会残留。
//! 2. **优雅关停优先**：正常退出先请求服务端的 /api/shutdown（仅放行回环 + 无 Origin，
//!    浏览器跨源被中间件拦截），等服务落盘退出（≤8s），超时才 TerminateJobObject 兜底。
//! 3. **退出路径唯一**：托盘「退出」→ stop → app.exit(0)。关窗只是隐藏进托盘，不退出。
//!
//! IPC 约定：所有启停命令立即返回、后台线程执行，UI 通过 server_status 轮询推进状态。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PORT: u16 = 3123;
const HEALTHZ_TIMEOUT: Duration = Duration::from_secs(25);
const GRACEFUL_STOP: Duration = Duration::from_secs(8);
const LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;

/// 服务进程的持有状态。child 与 job 句柄的存活期 = 壳进程存活期。
struct ServerState {
    child: Mutex<Option<Child>>,
    /// Windows JOB 句柄（裸存 isize 以满足 Send/Sync；存活期 = 壳进程）
    job: isize,
    data_dir: PathBuf,
    entry: PathBuf,
    log_dir: PathBuf,
    /// 退出中：为 true 时窗口的 CloseRequested 不再被拦截（否则 app.exit 会被
    /// 自己的「关窗进托盘」逻辑拖住——托盘退出卡顿的根因）
    exiting: AtomicBool,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：把已有实例的窗口带到前台（避免双实例抢端口）
            show_main(app);
        }))
        .setup(|app| {
            let (data_dir, portable) = resolve_data_dir(app.handle());
            let log_dir = data_dir.join("logs");
            std::fs::create_dir_all(&log_dir)?;

            let handle = app.handle().clone();
            let entry = resolve_entry(&handle);
            let job = create_kill_on_close_job()?;
            app.manage(Arc::new(ServerState {
                child: Mutex::new(None),
                job: job.0 as isize,
                data_dir,
                entry,
                log_dir: log_dir.clone(),
                exiting: AtomicBool::new(false),
            }));

            log_line(
                &log_dir,
                &format!(
                    "[壳] 数据目录：{}（{}）",
                    log_dir.parent().unwrap_or(&log_dir).display(),
                    if portable { "便携模式：数据随 exe 目录" } else { "安装模式：%APPDATA%" }
                ),
            );

            build_tray(&handle)?;

            // 启动服务并等待就绪；就绪（或超时）后显示窗口
            std::thread::spawn(move || {
                {
                    let state = handle.state::<Arc<ServerState>>();
                    if let Err(err) = spawn_server(&state) {
                        log_line(&state.log_dir, &format!("[壳] 启动失败：{err}"));
                    }
                }
                let state = handle.state::<Arc<ServerState>>();
                if !wait_healthz(PORT, HEALTHZ_TIMEOUT) {
                    // 不打开窗口：对着 webview 错误页，用户不知道该点什么。
                    // 托盘「打开控制台 / 启动服务」会重试，成功后窗口才出现。
                    log_line(&state.log_dir, "[壳] 服务未能就绪：暂不打开窗口，可从托盘重试");
                    return;
                }
                show_main(&handle);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 隐藏进托盘（需求：退出点击自动进托盘）。
            // 例外：壳正在退出时必须放行关闭——否则 app.exit 被这里拖住，退出明显卡顿。
            if let WindowEvent::CloseRequested { api, .. } = event {
                let exiting = window
                    .app_handle()
                    .try_state::<Arc<ServerState>>()
                    .is_some_and(|s| s.exiting.load(Ordering::SeqCst));
                if exiting {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            server_status, server_start, server_stop, server_restart, open_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------- UI 桥（注入到控制台页面，重载/跳转后依然生效） ----------

const BRIDGE_SCRIPT: &str = r#"(() => {
  // 屏蔽 WebView2 默认右键菜单的打印/扩展项（「优质打印」预览的来源），
  // 保留输入框的右键粘贴；拦截 Ctrl+P 打印预览。控制台不需要打印。
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    const editable = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
    if (!editable) e.preventDefault();
  }, true);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) e.preventDefault();
  }, true);

  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke) return;
  window.cpsHost = {
    hosted: true,
    status: () => invoke('server_status'),
    start: () => invoke('server_start'),
    stop: () => invoke('server_stop'),
    restart: () => invoke('server_restart'),
    openLogs: () => invoke('open_logs'),
  };
})();
"#;

/// 打开控制台。先确保服务在跑（spawn 幂等 + 就绪等待）——
/// 窗口永远指向活着的控制台，用户永远不该看到 webview 错误页。
fn show_main(app: &AppHandle) {
    {
        let state = app.state::<Arc<ServerState>>();
        if let Err(err) = spawn_server(&state) {
            log_line(&state.log_dir, &format!("[壳] 打开控制台前启动服务失败：{err}"));
            return;
        }
        if !wait_healthz(PORT, HEALTHZ_TIMEOUT) {
            log_line(&state.log_dir, "[壳] 打开控制台前服务未就绪，稍后再试");
            return;
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let url: tauri::Url = format!("http://127.0.0.1:{PORT}/").parse().expect("valid url");
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Cline Pass 上游控制台")
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        .initialization_script(BRIDGE_SCRIPT)
        .build()
        .expect("failed to create main window");
    let _ = window.hide(); // 显示时机由就绪检查线程控制
}

// ---------- 托盘 ----------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "打开控制台").build(app)?;
    let start = MenuItemBuilder::with_id("start", "启动服务").build(app)?;
    let stop = MenuItemBuilder::with_id("stop", "停止服务").build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重启服务").build(app)?;
    let logs = MenuItemBuilder::with_id("logs", "打开日志目录").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出（结束服务进程）").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&start)
        .item(&stop)
        .item(&restart)
        .separator()
        .item(&logs)
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundle icon").clone())
        .tooltip("Cline Pass 上游控制台")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let app = app.clone();
            // 菜单事件在主线程回调：启停等耗时操作派发到后台线程，避免卡死托盘
            match event.id().as_ref() {
                "open" => show_main(&app),
                "start" => {
                    std::thread::spawn(move || menu_start(&app));
                }
                "stop" => {
                    std::thread::spawn(move || menu_stop(&app));
                }
                "restart" => {
                    std::thread::spawn(move || menu_restart(&app));
                }
                "logs" => {
                    let dir = app.state::<Arc<ServerState>>().log_dir.clone();
                    let _ = std::process::Command::new("explorer").arg(dir).creation_flags(CREATE_NO_WINDOW).spawn();
                }
                "quit" => quit_app(&app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击托盘图标 = 打开/聚焦控制台
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn menu_start(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    if let Err(err) = spawn_server(&state) {
        log_line(&state.log_dir, &format!("[壳] 托盘启动失败：{err}"));
        return;
    }
    if wait_healthz(PORT, HEALTHZ_TIMEOUT) {
        show_main(app);
    }
}

fn menu_stop(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    let _ = stop_server(&state, GRACEFUL_STOP);
}

fn menu_restart(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    let _ = stop_server(&state, GRACEFUL_STOP);
    if let Err(err) = spawn_server(&state) {
        log_line(&state.log_dir, &format!("[壳] 托盘重启失败：{err}"));
        return;
    }
    if wait_healthz(PORT, HEALTHZ_TIMEOUT) {
        show_main(app);
    }
}

/// 托盘「退出」：先收窗（视觉即时反馈）→ 优雅停服务 → 退出进程（Job Object 兜底）
fn quit_app(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    state.exiting.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let started = Instant::now();
    let _ = stop_server(&state, GRACEFUL_STOP);
    log_line(
        &state.log_dir,
        &format!("[壳] 托盘退出：停服耗时 {}ms，壳进程结束", started.elapsed().as_millis()),
    );
    app.exit(0);
}

// ---------- tauri commands（控制台 UI 通过 window.cpsHost 调用） ----------
// 全部「立即返回、后台执行」，UI 用 server_status 轮询；不做阻塞式 IPC。

#[tauri::command]
fn server_status(state: tauri::State<'_, Arc<ServerState>>) -> Result<String, String> {
    let alive = {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        match guard.as_mut() {
            Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_none(),
            None => false,
        }
    };
    if !alive {
        return Ok("stopped".into());
    }
    if healthz_ok(PORT) {
        Ok("running".into())
    } else {
        Ok("starting".into())
    }
}

#[tauri::command]
fn server_start(state: tauri::State<'_, Arc<ServerState>>) -> Result<String, String> {
    if let Err(err) = spawn_server(&state) {
        return Err(err);
    }
    Ok("starting".into())
}

#[tauri::command]
fn server_stop(state: tauri::State<'_, Arc<ServerState>>) -> Result<String, String> {
    let state = Arc::clone(state.inner());
    std::thread::spawn(move || {
        let _ = stop_server(&state, GRACEFUL_STOP);
    });
    Ok("stopping".into())
}

#[tauri::command]
fn server_restart(state: tauri::State<'_, Arc<ServerState>>) -> Result<String, String> {
    let state = Arc::clone(state.inner());
    std::thread::spawn(move || {
        let _ = stop_server(&state, GRACEFUL_STOP);
        if let Err(err) = spawn_server(&state) {
            log_line(&state.log_dir, &format!("[壳] 重启失败：{err}"));
        }
    });
    Ok("starting".into())
}

#[tauri::command]
fn open_logs(state: tauri::State<'_, Arc<ServerState>>) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(&state.log_dir)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 服务进程生命周期 ----------

fn spawn_server(state: &ServerState) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(()); // 已在运行（幂等）
        }
    }

    let node = find_node().ok_or_else(|| {
        "未找到 Node.js（需要 ≥ 20）。请安装 Node.js 后重试，详情见日志目录。".to_string()
    })?;

    rotate_log(&state.log_dir);
    let log_out = std::fs::OpenOptions::new().create(true).append(true).open(log_path(&state.log_dir)).map_err(|e| e.to_string())?;
    let log_err = log_out.try_clone().map_err(|e| e.to_string())?;

    log_line(
        &state.log_dir,
        &format!(
            "[壳] 启动服务：{} {}（DATA_DIR={}）",
            node.display(),
            state.entry.display(),
            state.data_dir.display()
        ),
    );

    let child = std::process::Command::new(&node)
        .arg(&state.entry)
        .env("DATA_DIR", &state.data_dir)
        .env("PORT", PORT.to_string())
        .env("BIND_HOST", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("LOG_LEVEL", "info")
        .stdout(log_out)
        .stderr(log_err)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("拉起服务失败：{e}"))?;

    // 防残留核心：进程一出生就挂进 kill-on-close 作业树
    unsafe {
        AssignProcessToJobObject(
            HANDLE(state.job as *mut _),
            HANDLE(child.as_raw_handle() as *mut _),
        )
        .map_err(|e| format!("挂载作业对象失败：{e}"))?;
    }

    log_line(&state.log_dir, &format!("[壳] 服务已启动 pid={}", child.id()));
    *guard = Some(child);
    Ok(())
}

fn stop_server(state: &ServerState, grace: Duration) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let Some(child) = guard.as_mut() else {
        return Ok(()); // 已停止（幂等）
    };

    // ① 优雅：请服务自己走 SIGTERM 同款路径（落盘 → 退出）
    let _ = shutdown_request(PORT);

    // ② 等待退出；超时则 ③ 终止整棵作业树
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(code) => {
                log_line(&state.log_dir, &format!("[壳] 服务已退出（code={code:?}）"));
                break;
            }
            None if Instant::now() >= deadline => {
                log_line(&state.log_dir, "[壳] 优雅关停超时，强制终止服务进程树");
                unsafe {
                    if let Err(err) = TerminateJobObject(HANDLE(state.job as *mut _), 1) {
                        log_line(&state.log_dir, &format!("[壳] 强制终止失败：{err}"));
                    }
                }
                let _ = child.wait();
                break;
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    *guard = None;
    Ok(())
}

// ---------- Job Object（防残留第一道闸） ----------

fn create_kill_on_close_job() -> Result<HANDLE, String> {
    unsafe {
        let job = CreateJobObjectW(None, None).map_err(|e| format!("创建作业对象失败：{e}"))?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| format!("配置作业对象失败：{e}"))?;
        Ok(job)
    }
}

// ---------- 网络探针 ----------

fn healthz_ok(port: u16) -> bool {
    http_once(port, "GET /healthz").is_some_and(|body| body.contains(" 200 "))
}

fn shutdown_request(port: u16) -> bool {
    // POST /api/shutdown：服务端只放行「来自回环且无 Origin」的请求（浏览器跨源被中间件拦截）
    http_once(port, "POST /api/shutdown").is_some_and(|body| body.contains(" 200 "))
}

fn http_once(port: u16, request_line: &str) -> Option<String> {
    let addr = ("127.0.0.1", port).to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    let req = format!(
        "{request_line} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut body = String::new();
    stream.read_to_string(&mut body).ok()?;
    Some(body)
}

fn wait_healthz(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if healthz_ok(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

// ---------- 工具 ----------

/// 数据目录解析（VS Code Portable Mode 同款检测）：
/// exe 旁存在 `data` 目录 → **便携模式**，数据（配置/密钥/日志）就地保存；
/// 否则 → **安装模式**，用 `%APPDATA%`——安装目录会被升级/卸载流程清空，
/// 数据混进去会被删（这是默认不能放安装目录的决定性原因，两种形态各得其所）。
fn resolve_data_dir(app: &AppHandle) -> (PathBuf, bool) {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let portable = dir.join("data");
            if portable.is_dir() {
                return (portable, true);
            }
        }
    }
    (
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default()),
        false,
    )
}

fn find_node() -> Option<PathBuf> {
    // PATH 上有 node 就直接用
    if std::process::Command::new("node")
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .is_ok()
    {
        return Some(PathBuf::from("node"));
    }
    // 常见安装位置兜底
    let candidates = [
        std::env::var("ProgramFiles").ok().map(|p| PathBuf::from(p).join("nodejs/node.exe")),
        std::env::var("ProgramFiles(x86)").ok().map(|p| PathBuf::from(p).join("nodejs/node.exe")),
        std::env::var("LocalAppData").ok().map(|p| PathBuf::from(p).join("Programs/nodejs/node.exe")),
    ];
    candidates.into_iter().flatten().find(|p| p.exists())
}

/// Tauri 的 resource_dir 返回 verbatim 路径（`\\\\?\\` 前缀，即 4 个反斜杠的形式），
/// Node 处理不了（lstat 会一路走到盘根报 EISDIR），剥掉前缀还原成常规路径。
/// 本机盘场景安全；`\\\\?\\UNC\\` 布局在本项目不会出现。
fn normalize_path(p: PathBuf) -> PathBuf {
    const VERBATIM: &str = "\\\\?\\";
    let s = p.as_os_str().to_string_lossy();
    match s.strip_prefix(VERBATIM) {
        Some(stripped) => PathBuf::from(stripped.to_string()),
        None => p,
    }
}

/// 服务入口：多候选兜底（安装器 / 便携 exe / 开发环境的资源布局各不相同）
fn resolve_entry(app: &AppHandle) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(env_entry) = std::env::var("CPASS_SERVER_ENTRY") {
        candidates.push(PathBuf::from(env_entry));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("runtime/server/dist/index.js"));
    }
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent().unwrap_or(&exe).to_path_buf();
        candidates.push(dir.join("runtime/server/dist/index.js"));
        candidates.push(dir.join("resources/runtime/server/dist/index.js"));
        candidates.push(dir.join("../../server/dist/index.js"));
    }
    candidates.push(PathBuf::from("server/dist/index.js"));
    normalize_path(candidates.into_iter().find(|p| p.exists()).unwrap_or_else(|| PathBuf::from("server/dist/index.js")))
}

fn log_path(log_dir: &PathBuf) -> PathBuf {
    log_dir.join("server.log")
}

fn log_line(log_dir: &PathBuf, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path(log_dir)) {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

fn rotate_log(log_dir: &PathBuf) {
    let path = log_path(log_dir);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_ROTATE_BYTES {
            let _ = std::fs::rename(&path, log_dir.join("server.old.log"));
        }
    }
}
