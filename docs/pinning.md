# 钉住上游：调研记录与设计决策

> 本文档是钉住上游（pin upstream）功能的**权威事实来源**。四个独立来源相互印证，
> 时间线完整。后续任何会话改动钉住相关代码前，先读这里。
> 最后核对：2026-10-12（新增第六节：能不能绕过「参数被丢弃」的实测复查）。

## 一、核心结论（TL;DR）

**`providerOptions.gateway.*`（规划器管道的钉住写法）是否被网关执行，取决于账号风控状态，
且随时间变化。代码绝不能硬编码「能钉」或「不能钉」，必须逐模型探测、逐次审计。**

| 管道 | 钉住写法 | 现状（2026-10） |
|---|---|---|
| 直连（direct，`:free` 目录模型 → OpenRouter） | 顶层 `provider.only` | **一直有效**（2026-10-12 本机复测仍然有效，见第六节） |
| 规划器（planner，`cline-pass/*` → Vercel AI Gateway） | `providerOptions.gateway.{only,order,sort}` | **按账号风控而异**：部分账号生效，部分账号参数被整体丢弃、请求被拉到 `openai-compatible-private` |

2026-10-12 复查补充的两条（第六节有实测数据）：

1. **绕不过去**：planner 管线的参数丢弃是服务端策略。换字段名、换模型 ID 形态
   （规范 ID 也一样）、换客户端、换请求头都不行。
2. **能绕的是「管线」和「账号」两个维度**：direct 管线仍可钉；而网关给每个账号一个
   **稳定的渠道绑定**（本机实测：一个号恒 deepseek、一个号恒 private，20 小时零抖动）
   ——于是「钉上游」可以翻译成「**选对账号**」。

## 二、时间线（四来源综合）

| 时间 | 事件 | 来源 |
|---|---|---|
| ≤2026-09-17 | planner 管道钉住生效：假上游探针报 400，错误正文带 `Available providers are: <16 家清单>` | issue #3 |
| 2026-09-18 | linux.do 帖发布 CPA 双形态注入配置（`providerOptions.gateway.only` + 顶层 `provider.only`），实测有效 | 2918417 #1 |
| 2026-09-20 起 | planner 管道整体忽略 `providerOptions`：同样的探针返回 200，`sort` 也不再生效（Vercel 文档说 sort 生效时响应元数据会出现 `gateway.routing.sort`，实测无） | issue #3 |
| 2026-09-22~30 | dsh 插件作者实测确认；网关元数据新增 `affinity.pinnedProvider`、`modelAttempts[].providerAttempts[]` 等字段；尝试把钉选口搬到 `affinity` 也无效 | dsh 文档 |
| 2026-10-02~04 | 社区发现**按账号区别对待**：同套餐两账号，一个能钉（钉无效 slug 会被拒绝），另一个怎么请求都被固定路由到 `openai-compatible-private`（钉无效 slug 也"成功"）；且能钉/不能钉会随时间翻转；模型相关——只有 deepseek-v4.1-flash 可钉，glm/kimi 钉不了 | 2978656 #1 |
| 2026-10-05 | 社区共识收敛成「**只能换号**」；同时有人指出「cline 会主动抛弃请求头，订不订都没意义」；上游作者在 issue #3 的结论是「**是 cline 本身放弃了注入**，这套方案目前只有 or 渠道生效了」 | 2984413、2985036、issue #3 |
| 2026-10-07~09 | 2991638：4 个号里 3 个固定 deepseek（**不用钉也是**）、1 个固定 private；与用量是否相关**说法不一**（有人月限才 25% 也被拉走，也有人新号一买就 private） | 2991638 |
| 2026-10-10 | 社区用「黑号 / 概率性封控」描述这件事，并明确「上游限制跟随账号」 | 3006596 |
| 2026-10-12 | **本机复查**（第六节）：三个账号的 planner 管线全部丢弃参数；换规范 ID 无效；direct 管线仍有效；真实流量显示**渠道绑定在账号上、20 小时零抖动** | 本机实测 |

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

## 五、2026-10-12 复查：能不能绕过「参数被丢弃」

