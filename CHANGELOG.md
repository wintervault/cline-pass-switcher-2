# Changelog

## 2.0.0-dev（2026-10）

完整重构：接管项目后的第一次大版本。修掉数据丢失、启动崩溃、白烧额度三类缺陷，
故障转移语义按 prompt cache 优先重新设计。旧版 `server.js` 保留至 UAT 通过后删除。

### 破坏性变更

1. **公网部署 `proxyKey` 为空 → 拒绝启动**（原为静默裸奔，任何人可读取你的全部密钥）。
   逃生舱 `ALLOW_INSECURE_BIND=1`。
2. **CORS 默认不再发 `Access-Control-Allow-Origin: *`**。带 Origin 的写请求必须同源或在
   `corsOrigins` 白名单里（防本地 CSRF / DNS rebinding）。
3. **`/api/accounts` 不再回传明文 key**（掩码 + 末 4 位指纹）；前端编辑留空 = 保持原 key。
4. **客户端断开后不再继续故障转移**（旧版会继续向后续候选发请求、白烧额度）。
5. **`accountMode: roundrobin` → `sticky`**（迁移自动进行）。每请求轮转账号会让上游
   prompt cache 全失效；粘性模式只在账号级错误时轮转。roundrobin 仍可手动选回。
6. **故障转移语义重写**：错误三分类（账号级/渠道级/请求级）+ 同渠道退避重试 +
   全局预算 `failover.budgetMs`（默认 90s）封顶 + 失败渠道冷却沉底。
   preferred 模式收敛为「本地说了算」：前面的候选逐个 strict，只给最后一个放开网关回退。
7. **配置格式升级 `version: 2`**（自动迁移 + 损坏时备份 `*.broken-<时间>`）。
8. **Node ≥ 20**（原 ≥ 18）。
9. 前端改为 Vite + React + antd 构建（`npm run build` 后由后端托管，见 README）。

### 修复

- **丢数据**：配置写盘改为「临时文件 → fsync → rename」原子替换；旧版 `writeFileSync`
  截断重写，崩溃后 config.json 可能被截断、账号池静默清空。
- **崩溃**：`config.json` / `metadata.json` 载入后全字段校验兜底。旧版文件内容为 `{}` 即抛
  `TypeError`（聊天接口 500，实测确认）；现在损坏文件自动备份并重建，个别坏记录逐条丢弃。
- **白烧额度**：客户端断开立即终止整条故障转移链。
- **内存**：流式元数据改为尾部滑动窗口增量解析（旧版把整个响应体缓存进数组）。
- **HTTP 状态码不再被丢弃**（旧版 429/500 一律变 502，分类少一个最可靠的信号）。
- **SSE 错误详情不再静默丢失**（fetch 规范：getReader 后 `response.text()` 抛
  "Body is unusable"，旧代码用 `.catch` 吞掉了）。
- **排除列表失效不再静默**：本地无渠道清单时显式标记 degraded 并告警。
- 旧正则 bug：`rate-?limit` 匹配不了 "Rate limit exceeded"（中间是空格）。

### 新增

- `GET /healthz`：免鉴权健康检查（Docker HEALTHCHECK 用）。
- pino 结构化日志（`LOG_LEVEL`），密钥字段一律 redact。
- 密钥恒定时间比较（`timingSafeEqual`）。
- 配置新增：`failover.*`（超时/预算/重试/冷却）、`corsOrigins`、`historyLimit`（默认 500）。
- 工程：npm workspaces（server + web）、全栈 TypeScript、Vitest 200 例（mock fetch
  零真实网络）、Biome、原子写存储、优雅退出（SIGTERM/SIGINT）。

## 1.2.0

初版（上游项目）：上游枚举/校验/钉住、账号池、OpenAI 兼容代理、多上游优先级故障转移。
