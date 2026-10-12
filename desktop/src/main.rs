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
//!    启动同理：仅驻留托盘、不自动弹窗；窗口只由用户动作（托盘 / 二次启动）唤起。
//!
//! **控制通道走 HTTP，不走 Tauri IPC**（2.9.2 的根因修复，别再改回去）：
//! 控制台页面是 `WebviewUrl::External("http://127.0.0.1:3123/")`。对外部 URL，
//! Tauri 默认不注入 `window.__TAURI_INTERNALS__`，且新版对「非本地来源」强制执行 ACL、
//! 未声明 remote capability 的自定义命令会被直接拒绝（tauri-apps/tauri#4837、#15190）。
//! 页面里的 `cpsHost` 因此永远拿不到结果，UI 只能把每次失败当成「已停止」，
//! 于是出现「明明在跑却显示已停止」+「按钮点了没反应」。现在壳自己监听回环控制端口，
//! 注入的桥只做 HTTP 调用：无 IPC、无 ACL、无来源限制，浏览器直开也能用、curl 也能诊断。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
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
/// 控制端口：壳自己的回环 HTTP 服务，页面据此启停服务。固定端口便于诊断（curl 可直连）；
/// 被占用时退回系统分配端口（罕见路径，端口会通过注入脚本告诉页面）。
const CONTROL_PORT: u16 = 3122;
/// 允许调用控制通道的来源：**只有控制台自己**。
///
/// 为什么必须放行：控制台在 3123、控制通道在 3122，对浏览器而言是跨源请求，
/// 一定带 Origin/Referer；一律拒绝的话页面自己也被挡在门外——这正是「按钮点了没反应」
/// 的最后一层原因。放行之后仍然安全：别的网页 Origin/Referer 不是这个值，照旧 403。
const CONSOLE_ORIGIN: &str = "http://127.0.0.1:3123";
const HEALTHZ_TIMEOUT: Duration = Duration::from_secs(25);
const GRACEFUL_STOP: Duration = Duration::from_secs(8);
const LOG_ROTATE_BYTES: u64 = 8 * 1024 * 1024;
/// 壳内保留的最近日志行数（/host/log 读内存副本，不去抢服务进程持有的文件句柄）
const LOG_RING: usize = 500;
/// 注入脚本里预置的控制端口占位符（端口运行期确定，只能后填）
const CONTROL_PORT_PLACEHOLDER: &str = "__CPS_CONTROL_PORT__";

/// 服务状态。`Error` 不是多余的——它把「启动失败」和「没启动」分开，
/// 页面才不至于把拉不起来的原因吞掉、只显示一句「已停止」。
#[derive(Clone, PartialEq, Eq)]
enum SvcState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error(String),
}

impl SvcState {
    fn name(&self) -> &'static str {
        match self {
            SvcState::Stopped => "stopped",
            SvcState::Starting => "starting",
            SvcState::Running => "running",
            SvcState::Stopping => "stopping",
            SvcState::Error(_) => "error",
        }
    }
}

/// 服务进程的持有状态。child 与 job 句柄的存活期 = 壳进程存活期。
struct ServerState {
    child: Mutex<Option<Child>>,
    /// Windows JOB 句柄（裸存 isize 以满足 Send/Sync；存活期 = 壳进程）
    job: isize,
    /// 壳自身的句柄：控制通道要用它去操作主窗口（窗口控制 / 拖动）
    app: AppHandle,
    data_dir: PathBuf,
    entry: PathBuf,
    log_dir: PathBuf,
    /// 退出中：为 true 时窗口的 CloseRequested 不再被拦截（否则 app.exit 会被
    /// 自己的「关窗进托盘」逻辑拖住——托盘退出卡顿的根因）
    exiting: AtomicBool,
    /// 控制端口（0 = 控制服务没起来，页面会明确报「控制通道不可用」）
    control_port: AtomicU16,
    state: Mutex<SvcState>,
    /// 壳日志的内存环形缓冲，供 /host/log 回读（便于远程诊断）
    logs: Mutex<VecDeque<String>>,
}

