# CLAUDE.md — 项目工程约定

> 本项目由人 + AI 协作长期维护。这个文件是给「下一个会话的你」的：
> 开工前先读它和 `docs/`，避免重复踩坑或与既有约定冲突。

## 项目是什么

Cline Pass 订阅的本地/服务器代理 + 控制台：枚举/校验/钉住订阅模型背后的上游渠道，
多渠道故障转移，OpenAI 兼容端点（`/v1/chat/completions`）。独立 fork，只自用，不向上游提 PR。

## 动手前必读

| 文档 | 内容 | 何时读 |
|---|---|---|
| `docs/pinning.md` | **钉住上游的权威事实来源**：网关行为按账号风控而异、探针判定法、全部设计决策（D1-D6） | 改任何钉住/探测/校验/渠道清单相关代码前 |
| `CHANGELOG.md` | 版本历史与破坏性变更 | 发版、改行为、改配置格式前 |
| `docs/UAT.md` | 真实网关手动验收清单（单测全 mock，不覆盖真实网关行为） | 改动涉及真实网关交互后 |
| `README.md` | 用户视角的完整说明 | 改用户可见行为后 |

## 工程纪律（用户明确要求，最高优先级）

1. **长期主义 + 系统工程**：每次改动考虑对整体的影响；修 bug 先找根因，不要打补丁。
2. **一个 commit 一件事**：主题单一、消息用中文 conventional 风格（`feat:` / `fix:` /
   `refactor:` / `docs:` / `test:` / `chore:`），正文说清「为什么」。
3. **文档随代码走**：行为变更、新配置项、新端点 → 同一次改动里更新
   README / CHANGELOG / docs 对应章节。实测结论进 `docs/pinning.md`。
4. **上下文外化**：决策与调研写成 docs，不留在对话里——下一个会话的 AI 靠仓库接上。

## 验证命令（改动后全绿才算完成）

```bash
npm test            # vitest，全 mock，零真实网络（护栏会拦截外网请求）
npm run typecheck   # server + web 双端
npm run lint        # biome check
npm run build       # server(tsc) + web(vite)
```

真实网关行为：按 `docs/UAT.md` 手动验收（消耗极小额真实额度）。

## 技术栈与结构

npm workspaces：`server/`（Node ≥20，原生 http + TS）+ `web/`（Vite + React 19 + antd 6 暗色）。
运行时依赖刻意克制：server 仅 `zod`（配置校验）+ `pino`（日志）。

```
server/src/
  config/     schema(zod,版本化迁移) / load(损坏备份) / env(环境变量覆盖) / derive
  store/      jsonStore(原子写:tmp→fsync→rename) / metaStore(metadata.json 校验兜底)
  upstream/   routing(纯函数:管道判定+偏好注入) / errors(三分类) / client / response(unwrap)
              probe(探测+校验) / catalog(目录+官方清单)
  accounts/   pool(sticky默认/单账号/轮询,账号级错误才轮转)
  proxy/      candidates(候选生成纯函数) / chain(故障转移执行器) / health(冷却) / stream(增量解析)
  http/       server(生命周期) / router / respond / routes/{api,chat,static}
  security/   compare(timingSafeEqual/掩码) / bind(启动闸门) / middleware(鉴权/Origin/CORS)
web/src/      api/{client,types,hooks} / features/* / theme.ts
```

**分层规则**：`upstream/` 与 `proxy/candidates` 是纯函数（不读全局状态，依赖注入）——
这是可测性的根基，新代码必须遵守。路由层只做协议转换，业务逻辑在 service/chain。

## 关键设计（改动前先理解为什么）

- **prompt cache 是一等约束**：agent 多轮对话每轮带全上下文，切渠道/账号 = 缓存全失效。
  所以账号默认粘性、一次请求固定账号、失败渠道冷却沉底而非剔除。
- **错误三分类**（`upstream/errors.ts`）：账号级→立即换账号；渠道级→重试后切换；
  请求级→重试一次即切。判定顺序有讲究（文本先于状态码、限流先于配额），注释里有原因。
- **failover 全局预算**：`failover.budgetMs` 封顶，agent 场景绝不久挂。
- **preferred = 本地说了算**：前面的候选逐个 strict，只给最后一个放开网关回退。
- **配置一律走 schema**：给 config/metadata 加字段时同步改 `config/schema.ts` /
  `store/metaStore.ts`（记得 zod 4 陷阱：对象默认值要 `.catch(() => Schema.parse({})).prefault({})`）。
- **客户端断开即止损**：长耗时操作都接 `ctx.abortSignal`。
- **控制台不受下游密钥管辖**（v2.9.3 的设计修正）：`proxyKey` 是**下发给客户端的**
  凭据，只守 `/v1/*` 与**远端**的控制台访问；**本机访问控制台永远免密钥**——
  能坐在本机前面的人就是最高权限。判定是「回环对端 + 回环 Host」两条缺一不可
  （`security/local.ts`：只看对端挡不住 DNS rebinding；只看 Host 挡不住伪造；
  本机网页的跨源 fetch 由 Origin 校验兜住）。**不要再把控制台和密钥绑在一起**：
  那会让主人忘了密钥就再也进不去控制台。
- **写操作的回执在 mutation 里，不在调用点**（`web/src/api/hooks.ts` +
  `feedback.ts`）：调用点不可能「忘了弹」。失败必带原因，长耗时给「进行中 →
  结果」两段。新加 mutation 时照这个模式写，别只 return mutate。

## 已知坑（避免重踩）

