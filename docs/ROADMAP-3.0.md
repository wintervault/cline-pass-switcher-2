# 3.0.0 路线图（2026-10-17 起草）

> **执行入口：§10 执行手册**；设计决定见 §9（已确认，执行时不要再改）。
> 进度：P1 未开始 · P2 未开始 · P3 未开始 · P4 未开始 · P5 未开始（完成一个阶段就改这里）
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
  "upstreamBase": "https://api.cline.bot/api/v1",
  "accounts": [{ "name": "a@x", "key": "...", "expiresAt": "2026-12-31" }],
  "gateways": [
    {
      "id": "main", "name": "主网关", "port": 3123, "bindHost": "127.0.0.1",
      "proxyKey": "sk-...", "accounts": ["a@x", "b@y"], "accountMode": "sticky",
      "activeAccount": "a@x",
      "corsOrigins": [], "exposeCatalog": false, "publicBaseUrl": "",
      "failover": { "attemptTimeoutMs": 60000, "idleTimeoutMs": 60000, "budgetMs": 90000 },
      "knownModels": ["cline-pass/deepseek-v4.1-flash"],
      "perModel": { "cline-pass/deepseek-v4.1-flash": { "upstreams": ["deepseek"], "pinMode": "strict" } }
    },
    {
      "id": "risk", "name": "风控号专用", "port": 3124, "bindHost": "127.0.0.1",
      "proxyKey": "sk-...", "accounts": ["c@z"], "accountMode": "single",
      "activeAccount": "c@z",
      "knownModels": ["cline-pass/mimo-v2.6-pro"],
      "perModel": { "cline-pass/mimo-v2.6-pro": { "upstreams": ["xiaomi"], "pinMode": "strict" } }
    }
  ],
  "console": { "gatewayId": "main" }
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

## 9. 设计决定（2026-10-17 已确认，执行时不要再改）

前 7 条是上一轮列出的默认项，用户已确认「先落地计划」。后 6 条是本次把计划落到可执行
形态时确定的结构性决定。

1. **网关 = 端口 + 账号子集 + 账号策略 + 自己的模型清单与路由配置**；控制台只挂在
   **控制台网关**（`console.gatewayId`，默认 `main`）上，其余网关只提供 `/v1`。
2. 网关数量上限 **8**；`PORT` 环境变量只覆盖**控制台网关**的端口（桌面壳固定传 3123）。
3. 语言先做 **zh-CN + en-US**，结构可扩展；中文是基准。
4. 风控判定模型默认 `cline-pass/deepseek-v4.1-flash`，可在设置改。
5. 到期提醒只做徽标 + 页头汇总，不发桌面通知。
6. 移除「清除本机保存的访问密钥」，换成语言切换。
7. 数据目录、便携模式、桌面壳「退出即真退出」三道闸不变。
8. **`upstreamBase` 保持全局**（所有网关连同一个 Cline 网关）；`proxyKey` / `corsOrigins` /
   `exposeCatalog` / `publicBaseUrl` / `failover` / `accountMode` / `knownModels` /
   `perModel` 下沉到**网关级**。
9. **账号的标识改为 `name`**（全局唯一，加载时强制）；配置里的 `activeAccount` 从下标
   改成账号名，并按网关分别保存。
10. **「访问与安全」页并入「网关」页**：接入地址、API Key、CORS、目录暴露本来就是接入面
    的属性，多网关后按网关编辑。导航变为：订阅模型 / 账号池 / 网关 / 测试台 / 请求历史 /
    完整目录（六页）。
11. **账号分类是观测值，不是配置**：`accountClass` + `classCheckedAt` 存 metadata
    （按账号名）；`expiresAt` 是用户声明，存 config。
12. 中文词典是 i18n 的**类型源头**（`const zh = {...} as const`，`en` 的类型是
    `Record<keyof typeof zh, string>`）——漏翻由 typecheck 拦住，不靠单测提醒。
13. 后端用户可见文案返回 `code + params`；前端按 code 映射，未知 code 回退显示原文。

---

## 10. 执行手册（下一个会话从这里开始）

> 目标：按 P1 → P5 顺序做完 3.0.0。每个阶段结束都必须「可运行、可验证、可停」。
> 全程遵守「开发 / 自测隔离」：线上实例不暂停、不替换；自测走 `npm run dev:isolated`。

### 10.0 开工前（必做）

