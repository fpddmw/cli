---
docType: architecture
scope: repo
status: current
authoritative: true
owner: cli
language: zh-CN
whenToUse: "规划或实现原子数据命令、connector、机器契约及其与 Skills/Research 的边界时。"
whenToUpdate: "当 data 命令、manifest/envelope/receipt、凭证、持久化、connector 或 Research 适配边界变化时。"
checkPaths:
  - AGENTS.md
  - .docpact/config.yaml
  - docs/agents/repo-architecture.md
  - docs/agents/repo-validation.md
  - docs/agents/data-runtime-implementation-plan.md
  - src/data/**
  - src/research/workspace/data-evidence-adapter.ts
  - test/**
lastReviewedAt: 2026-08-30
lastReviewedCommit: b4eb75b
---

# 原子数据运行时目标架构

## 决策

Tiangong CLI 是原子数据能力机器契约和执行行为的唯一事实来源。Skills 仓库负责
面向 agent 的触发语义、使用说明和精确兼容绑定，不复制 connector、JSON Schema、
HTTP、认证、分页、重试、缓存或回执实现。Auto Research 复用同一个 TypeScript
服务，再把通用数据结果提升为研究证据；它不通过子进程重新调用 CLI，也不要求独立
`data run` 进入 research workspace。

这项重构以 Node 24 和原生 TypeScript 7.0.2 编译器为实现基线。TypeScript 7 工具链
门槛已在数据业务代码之前独立完成，并接受四平台、clean-container 和发布包验证。
旧 Python fetch 脚本只能提供外部可观察行为、fixture 设计和来源知识，不能成为新
运行时依赖或兼容层。

## 公共命令契约

以下基础命令已经实现并由闭合 Schema 和合同测试冻结；内置 catalog 已注册两个试点
connector 和四个后续迁移 connector：

```text
tiangong-ai data catalog
tiangong-ai data describe <capability-id>
tiangong-ai data doctor <capability-id> [--live]
tiangong-ai data run <capability-id> <operation-id> --input <path|->
```

- `catalog` 离线、无副作用，返回内置能力、稳定版本/Schema 摘要，以及供 Agent
  初筛的 capability summary、`provides`、`doesNotProvide` 和 operation summary。
- `describe` 离线、无副作用，返回一个能力的 Execution Manifest、Discovery Metadata
  和带字段说明/示例的 operation Schema。
- `doctor` 默认只做静态配置诊断；只有显式 `--live` 才允许有界的 provider 探测。
- `run` 每次只执行一个 capability 的一个 operation。一个来源内部的分页、分块文件或
  重试仍属于该原子操作；跨来源 fan-out 或结果组合不属于它。
- 机器输入优先来自文件或 stdin。凭证、令牌和敏感 header 不得进入 argv、输入 JSON、
  stdout、错误详情或回执。
- JSON 模式返回稳定 envelope；pretty/人类输出只是投影，不改变退出码和机器语义。

JSON 模式的稳定退出码为：成功 `0`、参数/版本合同错误 `2`、执行阻断 `3`、明确的部分
结果 `4`。`data` 顶层路由不会调用既有 cwd `.env` 加载器；凭证只能来自 manifest
声明的环境变量。九份公共 contract Schema 发布在 `dist/data/schemas/`；各 operation
Schema 编译进对应 connector，并由离线 `data describe` 公开。

## 运行时分层

目标代码边界如下：

```text
src/data/
├── builtins.ts                 # 首批内置 connector 的显式注册点
├── commands.ts                 # data 命令解析和展示投影
├── contracts.ts                # 公共 TypeScript 类型与版本常量
├── catalog.ts                  # 内置、静态、可排序的 connector registry
├── runtime/
│   ├── execute.ts              # 单次原子调用编排
│   ├── bounded-http.ts         # endpoint、重定向、大小、超时和重试策略
│   ├── credentials.ts          # 逻辑凭证解析与最小注入
│   ├── canonical-json.ts       # 稳定序列化和语义摘要
│   ├── errors.ts               # 稳定错误分类和脱敏
│   ├── receipts.ts             # 核心运行回执
│   └── cache.ts                # 后续可选、受控、非研究状态的操作缓存
├── schemas/                    # 随 dist 发布的九份闭合公共 JSON Schema
└── connectors/                 # 各来源独立的 manifest、Schema、normalize、validate

src/research/workspace/data-evidence-adapter.ts
                                # DataResult -> Research evidence 的单向适配
```

`src/cli.ts` 只增加顶层路由，不承载 connector 业务逻辑。现有
`src/research/workspace/broker.ts` 可贡献已经证明有效的安全策略和测试，但其 project、
stage、journal、candidate、budget 和 evidence 状态不能下沉到 `src/data/**`。现有
Research `CapabilityDeclaration` 也不直接扩充为数据 manifest；二者使用场景和生命周期
不同，应由显式 adapter 连接。

## 三层发现语义

CLI 明确区分三层语义，避免把 provider、capability 和 operation 混成一个名称：

1. **Data Source**：外部数据集由谁维护，覆盖哪些地域/时间，原始粒度和官方资料是什么；
2. **Capability**：CLI 从该数据源开放的受限子集，提供与不提供什么，何时应选择或避开；
3. **Operation**：一次调用执行的具体动作、版本、输入输出和执行 limits。

CLI 拥有与 connector 实现直接相关的客观来源语义、覆盖范围和限制。Skills 继续拥有
“用户表达什么意图时触发该能力”以及如何组合进上层工作流，不复制来源执行逻辑。

## Execution Manifest 与 Discovery Metadata

每个内置 connector 发布两个闭合、不可变但 digest 独立的公共对象。

`DataCapabilityManifest` 是 **Execution Manifest**，至少包含：

- `schemaVersion`、命名空间化的 `capabilityId`、`capabilityVersion` 和
  `minimumCliVersion`；
- 稳定的 `providerId`、官方 endpoint scope、认证类型和逻辑 credential ID；
- operation ID/version、输入/输出 Schema ID/digest 和执行 limits；
- capability 级超时、请求/响应字节、分页/分块、重试、速率、记录数和诊断上限；
- 仅覆盖上述执行字段的 `manifestDigest`。

`DataCapabilityDiscovery` 是 **Discovery Metadata**，至少包含：

- Data Source 的名称、维护者、类别、summary/description；
- geographic/temporal coverage 和数据 granularity；
- capability 的 summary/description、`provides`、`doesNotProvide`；
- `selectionHints`、`typicalUseCases` 和 `sourceDocumentation`；
- 许可证、时效、限制和每个 operation 的 summary/description；
- 仅覆盖发现语义的 `discoveryDigest`。

`catalog` 为低成本 Agent 初筛投影必要的发现字段，同时发布 manifest/discovery 两个
digest；`describe` 发布两个完整对象和 operation Schema。修改来源说明或选择文案只改变
`discoveryDigest`，不得改变 `manifestDigest`、operation Schema digest 或运行回执。
operation 输入 Schema 自身的字段语义仍通过 `description` 和 `examples` 就地公开。

catalog、两个公共对象、canonical JSON 和 digest 计算必须与 locale、路径分隔符和运行
主机无关。connector 可以共同编译进一个 npm 包，但不得导入另一个 connector 的业务
实现。

## 内置 Connectors

`airnow.hourly-observations/fetch-hourly` 从
`https://files.airnowtech.org/airnow/` 按 UTC 小时规划官方 `HourlyAQObs` 文件，校验
CSV header/值并按 bbox、时间和 pollutant 过滤。每条记录和文件摘要保留 source-file
lineage；缺文件、坏文件以 `partial` 和明确 missing file 返回。Discovery Metadata 固化
AirNow 数据为 preliminary、subject to change，并禁止把它当作 regulatory-grade AQS
数据。
字段依据官方
[`HourlyAQObs` 格式说明](https://docs.airnowapi.org/docs/HourlyAQObsFactSheet.pdf)，使用
限制依据 [AirNow FAQ/Data Use Guidelines](https://docs.airnowapi.org/faq)。

`federal-register.documents/search` 只调用
`https://www.federalregister.gov/api/v1/documents.json`，要求 publication date bound
和至少一个 term/agency/type/topic/docket/RIN 收窄条件。数组过滤先按 code point
归一化，再由 bounded HTTP 稳定编码；页数和记录数受统一 limits 约束。输出只保留
document search metadata，不访问结果中的正文、XML 或 PDF 链接，也不作法律解释；
后续页失败保留已验证页并返回 `partial`。接口依据官方
[FederalRegister.gov API v1 文档](https://www.federalregister.gov/developers/documentation/api/v1)，
法律使用限制依据其
[About This Site](https://www.federalregister.gov/reader-aids/government-policy-and-ofr-procedures/about-this-site)。

`open-meteo.air-quality/fetch-hourly` 对应一个公开 Air Quality API 请求，接受最多十个
显式坐标、最多十六个官方变量，以及不超过 92 个日期的闭合窗口。变量按 code point
排序而坐标保持调用顺序；请求固定使用 GMT，输出按坐标保存 model grid、时间、单位和
对齐的 nullable value arrays。单个坐标或变量异常保留其余有效列并返回 `partial`，
record cap 按 location-hour 截断所有变量列。Discovery Metadata 明确该来源是 CAMS
模型网格背景值，不是站点观测；公开 endpoint 仅限非商业使用，并要求同时署名
Open-Meteo 和底层 CAMS 数据提供方。接口和变量依据官方
[Air Quality API 文档](https://open-meteo.com/en/docs/air-quality-api)，许可与端点边界依据
[Open-Meteo License](https://open-meteo.com/en/license) 和
[API Terms](https://open-meteo.com/en/terms)。商业 customer endpoint 与 API key 不在
该 capability 中隐式切换，若需要必须单独评审。

`open-meteo.flood/fetch-daily` 对应一个公开 Flood API 请求，接受最多十个显式坐标、
七个官方 discharge 变量、不超过 366 个日期的闭合窗口，以及可选 ensemble members。
输出按请求坐标顺序保存 selected river-grid coordinate、GMT 日期、单位和对齐的 nullable
series；单坐标、变量或 member 异常保留其余有效列并返回 `partial`，record cap 按
location-day 同步截断全部列。Discovery Metadata 明确该来源是 GloFAS v4 约 5 km
网格模拟值，endpoint 选择坐标附近最大河流，不能替代 gauge observation、告警、严重度
分类或应急建议。公开 endpoint 仅限非商业使用并要求同时署名 Open-Meteo 与 GloFAS；
商业 customer endpoint/API key 必须单独评审。接口与限制依据官方
[Flood API 文档](https://open-meteo.com/en/docs/flood-api)、
[Open-Meteo License](https://open-meteo.com/en/license) 和
[API Terms](https://open-meteo.com/en/terms)。

`open-meteo.historical-weather/fetch` 对应一个公开 Historical Weather archive 请求，
接受最多十个显式坐标、一个受控 reanalysis/model、最多十二个 hourly 与十二个 numeric
daily 变量，以及不超过 366 个日期的闭合窗口；hourly/daily 数组都必须显式传入，
不需要的粒度使用空数组。请求固定 GMT、摄氏度、km/h 和 mm，输出保存 requested/model
grid coordinate、elevation、单位和对齐的 nullable series；record cap 按 location 内
hourly 后 daily 的稳定顺序截断时间行。Discovery Metadata 明确该来源是 gap-filled
reanalysis/model grid estimate，不是 station observation；跨年代趋势输入应优先选
ERA5 或 ERA5-Land，避免 Best Match 的模型升级产生非气候断点。公开 endpoint 仅限
非商业使用并要求 Open-Meteo 与底层数据提供方署名；商业 endpoint/API key 不在该
capability 中。接口、模型和值域依据官方
[Historical Weather API 文档](https://open-meteo.com/en/docs/historical-weather-api) 与
[OpenAPI 规范](https://github.com/open-meteo/open-meteo/blob/main/openapi/historical-weather.yml)，
许可与端点边界依据 [Open-Meteo License](https://open-meteo.com/en/license) 和
[API Terms](https://open-meteo.com/en/terms)。

`usgs.water-instantaneous-values/fetch` 对应一个有界的 legacy WaterServices IV 请求。
它要求 bbox 或最多 100 个显式 site number 二选一，以及 ISO-8601 period 或显式
RFC3339 起止时间二选一；默认参数为 discharge `00060` 与 gage height `00065`，默认
site type/status 为 `ST/active`。WaterML JSON 归一化保留站点、坐标、参数、单位、
timestamp、qualifier 和 provisional 状态；单个坏 series/value row 作为明确 partial
隔离，整体 envelope 错误或超过 500 series、每 series 10,000 values 时阻断。接口和
25 平方度 bbox/100 sites 限制依据官方
[Instantaneous Values 文档](https://waterservices.usgs.gov/docs/instantaneous-values/instantaneous-values-details/)；
Discovery Metadata 同时标明 legacy WaterServices 计划于 2027 年第一季度下线，并指向
[现代 Water Data APIs](https://www.usgs.gov/tools/usgs-water-data-apis)。

六个 connector 均无凭证、默认 static doctor 完全离线，且互不导入业务函数。测试
fixture 仅按官方格式和旧 Skill 外部行为重建，不包含复制的 live provider 响应。

## 机器 Envelope

公共契约只统一执行和 provenance，不强行把不同来源压成一个巨型通用业务 Schema。
来源记录仍由各 operation 的输出 Schema 定义。

### 请求

`DataRunRequest` 至少绑定：

- `schemaVersion`、`capabilityId`、`capabilityVersion`；
- `operationId`、`operationVersion`；
- `input` 和可选的非敏感执行限制覆盖；
- 调用方生成的可选 `requestId`，不得被当作幂等或安全凭据。

### 结果

`DataRunResult` 至少包含：

- `status`: `success | partial | blocked`；
- 精确 CLI、connector、operation 和 Schema 版本/digest；
- 来源专属 `data`，以及记录数、分页/分块、截断和完整性摘要；
- `warnings` 与稳定、脱敏、可操作的错误投影；
- 一份 `CoreDataReceipt`。

`partial` 必须说明缺失了哪些页、文件、范围或字段，不能把不完整结果伪装为成功。
`blocked` 不携带可误用为完整证据的业务结果。

### 错误

稳定错误至少区分：

- `invalid-request`、`unsupported-operation`、`incompatible-contract`；
- `credential-missing`、`credential-invalid`、`provider-auth-blocked`；
- `endpoint-policy-blocked`、`rate-limited`、`timeout`、`network-failed`；
- `response-too-large`、`provider-response-invalid`、`normalization-failed`；
- `partial-result`、`internal-error`。

每个机器错误包含 `code`、`retryable`、`userActionRequired` 和最小安全详情。HTTP body、
URL query、header、环境变量值、本地绝对路径和 provider 原始错误不得未经 allowlist
进入输出。

## 回执与摘要

`CoreDataReceipt` 证明“调用了什么、观察到了什么字节、规范化出了什么”，但不宣称
结果已满足研究证据准入。它至少绑定：

- request、manifest、输入 Schema、输出 Schema 的语义摘要；
- 精确 CLI/connector/operation 版本；
- 安全的 provider/endpoint 标识和请求发生时间；
- 每页或每文件的原始响应摘要、合并摘要和规范化结果摘要；
- 重试、分页/分块、截断、部分失败、记录计数和完成状态；
- 仅用于审计的运行发生时间，与决定语义身份的 digest 分开。

回执不得保存凭证、敏感请求参数或任意 provider body。需要保留原始对象时，只能进入
受限、内容寻址的本地对象区，并由大小、权限、生命周期和摘要校验约束。

## 凭证、网络和持久化

- manifest 只引用逻辑 credential ID；运行时从明确允许的环境变量或未来受审阅的
  owner-only store 解析值。
- data 命令不得隐式扩大现有 cwd `.env` 自动加载语义。若保留兼容行为，基础契约 PR
  必须逐项声明来源、优先级、文件权限和禁用方式，并加入泄漏回归测试。
- endpoint 和重定向必须在 connector 的 HTTPS scope 内；IP literal、降级到 HTTP、
  跨域重定向和 credential 转发默认拒绝。
- 请求体和响应体必须有字节上限；超时、重试和 `Retry-After` 处理必须有硬上限。
- 独立 `data run` 默认不创建 Research project、ledger 或 evidence。可选缓存/断点只服务
  确定性执行，按 capability/operation/request digest 隔离，并可关闭、检查和清除。
- Research 持久化由 adapter 在核心结果校验后完成，不能由 connector 直接写入。

## Skills 与 Research 绑定

薄 Skill 只复制一个最小兼容绑定：

- `capabilityId`、`capabilityVersion`、`operationId`；
- `minimumCliVersion`；
- 公开 execution manifest/输入/输出 Schema digest；Discovery digest 可用于内容审计，
  但不作为运行兼容性阻断条件；
- 面向 agent 的触发条件、参数解释、来源限制和调用示例。

Skill 不复制闭合 Schema 或 connector 逻辑。Skills CI 从已发布/候选 CLI 导出 manifest，
验证这些绑定没有漂移。

Research adapter 接受已经通过核心 Schema 校验的 `DataRunResult`，额外施加 capability
lock、预算、候选/来源准入、永久证据、journal 和 review 规则。相同 connector 输入在
独立调用与 Research 调用中必须得到相同核心数据和核心回执；Research 只增加上层证据
链，不改变 connector 语义。

## 明确不做

- 不迁移旧仓库的 OpenClaw harness、议会/多 agent 编排或跨 case/round 数据库。
- 不保留 Python adapter、Python subprocess 兼容层或旧 Git 历史。
- 不在第一阶段实现动态第三方 connector 插件加载。
- 不在 connector 层实现跨来源选择、拼接、解释、统计结论或研究持久化。
- 不把未来通用计算工作台、分析沙盒或论文工作流塞进本次原子数据重构。

## 架构完成条件

基础架构只有在没有具体 provider 也能通过 catalog/describe、闭合 Execution Manifest
与 Discovery Metadata、空 registry、稳定错误、脱敏、canonical digest 和 connector
conformance 测试时才成立。任何首批 connector 都必须是这个合同的消费者，而不是
反过来决定一份只适用于自己的公共契约。