impl ServerState {
    fn set_state(&self, next: SvcState) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        *guard = next;
    }

    /// 壳日志：落盘 + 进内存环。
    fn log(&self, line: &str) {
        write_log_file(&self.log_dir, line);
        let mut guard = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() >= LOG_RING {
            guard.pop_front();
        }
        guard.push_back(line.to_string());
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动 = 用户又双击了一次图标/快捷方式，那是明确的「我要用」，
            // 把控制台叫出来（与托盘左键、托盘菜单「打开控制台」同一条路径）。
            //
            // 与「启动不弹窗」不冲突，两者说的是不同的事：
            // - **冷启动**（没有实例在跑）只驻留托盘、不弹窗——这是既定要求；
            // - **二次启动**说明用户手上就想要界面，此时还埋伏在托盘里才是毛病。
            let state = app.state::<Arc<ServerState>>();
            state.log("[壳] 收到第二次启动：打开控制台");
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
                app: app.handle().clone(),
                data_dir,
                entry,
                log_dir: log_dir.clone(),
                exiting: AtomicBool::new(false),
                control_port: AtomicU16::new(0),
                state: Mutex::new(SvcState::Stopped),
                logs: Mutex::new(VecDeque::new()),
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

            // 控制端口先起来：页面靠它得知状态、执行启停。它不通 = 页面上的按钮是死的。
            {
                let state = handle.state::<Arc<ServerState>>();
                let control = Arc::clone(state.inner());
                std::thread::spawn(move || control_server(control));
            }

            // 启动后仅驻留托盘：服务在后台就绪，窗口只在用户主动打开时出现。
            // 失败也不弹窗——托盘「打开控制台」会重试，状态与原因都落在控制通道和日志里。
            std::thread::spawn(move || {
                let state = handle.state::<Arc<ServerState>>();
                if let Err(err) = spawn_server(&state) {
                    state.log(&format!("[壳] 启动失败：{err}"));
                    state.set_state(SvcState::Error(err));
                    return;
                }
                let started = Instant::now();
                if wait_healthz(PORT, HEALTHZ_TIMEOUT) {
                    state.log(&format!("[壳] 服务就绪（{}ms），驻留托盘", started.elapsed().as_millis()));
                } else {
                    state.log("[壳] 服务未能就绪：可从托盘「打开控制台」重试");
                }
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
        .invoke_handler(tauri::generate_handler![open_logs])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------- 控制通道（回环 HTTP；页面注入的桥唯一依赖） ----------

/// 页面侧的控制桥。
///
/// 只依赖 `fetch` —— 不碰 `window.__TAURI_INTERNALS__`（外部 URL 下不存在/被 ACL 拒绝，
/// 见文件头注释）。安全边界由控制端承担：只绑回环 + 拒绝一切带 Origin 的请求
/// （浏览器发起的跨源请求必带 Origin，因此任意网页都无法越权启停服务）。
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

  const PORT = __CPS_CONTROL_PORT__;
  if (!PORT) return;
  const base = 'http://127.0.0.1:' + PORT;
  const call = async (path, method) => {
    const res = await fetch(base + path, { method: method || 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error('控制通道返回 ' + res.status);
    return await res.json();
  };
  window.cpsHost = {
    hosted: true,
    port: PORT,
    status: () => call('/host/status'),
    start: () => call('/host/start', 'POST'),
    stop: () => call('/host/stop', 'POST'),
    restart: () => call('/host/restart', 'POST'),
    log: () => call('/host/log'),
    openLogs: async () => { await call('/host/open-logs', 'POST'); },

    // 自绘标题栏：窗口控制与拖动。
    // 拖动没有走 data-tauri-drag-region（外部 URL 下 Tauri 不注入其脚本），
    // 而是把「按下时的鼠标屏幕坐标」交给壳，壳在原生侧跟着鼠标移动窗口——
    // 与系统标题栏同一条体验，也不依赖任何注入脚本。
    minimize: () => call('/host/window?action=minimize', 'POST'),
    toggleMaximize: () => call('/host/window?action=toggle-maximize', 'POST'),
    close: () => call('/host/window?action=close', 'POST'),
    isMaximized: async () => (await call('/host/window?action=query', 'POST')).maximized,
    dragMove: () => call('/host/drag', 'POST'),
  };
})();
"#;

/// 控制服务：单线程 accept 循环 + 每连接一个处理线程。
fn control_server(state: Arc<ServerState>) {
    let (listener, port) = match bind_control(CONTROL_PORT) {
        Ok(v) => v,
        Err(err) => {
            state.log(&format!("[壳] 控制端口绑定失败：{err}"));
            return;
        }
    };
    state.control_port.store(port, Ordering::SeqCst);
    state.log(&format!("[壳] 控制通道就绪：http://127.0.0.1:{port}"));

    for stream in listener.incoming() {
        if state.exiting.load(Ordering::SeqCst) {
            break;
        }
        if let Ok(stream) = stream {
            let state = Arc::clone(&state);
            std::thread::spawn(move || handle_control(stream, &state));
        }
    }
}

/// 固定端口优先；被占用时退回系统分配（同机跑两个便携副本也不会互相抢）。
fn bind_control(preferred: u16) -> Result<(TcpListener, u16), String> {
    if let Ok(l) = TcpListener::bind(("127.0.0.1", preferred)) {
        return Ok((l, preferred));
    }
    let l = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = l.local_addr().map_err(|e| e.to_string())?.port();
    Ok((l, port))
}

fn handle_control(stream: TcpStream, state: &Arc<ServerState>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut reader = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut buf = [0u8; 4096];
    let mut raw = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.windows(4).any(|w| w == b"\r\n\r\n") || raw.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&raw);
    let request_line = text.split("\r\n").next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // ---- 来源闸门 ----
    // 无 Origin：非浏览器客户端（curl、托盘自身、脚本）→ 放行。
    // 有 Origin/Referer：必须是控制台页面自己（它在 3123，控制通道在 3122，属跨源），
    // 否则 403——任意网页都无法越权启停服务。
    let mut origin: Option<String> = None;
    let mut referer: Option<String> = None;
    for line in text.split("\r\n").skip(1) {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("origin:") {
            let _ = rest;
            origin = line.splitn(2, ':').nth(1).map(|v| v.trim().to_string());
        } else if lower.starts_with("referer:") {
            referer = line.splitn(2, ':').nth(1).map(|v| v.trim().to_string());
        }
    }
    // 有 Origin 就用 Origin；只有 Referer 时从它截出 origin（scheme://host:port）。
    let claimed_origin: Option<String> = origin.clone().or_else(|| referer.map(|r| origin_of(&r)));
    if let Some(claimed) = &claimed_origin {
        if claimed != CONSOLE_ORIGIN {
            let _ = write_control(stream, 403, "{\"error\":\"cross-origin request refused\"}");
            return;
        }
    }

    // 预检（浏览器对带自定义头的跨源请求会先问一句）：放行控制台自己的来源。
    if method == "OPTIONS" {
        let _ = write_preflight(stream);
        return;
    }

    let (code, body) = dispatch_control(method, path, state);
    let _ = write_control(stream, code, &body);
}

fn dispatch_control(method: &str, path: &str, state: &Arc<ServerState>) -> (u16, String) {
    let (route, query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q.to_string())),
        None => (path, None),
    };
    let expected = match route {
        "/host/status" | "/host/log" => "GET",
        "/host/start" | "/host/stop" | "/host/restart" | "/host/open-logs" | "/host/window" | "/host/drag" => "POST",
        _ => return (404, "{\"error\":\"no such control route\"}".into()),
    };
    if method != expected {
        return (405, "{\"error\":\"method not allowed\"}".into());
    }
    match route {
        "/host/status" => (200, control_status(state)),
        "/host/start" => {
            if let Err(err) = spawn_server(state) {
                state.set_state(SvcState::Error(err.clone()));
                state.log(&format!("[壳] 启动失败：{err}"));
            }
            (200, control_status(state))
        }
        "/host/stop" => {
            state.set_state(SvcState::Stopping);
            let worker = Arc::clone(state);
            std::thread::spawn(move || {
                let result = stop_server(&worker, GRACEFUL_STOP);
                worker.set_state(match result {
                    Ok(()) => SvcState::Stopped,
                    Err(err) => SvcState::Error(err),
                });
            });
            (200, control_status(state))
        }
        "/host/restart" => {
            state.set_state(SvcState::Stopping);
            let worker = Arc::clone(state);
            std::thread::spawn(move || {
                if let Err(err) = stop_server(&worker, GRACEFUL_STOP) {
                    worker.set_state(SvcState::Error(err));
                    return;
                }
                worker.set_state(SvcState::Stopped);
                if let Err(err) = spawn_server(&worker) {
                    worker.log(&format!("[壳] 重启失败：{err}"));
                    worker.set_state(SvcState::Error(err));
                }
            });
            (200, control_status(state))
        }
        "/host/open-logs" => {
            let _ = std::process::Command::new("explorer")
                .arg(&state.log_dir)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
            (200, "{\"ok\":true}".into())
        }
        "/host/log" => (200, recent_logs(state)),
        "/host/window" => window_control(state, query.as_deref().unwrap_or("")),
        "/host/drag" => window_drag(state),
        _ => (404, "{\"error\":\"no such control route\"}".into()),
    }
}

