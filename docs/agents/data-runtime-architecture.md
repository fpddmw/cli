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
lastReviewedCommit: 97cf02b1a9b215c7fd770cf8a1c00a3e85f5d86f
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

以下基础命令已经实现并由闭合 Schema 和合同测试冻结；在真实 connector 注册前，内置
catalog 有意保持为空：

```text
tiangong-ai data catalog
tiangong-ai data describe <capability-id>
tiangong-ai data doctor <capability-id> [--live]
tiangong-ai data run <capability-id> <operation-id> --input <path|->
```

- `catalog` 离线、无副作用，只返回内置能力及稳定版本/Schema 摘要。
- `describe` 离线、无副作用，返回一个能力的公开 manifest 和 operation Schema。
- `doctor` 默认只做静态配置诊断；只有显式 `--live` 才允许有界的 provider 探测。
- `run` 每次只执行一个 capability 的一个 operation。一个来源内部的分页、分块文件或
  重试仍属于该原子操作；跨来源 fan-out 或结果组合不属于它。
- 机器输入优先来自文件或 stdin。凭证、令牌和敏感 header 不得进入 argv、输入 JSON、
  stdout、错误详情或回执。
- JSON 模式返回稳定 envelope；pretty/人类输出只是投影，不改变退出码和机器语义。

JSON 模式的稳定退出码为：成功 `0`、参数/版本合同错误 `2`、执行阻断 `3`、明确的部分
结果 `4`。`data` 顶层路由不会调用既有 cwd `.env` 加载器；凭证只能来自 manifest
声明的环境变量。公共和 operation Schema 随构建产物发布在 `dist/data/schemas/`。

## 运行时分层

目标代码边界如下：

```text
src/data/
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
├── schemas/                    # 随 dist 发布的八份闭合公共 JSON Schema
└── connectors/<source>/        # manifest、operation、normalize、validate

src/research/workspace/data-evidence-adapter.ts
                                # DataResult -> Research evidence 的单向适配
```

`src/cli.ts` 只增加顶层路由，不承载 connector 业务逻辑。现有
`src/research/workspace/broker.ts` 可贡献已经证明有效的安全策略和测试，但其 project、
stage、journal、candidate、budget 和 evidence 状态不能下沉到 `src/data/**`。现有
Research `CapabilityDeclaration` 也不直接扩充为数据 manifest；二者使用场景和生命周期
不同，应由显式 adapter 连接。

## 能力 Manifest

每个内置 connector 声明一个不可变 `DataCapabilityManifest`，至少包含：

- `schemaVersion`、命名空间化的 `capabilityId` 和独立 `capabilityVersion`；
- `minimumCliVersion`，以及 manifest 的语义 digest；
- provider、来源类别、官方 endpoint scope、许可证和使用限制；
- 认证类型和逻辑 credential ID，只声明名称和用途，不保存值；
- 一个或多个闭合 operation：`operationId`、`operationVersion`、输入/输出 Schema ID
  与 digest；
- 超时、请求/响应字节、分页/分块、重试、速率和记录数上限；
- 支持的诊断模式、数据时效语义和已知限制。

catalog 的排序、canonical JSON 和 digest 计算必须与 locale、路径分隔符和运行主机
无关。manifest 可以共同编译进一个 npm 包，但 connector 不得导入另一个 connector
的业务实现。

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
- 公开 manifest/输入/输出 Schema digest；
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

基础架构只有在没有具体 provider 也能通过 catalog/describe、闭合 Schema、空 registry、
稳定错误、脱敏、canonical digest 和 connector conformance 测试时才成立。任何首批
connector 都必须是这个合同的消费者，而不是反过来决定一份只适用于自己的公共契约。