1. 读 `CLAUDE.md`、`docs/ROADMAP-3.0.md`（本文）、`docs/timeouts.md`、`docs/pinning.md`。
2. 确认线上实例在跑（只读 GET `http://127.0.0.1:3123/healthz`），**不要动它**。
3. `npm run dev:isolated -- --from "<线上 data 目录>"` 起隔离实例（3133）。
4. 每个阶段前先跑一遍 `npm test / typecheck / lint` 作为基线。

### 10.1 P1：字体 + 模型页纵向平衡（纯前端）

**改动文件**

| 文件 | 改动 |
|---|---|
| `web/src/theme.ts` | 设 `token.fontFamily` 与 `token.fontFamilyCode`（见 §5 的字符串） |
| `web/src/app.css` | 定义 `--cps-font-sans` / `--cps-font-mono`；`.cps-mono`、`.cps-pre`、`pre/code` 引用它们（mono 栈必须带 CJK 回退） |
| `web/src/App.tsx` | 内容列 `height:100%`（确定高度）；六个页面包装层由 `flex: 0 0 auto` 改为 `flex: 1 0 auto; minHeight: 0`（可拉伸、不可压缩；只有模型的页面用得上，其余页不受影响） |
| `web/src/features/Models.tsx` | 两栏行 `height: calc(100vh - 448px)` → `flex: 1 1 0; minHeight: 300`；页面根 `height: 100%`；**去掉两栏外面那层不带 flex 的 div**（用 Fragment）——它就是高度传播的断点 |

**验收（必须全绿才算完成）**

- 1170×860：两栏行高 ≈ 485、路由策略贴底、最后区块底到内容区底 = 24px（内容区内边距），
  页面纵向滚动为 0
- 六页 × {1506×900, 1280×800, 1170×846}：标题顶 56 / 首块顶 126 / 左边缘一致；
  横向溢出 0；测试台纵向溢出 0
- 字体：用 canvas 像素比对（同串中文分别以元素栈与 SimSun 渲染）确认**没有元素落到 SimSun**
- `npm test / typecheck / lint / build` 全绿

**实做记录（2026-10-17 已完成）**

- 字体：`--cps-font-*` 由 `main.tsx` 写入（antd 6 不注入 `--ant-font-*`，实测为空）；
  canvas 像素比对：body → YaHei，mono/pre/code → Consolas（拉丁）+ YaHei UI（CJK），**无元素落到 SimSun**
- 版式（隔离实例 3133，1170×860）：两栏行 485（126..611）、路由策略 627..782 贴底、
  最后区块底到内容列底 = 0（再往下即内容区 24px 内边距）、内容区纵向滚动 0
- 六页 × {1506×900, 1280×800, 1170×860}：标题顶 56 / 首块顶 126 / 左边缘 228 全一致，
  横向溢出 0，测试台纵向溢出 0
- 关键坑：两栏外多包一层 `display:flex; flex-direction:column` 但没有 `flex` 的 div，
  剩余高度被截断在那里，两栏只涨到 `minHeight: 300`（底部空 185px）。去掉后一次到位

**commit**：`fix: 字体栈补 CJK 回退 + 模型页两栏填满（3.0 P1）`

### 10.2 P2：账号分类 + 到期时间

**数据**

- config：`accounts[].expiresAt?: string`（`YYYY-MM-DD`；非法格式 `.catch(undefined)`）
- metadata：`accountClass: { [accountName]: { class: 'normal'|'private'|'unknown'; checkedAt: number|null } }`

**新增服务** `server/src/accounts/classify.ts`

```
classifyAccount(deps, account):
  1 发 POST {upstreamBase}/chat/completions
  body = { model: cfg.classifyModel ?? 'cline-pass/deepseek-v4.1-flash',
           messages: [{role:'user',content:'ping'}], max_tokens: 64, stream: false }
  ——**不带任何钉住字段**（判定的是默认路由，不是参数是否被读）
  unwrap(json).routing.finalProvider:
    'openai-compatible-private' → private
    其它非空（deepseek/alibaba/…） → normal
    请求失败 / 429 / 空 → unknown（保留上次结论，只更新失败原因）
```

**API**：`POST /api/accounts/:name/classify`、`POST /api/accounts/classify`（全部启用账号，
逐个串行，回执两段式「正在体检 N 个账号 → 完成：正常 X / 风控 Y / 未判定 Z」）。

**UI（账号池）**

- 每行徽标：`正常`（绿）/ `风控`（橙）/ `未判定`（灰）；悬停：判定时间 +「只影响 planner
  模型；OpenRouter 类模型两类账号都能钉」
