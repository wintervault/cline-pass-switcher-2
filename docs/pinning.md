# 钉住上游：调研记录与设计决策

> 本文档是钉住上游（pin upstream）功能的**权威事实来源**。四个独立来源相互印证，
> 时间线完整。后续任何会话改动钉住相关代码前，先读这里。
> 最后核对：2026-10-10。

## 一、核心结论（TL;DR）

**`providerOptions.gateway.*`（规划器管道的钉住写法）是否被网关执行，取决于账号风控状态，
且随时间变化。代码绝不能硬编码「能钉」或「不能钉」，必须逐模型探测、逐次审计。**

| 管道 | 钉住写法 | 现状（2026-10） |
|---|---|---|
| 直连（direct，`:free` 目录模型 → OpenRouter） | 顶层 `provider.only` | **一直有效** |
| 规划器（planner，`cline-pass/*` → Vercel AI Gateway） | `providerOptions.gateway.{only,order,sort}` | **按账号风控而异**：部分账号生效，部分账号参数被整体丢弃、请求被拉到 `openai-compatible-private` |

## 二、时间线（四来源综合）

| 时间 | 事件 | 来源 |
|---|---|---|
| ≤2026-09-17 | planner 管道钉住生效：假上游探针报 400，错误正文带 `Available providers are: <16 家清单>` | issue #3 |
| 2026-09-18 | linux.do 帖发布 CPA 双形态注入配置（`providerOptions.gateway.only` + 顶层 `provider.only`），实测有效 | 2918417 #1 |
| 2026-09-20 起 | planner 管道整体忽略 `providerOptions`：同样的探针返回 200，`sort` 也不再生效（Vercel 文档说 sort 生效时响应元数据会出现 `gateway.routing.sort`，实测无） | issue #3 |
| 2026-09-22~30 | dsh 插件作者实测确认；网关元数据新增 `affinity.pinnedProvider`、`modelAttempts[].providerAttempts[]` 等字段；尝试把钉选口搬到 `affinity` 也无效 | dsh 文档 |
| 2026-10-02~04 | 社区发现**按账号区别对待**：同套餐两账号，一个能钉（钉无效 slug 会被拒绝），另一个怎么请求都被固定路由到 `openai-compatible-private`（钉无效 slug 也"成功"）；且能钉/不能钉会随时间翻转；模型相关——只有 deepseek-v4.1-flash 可钉，glm/kimi 钉不了 | 2978656 #1 |

## 三、机制细节

### 3.1 「一行判定法」——探针

用**格式合法但不存在**的渠道名做探针：

```
providerOptions.gateway.only = ["zzz-not-a-provider"]   # planner 管道
provider.only = ["zzz-not-a-provider"]                  # direct 管道
```

- **报错**（4xx/5xx，正文含 `Available providers are:` 或 `No allowed providers`）
  → 参数仍被读取 → **可钉**
- **200 正常返回** → 参数被整体丢弃 → **不可钉**（此时钉什么、钉不存在的名字、不钉，响应逐字相同）

**探针名必须是合法 slug 形状**（`zzz-not-a-provider`）。旧代码用的 `__probe__`
是下划线形状，早在钉住功能还生效的 09-17 之前就被网关静默丢弃——这是旧版枚举
一直拿不到清单的独立原因。

注意区分：把 `only` 写成**类型错误**（如字符串而非数组）在任何账号下都会报
`Invalid input: expected array, received string`——那只是 JSON schema 校验，
**不能**用来判定语义是否被执行。探针必须是「合法数组成员 + 不存在的 slug」。

### 3.2 被风控账号的特征

- 无论钉什么（包括不存在的 slug），一律 200，`finalProvider = openai-compatible-private`
- `planningReasoning` 仍是完整的 16 家 system 渠道执行链
- 该渠道本身稳定但**速度慢**，且同样消耗订阅额度
- 会翻转：昨天能钉的号今天可能被拉走；换号立即恢复（多个社区成员复现）

### 3.3 元数据形状（2026-09-30 实测）

- `routing.finalProvider` / `fallbacksAvailable` / `canonicalSlug` 仍在
- 新增：`affinity: { outcome, pinnedProvider }`（pinnedProvider 是**网关自己的偏好**，
  不是我们的字段被听懂了）、`modelAttempts[].providerAttempts[]`、
  `totalProviderAttemptCount`、`originalModelId`、`clientSessionId`
- `fallbacksAvailable` 的语义是「执行链**去掉链首**」：网关把 deepseek 放链首后，
  清单里就不再有 deepseek——**用它做渠道清单会系统性漏掉链首渠道**

