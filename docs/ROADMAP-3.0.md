# 3.0.0 路线图（2026-10-17 起草）

> 目标：把 6 项能力做成一个可审计的大版本。每项都先写清「事实依据 / 设计 / 风险」，
> 再给分阶段实施与验收。长期主义的两条底线贯穿全篇：**v2 配置与 `/v1` 契约不破**、
> **每条结论都有实测或明确来源**。

## 0. 目标、约束与破坏性变更

**约束（不变量，不改）**

- prompt cache 一等约束：一次请求固定账号；只有账号级错误才轮转（多网关下每个网关各自独立）
- 内容列由外壳唯一给定；`Panel` 是唯一区块形状；「装得下」不变量（六页 × 三尺寸自检）
- 本机访问控制台永远免密钥；`proxyKey` 只守 `/v1` 与远端控制台
- 开发/自测在隔离实例（`npm run dev:isolated`，端口 3133），线上实例不暂停、不替换
- 密钥不落日志、不回显（包括会话里读 config 时）

**破坏性变更（3.0.0 成立的理由）**

| 变更 | 兼容策略 |
|---|---|
| 配置格式 v2 → **v3**（新增 `gateways`，`accounts` 全局化） | 启动时自动迁移：生成一个 `main` 网关继承旧 `port/proxyKey/accountMode/failover/perModel`，账户全量引用 → **行为与 2.9.x 完全一致** |
| metadata 的模型探测结果按「网关 × 模型」存 | 旧数据迁到 `main` 网关下 |
| 请求历史新增 `gateway` 字段 | 旧记录归 `main`；控制台按网关筛选 |
| `/v1` 契约 | **不变**（模型 ID / 响应形状 / 错误格式都不动） |

---

## 1. 账号分类：正常号 / 风控号

### 事实依据（本仓库实测，见 `docs/pinning.md` 第五节）

- planner 管线的钉住参数对**所有**账号都被丢弃；两类账号的区别在**默认路由**：
  - 正常号：实际渠道 = 链首（如 `deepseek`）
  - 风控号：恒为 `openai-compatible-private`，怎么请求都出不去
  - 本机 20 小时 500 条历史：389 条全 deepseek（正常号）、107 条全 private（风控号），
    相邻请求零抖动——**分类是稳定的，但会随时间翻转**（社区多例）
- direct 管线（OpenRouter 类模型）**两类账号都仍可钉**（同账号实测 mimo `enforced`）
  ——正是用户说的「风控号许多模型并没有被风控」

### 判定方法

对**判定模型**（默认 `cline-pass/deepseek-v4.1-flash`，可在设置里改）发**不带钉住参数**
的最小请求，看 `finalProvider`：

- `openai-compatible-private` → **风控**
- 其它（deepseek 等）→ **正常**
- 网络失败/额度用尽 → **未判定**（保留上次结论，不猜）

每账号 1 发最小请求；单账号体检与批量「体检」都走这条。结论带 `checkedAt`，
UI 显示检测时间与「可能已变化」。

### 数据与 UI

- 账号字段：`accountClass: 'normal' | 'private' | 'unknown'` + `classCheckedAt: number | null`
  （用三态而不是布尔，`unknown` 必须是一等状态）
- 账号池每行徽标：`正常` / `风控` / `未判定`；悬停说明「只影响 planner 模型；
  OpenRouter 类模型两类账号都能钉」
- 新增按钮：单账号「体检」、池级「全部体检」；回执走既有 mutation 模式

### 风险

- 判定会翻转 → 必须展示时间，不允许当成静态属性写进路由逻辑
- 体检消耗额度 → 明确 1 发/账号，批量前显示数量

---

## 2. 多网关（multi-gateway）

### 概念

- **账号池**：全局，只定义一次（名称/密钥/到期/分类）
- **网关**：一个独立接入面 = 名称 + 端口 + 代理密钥 + 账号子集 + 账号策略 + 失败转移参数 +
  **该网关自己的模型清单与路由配置**
- 控制台只挂在**主网关**端口（不重复挂）；其余网关只提供 `/v1`

### 配置 v3（示意）