- zod 4 的 `.default({})` 不 parse 默认值（返回裸 `{}`）；`.prefault({})` parse 但遇非法输入抛。
- fetch 规范：`getReader()` 之后 `response.text()` 抛 "Body is unusable"。
- Node keep-alive 连接不主动关，`server.close()` 会被拖满宽限期——关闭时要定期回收空闲连接。
- 网关对**下划线形状**的渠道名（`__probe__`）静默丢弃，探针必须用合法 slug 形状。
- `max_tokens` 太小 → HTTP 500 `empty response content`，是推理烧完预算，不是路由故障。
- Windows 上 `child.kill('SIGTERM')` 是无条件终止，优雅退出逻辑要直接单测 `shutdownServer`。
- biome.json 不接受注释；`noNonNullAssertion` 是 error 级，用显式 undefined 检查替代 `!`。

## 桌面壳（desktop/，Tauri 2）

壳只做一件事：**把 Node 服务进程管起来，并保证「退出就是真退出」**。改动壳之前先读这段。

**防残留三道闸（动任何退出/子进程代码前自查，缺一不可）：**
1. Job Object kill-on-close：服务进程 spawn 后立即挂进作业树，作业句柄随壳进程消亡
   而关闭 → OS 终止整棵树。壳崩溃/被强杀也覆盖——这是不依赖代码路径的兜底。
2. 优雅优先：退出先请求 `POST /api/shutdown`（服务端只放行回环 + 无 Origin/Referer），
   等待 ≤8s，超时 TerminateJobObject。服务的优雅路径与 SIGTERM 是同一条。
3. 退出路径唯一：托盘「退出」→ stop → app.exit(0)。关窗只是 hide，不退出；启动同理——
   仅驻留托盘、不自动弹窗，窗口只由用户动作（托盘 / 二次启动）唤起。

其他不变式：启停 IPC 全部异步派发 + server_status 轮询（无阻塞 invoke）；spawn 幂等
（try_wait 检测）；single-instance 插件防双开；initialization_script 注入 window.cpsHost
（页面重载后依然有效）。服务入口多候选解析（resource/exe 同级/dev 相对路径）。

**控制通道是 HTTP，不是 Tauri IPC（v2.9.2 的根因修复，别再改回去）。**
控制台页面是 `WebviewUrl::External("http://127.0.0.1:3123/")`。对外部 URL，Tauri
**不**注入 `window.__TAURI_INTERNALS__`，新版还对非本地来源强制 ACL——未声明 remote
capability 的自定义命令会被直接拒绝（tauri-apps/tauri#4837、#15190）。表现极具迷惑性：
页面看似正常，但每次状态查询失败都被 UI 当成「已停止」，于是「服务在跑却显示已停止」
且按钮点了没反应。现在壳监听回环控制端口（默认 3122，被占用则退回系统分配），
注入的桥只做 `fetch`：`/host/status|start|stop|restart|log|open-logs|window|drag`。
- 安全边界：只绑回环 + 只放行控制台自身的 Origin/Referer（其它网页跨源必带 Origin
  → 403）。要放行控制台就必须放行它的跨源来源，因此 `CONSOLE_ORIGIN` 是硬编码常量，
  改控制台端口要同步改它。
- 同一原因，`data-tauri-drag-region` 也不可用：自绘标题栏的拖动是壳在原生侧
  跟鼠标移动窗口（`/host/drag`）。窗口操作 `/host/window` 同理。
- 状态一律以「进程存活 + healthz 通过」判定，`error` 与 `stopped` 分开——
  启动失败的原因要能显示到页面上，不许静默。

数据目录解析（`resolve_data_dir`，VS Code Portable Mode 同款检测）：**exe 旁存在
`data` 目录 → 便携模式（数据就地，删目录即清除）；否则 `%APPDATA%`**（安装目录会被
升级/卸载清空，数据不能混进去——这是决定性原因）。日志在数据目录 logs/（超 8MB
轮转为 .old）。便携包由 `scripts/package-portable.mjs` 组装（含 data/README.txt
占位，保证空目录在 zip 中存活）。

窗口为 `decorations(false)` + 自绘标题栏（`web/src/titleBar.tsx`）：改窗口样式时两边
一起改，否则标题栏会重复或缺失。

构建：`npm run desktop:build`（= 前后端 build + scripts/prepare-runtime.mjs 精简出
7MB 运行时 + tauri build）。Rust 侧警告零容忍，与 TS 侧一致。

**Tauri NSIS 模板已自带运行中进程的收尾**（安装与卸载都会 taskkill，实测证明）——
不要自加「优雅关停钩子/Sleep 等待」之类的补丁层：那是对每次安装/升级的无条件
时间税，且从安装器调 PowerShell 非主流。数据丢失窗口由写盘防抖上限（1.5s）+
原子写兜底，接受它。**判断标准：加「聪明」机制前，先确认平台/模板没有提供
同等能力（v2.1.2 的钩子就是反面教材，v2.1.3 撤销）。**

## 待办 / 已知边界

- 流式钉住审计只能「检测+标记」，不能撤回（`docs/pinning.md` D3）。
- 真实网关 UAT（`docs/UAT.md`）尚未完整跑过一轮：单测全 mock，真实行为以 UAT 为准。
- 桌面壳依赖系统 Node ≥20（壳会探测 PATH 与常见安装位置）；打包内置 Node 运行时
  （SEA/嵌入式）是明确的后续选项，未做。
- 发版流程：① 改版本号**五处**——根 / `server` / `web` 的 package.json、
  `desktop/tauri.conf.json`、`desktop/Cargo.toml`（运行时单一来源是根
  package.json，`server/src/paths.ts` 的 `PACKAGE_VERSION` 读它）；
  ② `npm run desktop:build`——cargo 构建时会顺带更新 `desktop/Cargo.lock`
  里的版本行；③ `git status` 确认无遗留（**尤其 Cargo.lock**，它只在构建
  时才变，先提交后构建会留下一行脏文件）；④ 提交 + CHANGELOG + tag + push。