- 面板头汇总 `N 个未判定` / `N 个未设置到期` + 「全部体检」按钮
  （**实做调整**：汇总放进「账号」区块头而不是页头——摘要属于它所总结的那份列表，
  页头只保留唯一主操作「添加账号」；原计划的「可点进对应账号」也一并去掉，
  行内徽标已经指明了是哪几个账号）
- 编辑弹窗加「到期时间」日期选择（可清空）；行内显示 `到期 YYYY-MM-DD` / `未设置到期时间` /
  `N 天后到期`（≤7 天金色）/ `已过期`（红色，**不停用**）

**验收**

- 隔离实例上对三个账号各体检一次（3 发最小请求）：badge 与已知事实一致
  （`device0x400`→正常、`iamreneelin`→风控、额度用尽的→未判定）
- 单测：三态判定（含 Cline 信封、429、网络失败）、保留 `checkedAt` 的规则、到期天数计算

**实做记录（2026-10-17 已完成）**

- `max_tokens` 用 **256** 而不是 64：推理模型在小预算下会把额度烧在思考上，网关回
  HTTP 500 `empty response content`，会被误判成「未判定」——多几十个输出 token 比误判便宜
- 失败语义落成「保留旧结论 + 只更新 note」，`checkedAt` 只在**得出结论**时前移
- 账号名唯一在**加载、环境变量注入、保存**三处都强制；改名迁移观测数据用两段式搬运
- 真实网关体检（隔离实例 3133，配置来自线上账号池）：moonrabbit → 正常、
  device0x400 → 正常、iamreneelin → 风控；与已知事实一致
- UI 实测（1170×860）：3 天后到期=金色、已过期 16 天=红色、清空=未设置；页面无溢出
- 单测 264 → 300（新增 `classify.test.ts` / `expiry.test.ts` / `accountsApi.test.ts`，
  并补 `metaStore` 的 accountClass 用例）

**commit**：`feat: 账号分类体检与到期时间（3.0 P2）`

### 10.3 P3：配置 v3 + 多网关

> 唯一的架构级改动。先写 schema 与迁移（含单测），再动 server，最后 UI。

**3.1 schema / 迁移**

- `CONFIG_VERSION = 3`；`GatewaySchema` 按 §2 的字段；`ConfigSchema` 含 `accounts`（全局）、
  `gateways`（至少 1 个且 id 唯一）、`console.gatewayId`、`upstreamBase`、`historyLimit`
- 迁移 v2→v3：生成 `main` 网关，继承旧 `port/bindHost/proxyKey/corsOrigins/exposeCatalog/
  publicBaseUrl/accountMode/failover/knownModels/perModel`；`accounts` 全量引用；
  `activeAccount`（下标）→ `main.activeAccount`（账号名）；账号名去重（重复者追加 ` (2)`
  并写日志）
- metadata v3：`models[gatewayId][modelId]`；`history[].gateway`；旧数据整体迁到 `main`；
  形态检测：`Object.values(models).some(v => v && typeof v === 'object' && 'pipeline' in v)`
  → v2
- **测试**：v2 fixture（含 roundrobin、perModel、activeAccount）→ v3 断言；重复账号名；
  损坏 metadata 的备份与重建

**3.2 server**

- `appContext.ts`：构建 `gateways: Map<id, {def, pool, health, chain, probe, listener}>`；
  全局 `accounts` + `metaStore` + `catalog`；控制台网关 = `console.gatewayId`（端口被 `PORT`
  覆盖）
- `http/server.ts`：每个网关一个 `http.Server`；handler 带 gateway 上下文；绑定失败 → 该网关
  `status: 'error'` + 原因，其它网关照常；关闭时逐个 close
- `http/routes/chat.ts`：用该 listener 的网关 chain；`/v1/models` 用该网关的 `knownModels`
- `security/middleware`：按网关的 `proxyKey` / `corsOrigins`
- `accounts/pool`：每网关一个实例；`activeAccount` 按网关持久化
- `upstream/probe`：探测/校验结果写 `models[gatewayId][modelId]`
- `http/routes/api.ts`：网关级资源接受 `?gateway=<id>`（默认控制台网关）；新增
  `GET /api/gateways`（含运行状态）、`PUT /api/gateways/:id`、`POST /api/gateways`、
  `DELETE /api/gateways/:id`；`recordHistory` 带 `gateway`
- 桌面壳：**预期无需改 Rust**——`PORT=3123` 仍指向控制台网关；构建后实测一次冷启动与退出

**3.3 UI**