```jsonc
{
  "version": 3,
  "accounts": [{ "name": "...", "key": "...", "expiresAt": "2026-12-31" }],
  "gateways": [
    {
      "id": "main", "name": "主网关", "port": 3123, "bindHost": "127.0.0.1",
      "proxyKey": "sk-...", "accounts": ["a@x", "b@y"], "accountMode": "sticky",
      "failover": { "attemptTimeoutMs": 60000, "idleTimeoutMs": 60000, "budgetMs": 90000 },
      "knownModels": ["cline-pass/deepseek-v4.1-flash"],
      "perModel": { "cline-pass/deepseek-v4.1-flash": { "upstreams": ["deepseek"], "pinMode": "strict" } }
    },
    {
      "id": "risk", "name": "风控号专用", "port": 3124, "proxyKey": "sk-...",
      "accounts": ["c@z"], "accountMode": "single",
      "knownModels": ["cline-pass/mimo-v2.6-pro"],
      "perModel": { "cline-pass/mimo-v2.6-pro": { "upstreams": ["xiaomi"], "pinMode": "strict" } }
    }
  ],
  "console": { "gateway": "main" }
}
```

- 迁移：旧 `accounts` → 全局；旧 `port/proxyKey/accountMode/failover/knownModels/perModel`
  → `main` 网关；`console.gateway = "main"`
- 端口上限 8 个；`PORT` 环境变量只覆盖**主网关**端口（桌面壳依赖这一点）
- 单网关绑定失败 → 该网关标 `error` 并写日志，**不影响其它网关**；控制台在网关页显示失败原因

### 服务端结构变化

| 模块 | 变化 |
|---|---|
| `http/server` | 从「一个 listener」改为「每个网关一个 listener，共享 ctx + 网关上下文」 |
| `accounts/pool` | 每个网关一个 `AccountPool`（引用全局账号，各自粘性/轮转状态） |
| `proxy/chain` | 依赖注入改为「网关级 deps」（failover 参数、pool、health 按网关隔离） |
| `upstream/probe` | 探测结果写 `metadata.models[gatewayId][modelId]`（pinState 依赖账号） |
| `store/metaStore` | metadata schema 升级 + 旧数据迁到 `main` |
| `http/routes/api` | 控制台 API 全部带网关维度（查询参数 `?gateway=`，默认主网关） |
| 请求历史 | 记录 `gateway`；筛选/统计按网关 |

### 控制台 UI

- 新页面「网关」：列表 + 新建/编辑（端口、密钥、账号勾选、账号策略、失败转移参数）、
  每个网关的连接地址与状态
- 「订阅模型」「测试台」页头加**网关切换**（Segmented，默认主网关）；路由配置、探测结果、
  渠道清单都按网关隔离
- 状态栏接入地址显示当前网关；网关页可复制任意网关地址

### 风险与取舍

- 配置面变大 → schema 强校验 + UI 只暴露必要项；未知字段忽略并留日志（沿用现有迁移风格）
- 多端口监听 → 失败必须局部化（见上），控制台要能看见「哪个网关没起来」

---

## 3. 账号到期时间

- 字段：`expiresAt?: string`（`YYYY-MM-DD`，本地日期，不引入时区复杂度）
- 编辑：账号编辑弹窗加日期选择（`DatePicker`，允许清空）
- 展示：
  - 未填写 → 账号行显示「未设置到期时间」，页面头部汇总「N 个账号未设置到期时间」并给入口
  - ≤ 7 天 → 金色徽标「N 天后到期」
  - 已过期 → 红色「已过期」（**不自动停用**：可能只是没续期日期，停用是破坏性动作）
- 排序：可选「按到期时间」，默认保持现有顺序

---

## 4. 订阅模型页的纵向平衡

**实测（1170×860，内容列 726 高）**

| 元素 | 高度/位置 |
|---|---|
| 页头 → 首块顶部 | 56 / 126（不变量） |
| 两栏（模型列表 / 渠道） | 126–538，**412** |
| 路由策略 | 554–709，**155** |
| 最后区块底 → 内容区底 | **97px 空白** |

根因：两栏用 `height: calc(100vh - 448px)` 的魔法数字，不随实际 chrome 变化。

**改法**：两栏行改为 `flex: 1 1 auto; min-height: 0`，页面根容器填满内容列；两栏内部的
滚动容器保持各自的 `overflow`。结果：两栏 412 → ~485，路由策略贴底，底部只留内容区
自身的 24px 内边距作为平衡空间。自检：该页纵向滚动条为 0（「装得下」不变量）。

---

## 5. 字体

**实测根因**：正文/表格/代码块都已是 Microsoft YaHei UI；**只有 `.cps-mono`
（等宽字体栈）把中文落到了 SimSun（宋体）**——Windows 上 `monospace` 的 CJK 回退就是宋体。

**改法**（一处定义，`theme.ts` 的 antd token + `app.css`）：