/// 解析 `a=1&b=2` 形式的查询串。
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

/// 自绘标题栏的窗口控制。全部派发到主线程执行（Tauri 要求窗口操作在主线程）。
fn window_control(state: &Arc<ServerState>, query: &str) -> (u16, String) {
    let action = query_param(query, "action").unwrap_or_default();
    let app = state.app.clone();
    let Some(window) = app.get_webview_window("main") else {
        return (409, "{\"error\":\"窗口尚未创建\"}".into());
    };
    match action.as_str() {
        "minimize" => {
            let _ = window.minimize();
        }
        "toggle-maximize" => {
            let maximized = window.is_maximized().unwrap_or(false);
            let _ = if maximized { window.unmaximize() } else { window.maximize() };
        }
        "close" => {
            // 与系统标题栏的关闭一致：进托盘，不退出
            let _ = window.close();
        }
        "query" => {}
        _ => return (400, "{\"error\":\"unknown window action\"}".into()),
    }
    let maximized = window.is_maximized().unwrap_or(false);
    (200, format!("{{\"ok\":true,\"maximized\":{maximized}}}"))
}

/// 窗口拖动：前端在标题栏按下鼠标时打一声招呼，壳在原生侧盯着鼠标左键移动窗口。
///
/// 为什么不用 `data-tauri-drag-region`：控制台是外部 URL，Tauri 不向外部来源注入
/// 它的脚本（与 IPC 同一原因），该属性不会生效。自己跟鼠标既可靠，行为也与系统
/// 标题栏一致。拖动期间不再有后续 HTTP——壳自己判断左键何时松开。
fn window_drag(state: &Arc<ServerState>) -> (u16, String) {
    let app = state.app.clone();
    let Some(window) = app.get_webview_window("main") else {
        return (409, "{\"error\":\"窗口尚未创建\"}".into());
    };
    // 最大化状态下拖动 = 还原并跟随（Windows 的标准手感）
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    std::thread::spawn(move || {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let mut start = POINT::default();
        let mut cursor = POINT::default();
        unsafe {
            if GetCursorPos(&mut start).is_err() {
                return;
            }
        }
        loop {
            let held = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0;
            if !held {
                break;
            }
            unsafe {
                if GetCursorPos(&mut cursor).is_err() {
                    break;
                }
            }
            let dx = cursor.x - start.x;
            let dy = cursor.y - start.y;
            if dx != 0 || dy != 0 {
                if let Ok(pos) = window.outer_position() {
                    let _ = window.set_position(tauri::PhysicalPosition::new(pos.x + dx, pos.y + dy));
                }
                start = cursor;
            }
            std::thread::sleep(Duration::from_millis(8));
        }
    });
    (200, "{\"ok\":true}".into())
}

