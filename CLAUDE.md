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

## 已知坑（避免重踩）

- zod 4 的 `.default({})` 不 parse 默认值（返回裸 `{}`）；`.prefault({})` parse 但遇非法输入抛。
- fetch 规范：`getReader()` 之后 `response.text()` 抛 "Body is unusable"。
- Node keep-alive 连接不主动关，`server.close()` 会被拖满宽限期——关闭时要定期回收空闲连接。
- 网关对**下划线形状**的渠道名（`__probe__`）静默丢弃，探针必须用合法 slug 形状。
- `max_tokens` 太小 → HTTP 500 `empty response content`，是推理烧完预算，不是路由故障。
- Windows 上 `child.kill('SIGTERM')` 是无条件终止，优雅退出逻辑要直接单测 `shutdownServer`。
- biome.json 不接受注释；`noNonNullAssertion` 是 error 级，用显式 undefined 检查替代 `!`。

## 待办 / 已知边界

- 流式钉住审计只能「检测+标记」，不能撤回（`docs/pinning.md` D3）。
- 真实网关 UAT（`docs/UAT.md`）尚未完整跑过一轮：单测全 mock，真实行为以 UAT 为准。
- 版本号以仓库根 `package.json` 为单一来源（`server/src/paths.ts` 的
  `PACKAGE_VERSION` 运行时读取），发版只改 package.json + CHANGELOG + tag。