```
sans : -apple-system, "Segoe UI", "Microsoft YaHei UI", "PingFang SC",
       "Noto Sans CJK SC", "Source Han Sans SC", sans-serif
mono : ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei UI",
       "Noto Sans Mono CJK SC", monospace
```

不打包字体（思源黑体体积大且系统已有等效字体）。**自检**：用 canvas 像素比对同一串中文在
各字体下的渲染结果，确认没有任何上下文落到 SimSun（本次排查用的方法可直接做成回归检查）。

---

## 6. 多语言（i18n）

### 规模（实测）

23 个前端文件、约 639 行含中文（含注释；实际要抽的文案约 400 行）。后端也有用户可见文案
（如 `pinDisabledReason`）。

### 设计

- `web/src/i18n/`：`messages/zh-CN.ts` / `messages/en-US.ts`（扁平 key + 命名空间：
  `common/models/accounts/playground/history/catalog/security/gateway/status`）
- `I18nProvider` + `useT()`；语言存 localStorage，首次按 `navigator.language`，**中文为基准**
- **即时热切换**：React context 驱动，不刷新；同时切 antd `ConfigProvider locale` 与 dayjs locale
- 后端文案：返回稳定 `code` + `params`（如 `{ code: 'pin.ignored', params: { routed: '...' } }`），
  前端映射；原始中文 message 保留给日志/客户端。**不在前端猜后端字符串**
- 状态栏右下角：**移除「清除本机保存的访问密钥」**，换成语言切换（中文 / English）。
  远端用户忘记密钥时的恢复路径明确写进文案：清除站点数据，或换一把密钥
- 文案准则不变（只说是什么/做什么/会发生什么）；英文按产品语言写，不做逐字直译
- 加单测：zh/en key 集合完全一致（防漏翻）

### 顺序

先定架构与 key 规范 → 新 UI（网关页）从一开始就 i18n 就绪 → 最后统一抽旧文案，避免返工。

---

## 7. 分阶段实施

| 阶段 | 内容 | 可验证产出 |
|---|---|---|
| **P1** | 字体（5）+ 模型页纵向平衡（4） | 视觉修复；六页不变量与「装得下」复测全绿 |
| **P2** | 账号分类（1）+ 到期时间（3） | 账号池升级：徽标、体检、日期；单测覆盖判定与到期计算 |
| **P3** | 配置 v3 + 多网关（2） | 自动迁移；多 listener；网关页 + 页头切换；每网关隔离（pool/health/metadata/history） |
| **P4** | i18n（6） | 全量文案 + 热切换 + 语言切换替代清密钥；zh/en 完整性单测 |
| **P5** | 审计与发布 | 六页 × 三尺寸、隔离 UAT、docs/UAT.md、README/CHANGELOG、3.0.0、tag |

每个阶段结束都保持「可运行、可验证、可停」；P3 是唯一的架构级改动，前后都要跑完整回归。

---

## 8. 测试与验收

**单测**

- 配置 v2→v3 / metadata v2→v3 迁移（含损坏与缺字段）
- 多网关：账号隔离、策略隔离、端口失败局部化、历史分网关
- 账号分类：三态判定（normal/private/unknown）、`checkedAt` 保留策略
- 到期计算：未设置/临期/已过期；不自动停用
- i18n：zh/en key 一致；`code` 映射兜底

**隔离 UAT（端口 3133，真实网关，消耗最小额度）**

- 两个网关、各绑一组账号 → 分别用各自的密钥请求，确认模型清单/渠道/历史互不串
- 分类体检：正常号与风控号各一 → 徽标与检测时间正确
- 语言热切换：不刷新切换，检查六个页面、气泡、空态、错误提示均切换且无残留中文
- 字体：canvas 像素比对无 SimSun

**不变量自检**

六页 × {1506×900, 1280×800, 1170×846}：标题顶/首块顶/左边缘一致；横向溢出 0；
测试台纵向溢出 0；模型页两栏填满且无页面滚动。

---

## 9. 待确认（默认按此实施，若不认可请指出）

1. **网关 = 端口 + 账号子集 + 策略 + 自己的模型清单与路由配置**（默认）。控制台只挂主网关。
2. 网关数量上限 **8**；`PORT` 环境变量只覆盖主网关。
3. 语言先做 **zh-CN + en-US**，结构可扩展。
4. 风控判定模型默认 `cline-pass/deepseek-v4.1-flash`，可在设置改。
5. 到期提醒只做徽标 + 页头汇总，不发桌面通知。
6. 「清除本机保存的访问密钥」确认移除（远端恢复路径改写进文案）。
7. 数据目录、便携模式、桌面壳「退出即真退出」三道闸不变。