fn control_status(state: &Arc<ServerState>) -> String {
    let current = sync_state(state);
    let port = state.control_port.load(Ordering::SeqCst);
    let mut body = format!("{{\"state\":\"{}\",\"port\":{port}", current.name());
    if let SvcState::Error(msg) = &current {
        body.push_str(&format!(",\"error\":{}", json_string(msg)));
    }
    body.push('}');
    body
}

/// 状态以「进程真实存活 + healthz 通过」为准，而不是只看内部标志位——
/// 服务被外部杀掉、或刚开始监听但还没 healthy，页面都能立刻反映。
///
/// 关键：`Starting` 也要参与判定。否则通过控制通道拉起服务后状态会卡在「启动中」，
/// 页面就一直转圈（健康检查才是唯一可信的运行判据）。
fn sync_state(state: &Arc<ServerState>) -> SvcState {
    let mut guard = state.state.lock().unwrap_or_else(|e| e.into_inner());
    if matches!(*guard, SvcState::Stopping) {
        return guard.clone(); // 停止/重启进行中，展示态由执行线程收尾
    }
    let alive = {
        let mut child = state.child.lock().unwrap_or_else(|e| e.into_inner());
        match child.as_mut() {
            Some(c) => c.try_wait().map(|s| s.is_none()).unwrap_or(false),
            None => false,
        }
    };
    if !alive {
        // 没有进程：除了「启动失败」这种要留住的错误，一律视为已停止
        if !matches!(*guard, SvcState::Stopped | SvcState::Error(_)) {
            *guard = SvcState::Stopped;
        }
        return guard.clone();
    }
    if healthz_ok(PORT) {
        *guard = SvcState::Running;
    } else if !matches!(*guard, SvcState::Starting) {
        // 进程在但健康检查不过：别谎报运行中
        *guard = SvcState::Starting;
    }
    guard.clone()
}