### 3.4 渠道清单的可靠来源排序

1. **`planningReasoning`**：`System credentials planned for: a, b, c. Total execution
   order: a(system) → b(system) → …` ——完整候选池（含链首），探针失效后唯一可靠的枚举来源
2. `fallbacksAvailable`：补集校验用（= 执行链去掉链首）
3. `finalProvider`：本次实际命中的渠道，**必须**并入已知清单（否则链首渠道永远不在列表里）
4. 探针报错里的 `Available providers are:`（仅在参数被读取时可用）

### 3.5 一个会咬人的坑

`max_tokens` 给太小（如 16~24），推理模型把额度烧在 reasoning 上，网关直接回
HTTP 500 `{"error":"empty response content"}` ——**不是路由问题**，别读成「上游坏了」。

## 四、设计决策（本项目的实现策略）

### D1 探针作为总开关（采纳 issue #3 建议 1）

`probeModel` 在确定管道后追加「钉住参数是否被读取」探针，结果写入
`ModelMeta.pinnable` + `pinState`（`enforced` / `ignored` / `unknown`）+
`pinDisabledReason`。

- `ignored`：UI 在模型行明示「网关已忽略上游偏好」，禁用「校验」按钮（避免全绿假象），
  渠道面板顶部出告警
- `unknown`（探针网络失败等）：保持上次状态，UI 提示未确认

### D2 渠道清单改用执行链解析（采纳 issue #3 建议 2）

`parsePlannedChain()` 解析 `planningReasoning` 的两个句式，与 `fallbacksAvailable`、
`finalProvider`、探针清单（若可得）取并集。**必须含链首**（把 `finalProvider` 并进列表）。

### D3 逐次审计：钉住结果校验（借鉴 dsh 本地闸，降级为「检测+兑现」）

dsh 插件在宿主内做「扣住 SSE 终止帧、逐帧审计 `finalProvider` 与全部成功
`providerAttempt`，违规则作废整次调用」。我们是独立代理，流式撤回=扣 `[DONE]` 帧，
内容已流出、只能事后作废，代价与收益不匹配，因此：

- **非流式 + strict 钉住**：响应 `finalProvider ≠ 目标渠道` 时视为该次尝试失败
  （渠道级），进入既有故障转移链——把「网关不听话」当作渠道故障兑现「严格」语义
- **流式**：RoutingTap 解析出的 `finalProvider` 与目标不符 → 只做标记（trace note +
  历史红标 + 响应头），不撤回（诚实限制，与 dsh 文档结论一致）
- **preferred / auto 模式不审计**：网关本来就有回退自由，审计会误伤
- **前提**：`pinState === 'enforced'` 才审计。`ignored` 时不注入也不审计（探针已知参数被丢弃）

### D4 注入保持不变

两种形态继续注入（pipeline 未知时双写，覆盖两条管道——与 2918417 #1 的 CPA 配置一致）。
参数被忽略时注入成本为零，网关哪天恢复即自动生效。

### D5 校验防假绿（采纳 issue #3 建议 3）

`validateUpstreams` 在 `pinState !== 'enforced'` 时直接拒绝执行并返回原因——
钉不住时每个渠道的请求都会成功并返回 `empty response content`（被 `classifyChannelStatus`
判为 ok），输出全绿是误导。

### D6 模型差异与账号差异如实呈现

- 只有部分模型可钉（glm/kimi 钉不了、deepseek-v4-flash 执行链只有一家）——探测结果按模型记录
- 可钉性按账号风控而异——探测用当前选中账号，UI 展示探测时间；文档明示「换个账号结果可能不同」

## 五、来源

1. **issue #3**（munmunjaklin458-afk/cline-pass-switcher，2026-09-20，已关闭）
   `providerOptions.gateway.*` 被整体忽略的一手测量数据与判定法
2. **linux.do 2918417**（CPA 钉 DeepSeek 官方上游的方法，2026-09-18）
   双形态注入配置；#16-#22 楼记录了 09-20 失效与缓存归零的影响
3. **dsh 插件文档**（dsh.deepseek404.com，BreakFree003/dsh-clinepass-deepseekv4.1）
   本地闸设计：逐帧审计、撤回 vs 缓冲的取舍、违规文案的注入防护、
   2026-09-30 复测的新元数据形状
4. **linux.do 2978656**（2026-10-04）
   按账号风控的双账号对照实验；`openai-compatible-private` 现象；模型差异