> 起因：用户提问「能不能绕过网关忽略钉住参数这个雷」。做法：四个来源原文复核 +
> 本机三个账号实测（一行判定法）+ 本机 20 小时真实流量的渠道分布统计。
> 全部实测命令与数据见本节；消耗极小额度（共 6 发最小请求）。

### 5.1 四个来源原文复核（此前摘要里漏掉的）

| 来源 | 补充事实 |
|---|---|
| issue #3（上游作者 09-27 关闭） | 作者本人的结论是「**是 cline 本身放弃了注入，和网关没关系**，这套方案目前只有 or 渠道生效了」。另外：`User-Agent`、`X-Client-Type: cline-cli` 都不影响结果；`sort` 与 `only` **一起**失效 → 被丢的是整个 `gateway` 对象，**换字段名恢复不了** |
| linux.do 2918417 / 2927818 | 09-18 双形态注入有效 → 09-20 失效。失效当天的执行链是 deepseek → alibaba → baseten → …（**deepseek 在链首**）——「看起来还钉着」只是因为网关自己把 deepseek 排第一，不是参数生效 |
| linux.do 2978656 / 2984413 / 2991638 / 3006596 | 「黑号 / 概率性封控」的共识；被拉走的号**固定** `openai-compatible-private`、怎么请求都出不去；能钉的号可以钉 wafer / alibaba / fireworks… 全钉上；**会随时间翻转**；与用量的相关性说法不一 |
| dsh 文档 / Go 实现 `Hxjcc/cline-pass-switcher-go` | dsh 试过把钉选口搬到 `affinity` ✗ 无效。Go 实现的 FAQ 与我们结论一致：「有些模型不能钉住渠道……探测后标出原因并禁用相关设置」——**两边的做法都只是标记，没有绕过** |
| linux.sb 22191 | 按模型的管线对照：`deepseek-v4.1-flash`、`glm-5.3` 走 planner（`providerOptions.gateway.only`）；`glm-5.3-flash` 走 **direct**（顶层 `provider.only`）；`deepseek-v4-pro` 只有 `openai-compatible-private` 一家。另给出**正向判据**：`planningReasoning` 里出现 `Provider set restricted to: <provider>` |

### 5.2 本机实测：一行判定法

探针：`only = ["zzz-not-a-provider"]`。**报错（带候选清单）= 参数被读取；200 = 被丢弃**。

| 账号 | planner 模型 `cline-pass/deepseek-v4.1-flash` |
|---|---|
| moonrabbitconnect@gmail.com | HTTP 429 —— 周额度已满，无法判定 |
| device0x400@outlook.com | **200，实际渠道 deepseek** → 参数被丢弃 |
| iamreneelin@gmail.com（当前选中） | 500 `empty response content` → 请求已过路由层、在生成阶段失败 → 参数同样被丢弃 |

换 ID 形态无效：

- `deepseek/deepseek-v4.1-flash`（规范 ID，不带订阅前缀）+ 两种钉住字段各写一份
  → **200，实际渠道 alibaba** → 仍是 planner 管线、参数仍被丢弃

direct 管线仍然有效（同一个账号）：

- `cline-pass/mimo-v2.6-pro` + `provider.only=["zzz-not-a-provider"]`
  → **500 `No allowed providers are available for the selected model`（来自 OpenRouter）**
  → 参数**被读了** ✓

### 5.3 本机 20 小时真实流量（500 条历史，10-11 22:49 → 10-12 19:12）

| 账号 | 请求数 | 实际渠道 | 中位耗时 |
|---|---|---|---|
| device0x400@outlook.com | 389 | **deepseek 100%** | 3.5 s |
| iamreneelin@gmail.com | 107 | **openai-compatible-private 100%** | 8.3 s |

- 496 次相邻请求里**渠道只变过一次**，而那一次正好是 17:01:10 的**账号切换**
- 也就是说：本机不存在「每轮乱跳、缓存被炸」的现象——**渠道是绑在账号上的，
  且这个绑定在 20 小时内零抖动**
- 真实代价不是缓存，而是「**选错账号时慢 2.4 倍**」（中位 3.5 s → 8.3 s）