fn recent_logs(state: &Arc<ServerState>) -> String {
    let lines: Vec<String> = {
        let guard = state.logs.lock().unwrap_or_else(|e| e.into_inner());
        guard.iter().cloned().collect()
    };
    let joined = lines.iter().map(|l| json_string(l)).collect::<Vec<_>>().join(",");
    format!("{{\"lines\":[{joined}]}}")
}

/// 从 URL 截出 origin（scheme://host:port）——只用于比对，不引 URL 解析库。
fn origin_of(url: &str) -> String {
    let after_scheme = match url.find("//") {
        Some(i) => i + 2,
        None => return url.to_string(),
    };
    match url[after_scheme..].find('/') {
        Some(i) => url[..after_scheme + i].to_string(),
        None => url.to_string(),
    }
}

/// 预检响应：只放行控制台自己的来源与它实际会用的方法/头。
fn write_preflight(mut stream: TcpStream) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {CONSOLE_ORIGIN}\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Access-Control-Max-Age: 600\r\nVary: Origin\r\nContent-Length: 0\r\n\
         Connection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()
}

fn write_control(mut stream: TcpStream, code: u16, body: &str) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\n\
         Access-Control-Allow-Origin: {CONSOLE_ORIGIN}\r\nVary: Origin\r\n\
         Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// 最小 JSON 字符串转义（错误信息里可能有引号/反斜杠/换行）。
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------- 窗口 ----------