- 新页 `web/src/features/Gateways.tsx`（Panel 结构）：
  - 「网关列表」：名称 / 端口 / 账号数 / 模型数 / 状态（运行 / 端口绑定失败 + 原因）；
    操作：编辑、复制接入地址
  - 编辑抽屉：名称、端口、绑定地址、API Key、账号勾选（可混搭类型）、账号策略、
    CORS、目录暴露、公网地址、失败转移参数
  - 删除网关：需输入名称确认；最后一个网关不可删
- 「访问与安全」页删除；状态栏的 API Key 入口改为跳到「网关 → 当前控制台网关」
- 「订阅模型」「测试台」页头加网关切换（Segmented）；路由配置与探测结果按网关隔离
- 「请求历史」加 `网关` 列与筛选（默认全部）
- 状态栏接入地址显示控制台网关地址；有多个网关时附「共 N 个」
- 导航顺序：订阅模型 / 账号池 / 网关 / 测试台 / 请求历史 / 完整目录

**验收**

- 隔离实例：在 3134 加第二个网关（绑定同一组/另一组账号），分别用两个网关的 key 请求
  `/v1/models` 与 `/v1/chat/completions`，确认模型清单、渠道、账号、历史互不串
- 端口冲突：手工占用 3134 后启动 → 该网关显示失败原因，控制台与 3123/3133 正常
- 迁移：用线上 config/metadata 的副本（`--from`）启动隔离实例，确认行为与 2.9.12 一致
- 单测：v2→v3 配置/元数据迁移、双网关隔离、端口失败局部化、历史分网关

**commit**（建议拆三个）：`feat: 配置 v3 与迁移` / `feat: 多网关服务端` / `feat: 网关页与按网关路由配置`

### 10.4 P4：i18n

**结构**

```
web/src/i18n/
  index.tsx      I18nProvider + useT + 语言状态（localStorage: cps_lang）
  zh-CN.ts       const zh = {...} as const      ← 类型源头
  en-US.ts       const en: Record<keyof typeof zh, string> = {...}
```

**要点**

- key 用 `area.element.state`（`models.header.title`、`accounts.class.private`、
  `common.save`）；`t(key, params?)` 支持 `{name}` 插值
- 切换语言：context 触发重渲染（不刷新）；同时切 antd `ConfigProvider locale` 与 dayjs locale；
  设置 `document.documentElement.lang`
- 状态栏右下角：移除「清除本机保存的访问密钥」，换成语言切换；远端恢复路径写进
  AccessGate 的文案（清站点数据 / 换密钥）
- 后端：`pinDisabledReason` 等改为 `{ code, params }`（保留原 message）；前端映射表放
  `i18n/codes.ts`，未知 code 显示原 message
- **新 UI（网关页等）在 P3 就先写 `t(...)`**，P4 只补旧文案，避免返工
- 英文按产品语言写，不逐字直译；两遍自查：① 只说什么/做什么/会发生什么 ② 英文里不出现
  「中式语序」

**验收**

- 不刷新切到 English：六页正文、Panel 标题、状态栏、气泡、空态、错误提示、表格列头全部切换
- en 模式下扫描 DOM 文本，不应残留中文（允许白名单：模型 ID、账号名、上游错误原文）
- `npm run typecheck` 通过即证明 en 词典无漏项

**commit**：`feat: 中英双语与语言切换（3.0 P4）`

### 10.5 P5：审计与 3.0.0

1. 六页 × 三尺寸版式自检 + 「装得下」自检 + 字体像素自检（用 P1 的方法）
2. 隔离 UAT（`docs/UAT.md` 补 3.0 章节）：多网关隔离、账号体检、到期显示、语言热切换、
   真实网关一次非流式大请求（确认 v2.9.12 的修复仍有效）
3. 文档：README（多网关/账号分类/到期/i18n/配置 v3）、CHANGELOG（3.0.0 破坏性变更与迁移）、
   CLAUDE.md（新不变量：账号分类是观测值、网关级配置、i18n 类型源头、访问与安全已并入网关）
4. 版本号五处 → `3.0.0`；`npm run desktop:build`；`git status` 检查 Cargo.lock；
   提交 + tag `v3.0.0` + push
5. **不替换线上实例**：产出便携包后报告路径，由用户决定切换时间

### 10.6 每个阶段的定义（DoD）

- `npm test`（全绿，新增逻辑都有单测）、`typecheck`、`lint`、`build`
- 隔离实例上人工点过至少一轮（涉及真实网关的按最小请求数）
- 文档随代码更新（README / CHANGELOG / CLAUDE.md / docs）
- 一个 commit 一件事，消息说明「为什么」；阶段结束可随时停