### 5.4 结论

1. **绕不过去**：planner 管线的参数丢弃是服务端策略。换字段名、换模型 ID 形态、
   换客户端、换请求头都不行（四个来源 + 本机实测一致）。
2. **能绕的是两个维度**：
   - **管线**：direct 管线的 `provider.only` 仍然生效（本机同账号实测 ✓）。
     需要「真钉住」时，选 direct 管线的模型——订阅里就有（`cline-pass/mimo-v2.6-pro`）。
   - **账号**：网关给每个账号一个**稳定的渠道绑定**。于是「钉上游」可以翻译成
     「**选对账号**」——这正是本工具账号池能做、而现在没做的事（探针只测当前账号）。
3. **模型 ID 形态不改变管线**：`deepseek/deepseek-v4.1-flash` 与 `cline-pass/…` 都走 planner。
4. 未验证的一条路：**自带 key（BYOK）**——`providerOptions.gateway.byok` 带自己的
   DeepSeek key，理论上绕开订阅侧的渠道绑定。但成本模型变了（直接付 DeepSeek），
   且 `byok` 也在被丢弃的 `gateway` 对象里，未实测。

### 5.5 建议的下一步（都在工具层，不需要绕过网关）

| 项 | 说明 | 价值 |
|---|---|---|
| **按账号探测渠道绑定** | 探针目前只测「当前选中账号」（D6）。改成每个账号各测一发最小请求，记录「账号 → 实际渠道 + 参数是否被读」 | 直接回答「该用哪个账号」；把「钉住」落成「选账号」 |
| **路由稳定性统计** | 历史里已有 `provider` 字段：按「账号 × 模型」统计渠道分布与切换次数 | 量化「这个组合稳不稳」，也是绑定翻转的告警源 |
| **补正向判据** | 除反向探针外，读 `planningReasoning` 里的 `Provider set restricted to: <provider>` | 区分「真钉住了」与「参数被丢弃但恰好路由到那儿」（issue #3 警告的那种错觉） |
| **周期复探 + 翻转提醒** | 绑定会随时间翻转（社区多例），定期复探、翻转时提示 | 被动等待也有价值 |

**不建议做**：为流式加 dsh 那种「扣住终止帧」的强审计——本机渠道绑定稳定，
收益低、复杂度高（D3 的取舍仍然成立）。

## 六、来源

1. **issue #3**（munmunjaklin458-afk/cline-pass-switcher，2026-09-20，已关闭）
   `providerOptions.gateway.*` 被整体忽略的一手测量数据与判定法
2. **linux.do 2918417**（CPA 钉 DeepSeek 官方上游的方法，2026-09-18）
   双形态注入配置；#16-#22 楼记录了 09-20 失效与缓存归零的影响
3. **dsh 插件文档**（dsh.deepseek404.com，BreakFree003/dsh-clinepass-deepseekv4.1）
   本地闸设计：逐帧审计、撤回 vs 缓冲的取舍、违规文案的注入防护、
   2026-09-30 复测的新元数据形状
4. **linux.do 2978656**（2026-10-04）
   按账号风控的双账号对照实验；`openai-compatible-private` 现象；模型差异
5. **linux.do 2984413 / 2985036 / 2991638 / 3006596**（2026-10-05 ~ 10-10）
   「黑号 / 概率性封控」的社区共识；多账号对照（3 个号固定 deepseek、1 个号固定 private）；
   与用量相关性的分歧；「只能换号」的结论
6. **linux.sb 22191**（2026-09-15）
   按模型的管线对照表（哪些模型读 `providerOptions.gateway.only`、哪些读顶层 `provider.only`）；
   `planningReasoning` 里的正向判据 `Provider set restricted to: <provider>`
7. **Hxjcc/cline-pass-switcher-go**（Go 实现，另一套独立实现）
   FAQ 的结论与我们一致：不能钉的模型只做标记与禁用，不做绕过
8. **本机实测**（2026-10-12，第五节）：三账号 planner 判定、规范 ID 对照、direct 管线对照、
   20 小时真实流量的账号 × 渠道分布与切换统计