/// 打开控制台。先确保服务在跑（spawn 幂等 + 就绪等待）——
/// 窗口永远指向活着的控制台，用户永远不该看到 webview 错误页。
fn show_main(app: &AppHandle) {
    {
        let state = app.state::<Arc<ServerState>>();
        if let Err(err) = spawn_server(&state) {
            state.log(&format!("[壳] 打开控制台前启动服务失败：{err}"));
            state.set_state(SvcState::Error(err));
            return;
        }
        if !wait_healthz(PORT, HEALTHZ_TIMEOUT) {
            state.log("[壳] 打开控制台前服务未就绪，稍后再试");
            return;
        }
        state.set_state(SvcState::Running);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let url: tauri::Url = format!("http://127.0.0.1:{PORT}/").parse().expect("valid url");
    let ws = default_window_size(app);
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title(APP_TITLE)
        // 尺寸按**逻辑**像素给（Tauri 的 inner_size 单位就是逻辑像素，见
        // webview_window.rs 的属性文档）。**不要再追加一次 `set_size` 去钉物理像素**：
        // 实测那样反而会把客户区顶高 43px（tao 在 Windows 上按「带装饰的窗口」估算
        // 外框，把标题栏算进去了，而本窗口 decorations(false)），只留一条路径时
        // 客户区就等于请求值（1506×900）。
        .inner_size(ws.logical_w, ws.logical_h)
        .min_inner_size(960.0, 640.0)
        // 无系统标题栏：标题栏由页面自绘（右上角最小化/最大化/关闭），
        // 暗色下不再有一条与页面无关的灰条，内容区也多出 30px。
        .decorations(false)
        .visible(false)
        .initialization_script(&bridge_script(app))
        .build()
        .expect("failed to create main window");
    let _ = window.center();
    {
        // 记「按什么尺寸创建」而不是读回：读回要等窗口真正显示之后才稳定
        // （窗口还隐藏时读到的是过渡中的值，实测差 43px）。
        let state = app.state::<Arc<ServerState>>();
        state.log(&format!(
            "[壳] 窗口按 {}x{} 逻辑像素创建（缩放 {}，显示器 {}x{} 物理）",
            ws.logical_w, ws.logical_h, ws.scale, ws.screen_w, ws.screen_h
        ));
    }
    // 服务已就绪才走到这里；先隐藏构建、再 show，避免空白闪烁
    let _ = window.show();
    let _ = window.set_focus();
}

/// 窗口标题：带上 switcher，别只写 Cline Pass（那是订阅服务的名字，不是这个工具）。
const APP_TITLE: &str = "Cline Pass Switcher";

/// 窗口尺寸的决策结果。
struct WindowSize {
    /// 界面逻辑尺寸（给窗口构建器；也是页面拿到的视口大小）
    logical_w: f64,
    logical_h: f64,
    scale: f64,
    /// 显示器物理尺寸（诊断用：解释这个窗口尺寸是怎么算出来的）
    screen_w: u32,
    screen_h: u32,
}

/// 默认窗口尺寸：先按显示器的工作区定**逻辑**尺寸，再交给窗口构建器换算。
///
/// 不写死一个拍脑袋的数字：写死在高分屏上会小得可怜、在小屏上又会超出屏幕。
/// 界面需要的是逻辑像素（布局宽度就是它），而屏幕给的约束是物理像素——
/// 所以先用缩放比把屏幕换算成同一套单位，再取「设计需要」与「屏幕装得下」中小的那个。
fn default_window_size(app: &AppHandle) -> WindowSize {
    let monitor = app.primary_monitor().ok().flatten();
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let (sw, sh) = monitor
        .as_ref()
        .map(|m| (m.size().width, m.size().height))
        .unwrap_or((1920, 1080));
    let (avail_w, avail_h) = (sw as f64 / scale, sh as f64 / scale);
    WindowSize {
        logical_w: TARGET_LOGICAL_W.min(avail_w * 0.92).max(960.0),
        logical_h: TARGET_LOGICAL_H.min(avail_h * 0.90).max(640.0),
        scale,
        screen_w: sw,
        screen_h: sh,
    }
}

/// 目标逻辑宽度：**刚好放得下界面的内容列**。
/// 目标逻辑宽度：1170（用户在实际使用中定下来的尺寸，不是算出来的）。
///
/// 这个数字有约束，改之前先看清楚：内容列 = 1170 - 展开侧栏 200 - 留白 56 -
/// 滚动条槽位 10 = **904**，它必须放得下最宽的那张表——请求历史的最小宽度 890。
/// 所以动窗口宽度、侧栏宽度、或请求历史的列宽，这三者要一起看（见 CLAUDE.md
/// 的「装得下」不变量）。屏幕装不下这个宽度时按工作区的 92% 退让。
const TARGET_LOGICAL_W: f64 = 1170.0;
/// 目标逻辑高度：860。要求是**最高的那一页（测试台）不出纵向滚动条**——
/// 它在 860 下实测余量 191px（页面自身 579 高 + 页头 + 内边距）。
const TARGET_LOGICAL_H: f64 = 860.0;

/// 注入脚本 = 模板 + 运行期确定的控制端口。
fn bridge_script(app: &AppHandle) -> String {
    let port = app
        .try_state::<Arc<ServerState>>()
        .map(|s| s.control_port.load(Ordering::SeqCst))
        .unwrap_or(0);
    BRIDGE_SCRIPT.replace(CONTROL_PORT_PLACEHOLDER, &port.to_string())
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
        .tooltip(APP_TITLE)
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
        state.log(&format!("[壳] 托盘启动失败：{err}"));
        state.set_state(SvcState::Error(err));
        return;
    }
    if wait_healthz(PORT, HEALTHZ_TIMEOUT) {
        state.set_state(SvcState::Running);
        show_main(app);
    }
}

fn menu_stop(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    state.set_state(SvcState::Stopping);
    let result = stop_server(&state, GRACEFUL_STOP);
    state.set_state(match result {
        Ok(()) => SvcState::Stopped,
        Err(err) => SvcState::Error(err),
    });
}

fn menu_restart(app: &AppHandle) {
    let state = app.state::<Arc<ServerState>>();
    state.set_state(SvcState::Stopping);
    let _ = stop_server(&state, GRACEFUL_STOP);
    state.set_state(SvcState::Stopped);
    if let Err(err) = spawn_server(&state) {
        state.log(&format!("[壳] 托盘重启失败：{err}"));
        state.set_state(SvcState::Error(err));
        return;
    }
    if wait_healthz(PORT, HEALTHZ_TIMEOUT) {
        state.set_state(SvcState::Running);
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
    state.log(&format!("[壳] 托盘退出：停服耗时 {}ms，壳进程结束", started.elapsed().as_millis()));
    app.exit(0);
}

// ---------- tauri commands（只剩「打开日志目录」这类一次性动作；启停一律走控制通道） ----------

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

    state.log(&format!(
        "[壳] 启动服务：{} {}（DATA_DIR={}）",
        node.display(),
        state.entry.display(),
        state.data_dir.display()
    ));

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

    state.log(&format!("[壳] 服务已启动 pid={}", child.id()));
    *guard = Some(child);
    state.set_state(SvcState::Starting);
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
                state.log(&format!("[壳] 服务已退出（code={code:?}）"));
                break;
            }
            None if Instant::now() >= deadline => {
                state.log("[壳] 优雅关停超时，强制终止服务进程树");
                unsafe {
                    if let Err(err) = TerminateJobObject(HANDLE(state.job as *mut _), 1) {
                        state.log(&format!("[壳] 强制终止失败：{err}"));
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

fn log_path(log_dir: &Path) -> PathBuf {
    log_dir.join("server.log")
}

/// 只落盘的日志写入（setup 早期还没有状态对象时的兜底路径）。
fn write_log_file(log_dir: &Path, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path(log_dir)) {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

fn log_line(log_dir: &Path, line: &str) {
    write_log_file(log_dir, line);
}

fn rotate_log(log_dir: &Path) {
    let path = log_path(log_dir);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_ROTATE_BYTES {
            let _ = std::fs::rename(&path, log_dir.join("server.old.log"));
        }
    }
}
