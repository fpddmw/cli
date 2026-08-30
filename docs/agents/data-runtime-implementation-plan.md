---
docType: runbook
scope: repo
status: proposed
authoritative: true
owner: cli
language: zh-CN
whenToUse: "安排原子数据运行时的 TypeScript 7 升级、基础契约、connector、Skills 和 Research 联动实施时。"
whenToUpdate: "当阶段顺序、试点范围、PR 依赖、验证门槛、发布或回退策略变化时。"
checkPaths:
  - AGENTS.md
  - package.json
  - package-lock.json
  - tsconfig*.json
  - Dockerfile.clean-test
  - .github/workflows/**
  - docs/agents/data-runtime-architecture.md
  - src/data/**
  - src/research/workspace/data-evidence-adapter.ts
  - test/**
lastReviewedAt: 2026-08-30
lastReviewedCommit: 832e302
---

# 原子数据运行时实施计划

## 当前基线和停止点

- 计划基线：`origin/main` at
  `7b7fc682698778edf5b77d69f0fa3f944e6da4a6`。
- 计划分支：`codex/atomic-data-runtime-plan`，使用独立干净 worktree。
- 现有含未提交 Research 变更的 checkout 不做 pull、stash、reset、rebase 或复用。
- 本文和目标架构完成后停止；没有下一次明确确认，不开始工具链或业务代码改造。

## 总体顺序

```text
两仓计划同步评审
  -> CLI TypeScript 7 基线
  -> CLI 空数据运行时与机器契约
  -> CLI 试点 connectors
  -> 发布候选 CLI
  -> Skills 薄化迁移
  -> Research adapter
  -> 分批迁移剩余能力
```

CLI 是基座，因此实现和合并顺序以 CLI 为先。Skills 计划 PR 可以同时开放以评审触发
语义和迁移范围，但不能先合并一份引用不存在命令或未发布版本的生产 Skill。若必须
压缩为每仓一个 PR，则两个 PR 同时 draft/review，CLI PR 先合并并发布候选版本，Skills
PR 随后只更新已确认的 exact binding。

## 工作包 0：计划和迁移清单

交付：本仓两份 data runtime 文档，以及 Skills 仓对应架构/迁移 runbook。

- 冻结仓库所有权、公共命令候选、机器 envelope、回执和 Research 适配边界。
- 把旧 Python/OpenClaw 实现标记为只读知识来源；不合并历史，不直接翻译整文件。
- 对现有 fetch/search/download Skill 建立迁移分类：CLI connector、Research/KB 既有能力、
  继续独立、或退役。
- 确认首批候选为 AirNow Hourly Obs 与 Federal Register Documents：前者覆盖多文件时间窗
  和 CSV，后者覆盖分页 JSON 和元数据结果；两者无需生产凭证，适合先证明公共合同。
- 用仅测试用 synthetic connector 覆盖 credential injection/redaction；真实凭证来源
  NASA FIRMS 放在后续批次。

完成门槛：两个仓库的 docpact 路由、索引和计划校验通过；没有业务代码变更。

## 工作包 1：TypeScript 7 基线

状态：完成（2026-08-30）。

范围只包括工具链，不混入 `data` 业务行为：

- 将 `typescript` 升级到 7.x，并由 `package-lock.json` 锁定精确解析版本；保持 Node
  `>=24 <25`。
- 迁移不兼容的 `tsconfig` 选项、构建脚本和类型错误；不借机重写 Research/KB 行为。
- 确认 `tsx`、Node test、c8、Prettier、declaration/source map 和 npm pack 与 TS7
  协同。
- 更新 clean-test dependency layer 和四平台 CI 所需输入。

实际结果：

- `typescript` 升级为 `^7.0.2`，lockfile 固定 7.0.2 及官方平台二进制包；
- `tsconfig.json` 显式声明 Node 类型，不依赖 TypeScript 7 的空 `types` 默认值；
- 仓库未使用 7.0 暂不提供的 programmatic compiler API；
- 修复 5.9.3 基线上已经存在的 13 个测试类型标注/空值缩窄错误，不改变运行时；
- 全量 typecheck 加入四平台 CI 和 clean-container，在 coverage 之前强制执行。

验证：`npm run typecheck`、`npm run build`、`npm test`、`npm run test:platform`、
`npm run test:coverage`、`npm run test:clean:cold`、`npm pack --dry-run`，以及 docpact
门禁。任何现有命令 envelope 或退出码变化都视为回归。

回退：该工作包单独 commit/PR；若 TS7 在任一受支持平台不能通过，不开始工作包 2。

## 工作包 2：空运行时与公共机器契约

状态：完成（2026-08-30）。

先实现没有真实 provider 的骨架：

- 新建 `src/data/**` 分层和顶层路由；不继续扩张 `src/cli.ts` 的业务逻辑。
- 实现 manifest、catalog、describe、请求/结果/error/receipt Schema、canonical JSON 和
  digest。
- 实现静态 doctor、显式 live doctor 的权限边界和空 registry 行为。
- 提取/重写 bounded HTTP、endpoint scope、credential injection、重试、大小/时间上限和
  redaction。只复用 Research broker 中可证明通用的规则，不复制其 workspace 状态。
- 建立 connector conformance harness 和 synthetic connectors，覆盖无凭证、逻辑凭证、
  分页、部分结果、429、超时、超大响应、跨域重定向和 secret leak。
- 确保 JSON Schema 随 `dist/` 发布，并在 npm pack 测试中验证可发现性。

完成门槛：不注册真实来源也能稳定通过 catalog/describe/doctor/run 的成功与失败合同；
Windows/macOS/Linux/ARM 不因排序、路径或 locale 产生 digest 差异。

实际结果：

- 新增空的内置 registry、`data catalog/describe/doctor/run` 路由和成功/部分/阻断退出码；
- 发布 execution manifest、discovery、catalog、describe、doctor、run request/result、
  error 和 core receipt 九份闭合 JSON Schema，并由 TypeScript 构建复制到
  `dist/data/schemas/`；
- 建立 locale/路径无关的 canonical JSON、语义 digest 和把审计时间排除在外的核心回执；
- 建立只允许 DNS 主机 HTTPS scope 的 bounded HTTP，拒绝 IP literal、跨域重定向、
  credential-like query/body、超时、超限响应和 credential reflection；
- 凭证只按 manifest 的逻辑 ID 从精确环境变量解析并在 endpoint 校验后注入；`data`
  命令绕过 cwd dotenv 加载；
- synthetic conformance 覆盖无凭证、逻辑凭证、分页、部分结果、429、超时、响应超限、
  跨域重定向和 secret leak，且 pack 合同验证公共 Schema 可发现。

## 工作包 3：首批 connectors

### 3A AirNow Hourly Obs

- operation：有界 UTC 时间窗、bbox、pollutant 参数的 hourly file fetch。
- 证明：多小时文件计划、缺文件/部分失败、CSV header/值校验、bbox/time/parameter
  过滤、source-file lineage 和 preliminary-data 限制。
- fixture 从官方格式和现有 Skill 外部行为重建，不导入 Python runtime。

### 3B Federal Register Documents

- operation：term/date/agency/type/topic/docket/RIN 的 bounded document search。
- 证明：稳定 query 编码、分页/记录上限、空结果、provider metadata 校验和截断状态。
- 只返回文档搜索元数据，不抓取链接正文，也不做法律解释。

每个 connector 必须有独立 manifest、Schema、fixtures、contract tests、失败隔离和
license/source notes。connector 之间不得导入业务函数；共同代码只能上提到已评审的
runtime primitive。

完成门槛：各自可离线 catalog/describe/doctor，可用 fixture 完整测试 `run`，live smoke
为显式、非 CI 必需项；全仓门禁和 npm pack 通过。

实际结果：

- 注册 `airnow.hourly-observations/fetch-hourly`，按 UTC 小时生成最多 168 个官方文件
  路径，校验官方 CSV 字段并执行 bbox/time/pollutant 过滤；缺失或无效文件保留可用
  记录并返回显式 partial/file lineage；
- 注册 `federal-register.documents/search`，要求日期边界和收窄条件，稳定编码 term、
  agency、type、topic、docket、RIN，验证 provider pagination metadata，并明确区分
  complete、no-results、max-pages、max-records 与 later-page partial；
- 两个 connector 均使用独立 execution manifest、discovery metadata、闭合 input/output
  Schema、重建 fixture、来源/license 限制和 contract tests；实现仅依赖公共 data
  runtime，彼此无业务导入；
- 增加内置 registry 离线 catalog/describe/static-doctor 证明，并补强 public run request
  对 `undefined` 等非 JSON 值的 fail-closed 处理；
- 根据 PR #71 审阅意见补充 Data Source/Capability/Operation 三层发现语义；`catalog`
  投影 summary、provides/does-not-provide 和 operation summary，`describe` 返回完整
  Discovery Metadata、官方资料、覆盖范围、选择提示和带字段说明/示例的输入 Schema；
- discovery wording 使用独立 `discoveryDigest`，回归测试证明其变化不会改变 execution
  manifest 或 operation Schema binding；
- 本工作包已作为四个可独立审阅提交进入统一 CLI PR #71，审阅修订继续追加到同一 PR。

## 工作包 4：候选发布和 Skills 薄化

- 发布包含 TS7 基线、基础 data contract 和首批 connectors 的 CLI 候选版本。
- 从候选包导出 canonical execution manifest/Schema digest，作为 Skills 运行兼容绑定；
  Discovery Metadata 供 Agent 选择和内容审计，但说明文字漂移不阻断执行。
- Skills PR 删除首批 Python 执行脚本和 OpenClaw/eco-council 模板，只保留触发语义、
  参数说明、来源限制和 CLI 调用。
- Skills 离线测试拒绝缺失 capability、错误 digest、过低 CLI 版本和漂移命令面；安装
  smoke 使用隔离 HOME/project，不携带真实凭证。
- CLI 正式版本发布后更新 exact binding，再合并 Skills PR。

完成门槛：安装后的 Skill 调用已发布 CLI，且仓库中不再有第二份首批 connector
业务逻辑或 Schema。

## 工作包 5：Research adapter

- 在 CLI 内部直接调用 `src/data/**` 服务，不启动 `tiangong-ai data run` 子进程。
- 把 `CoreDataReceipt` 映射到 Research capability/evidence receipt，同时保留原始核心
  digest 和 connector 版本。
- Research 层继续拥有 capability lock、credential owner map、预算、candidate/role
  coverage、永久 evidence、journal、handoff 和 review。
- 对同一固定输入建立 parity test：独立 data 调用与 Research adapter 的核心结果和
  receipt digest 相同，Research 仅增加上层对象。

完成门槛：现有 Research clean-container 门禁先观察针对新 adapter 的 RED，再在新容器
转 GREEN；不得让 data runtime 依赖项目目录或 stage 状态。

## 工作包 6：后续分批迁移

建议批次，不等于全部自动批准：

1. USGS Water IV：作为后续迁移首项，扩展时序、空间、多变量、provisional qualifier
   和 legacy provider 生命周期合同。
2. Open-Meteo 系列：继续扩展时序、空间和多变量合同。
3. NASA FIRMS、OpenAQ、Regulations.gov：验证真实 credential 和 provider auth 路径。
4. GDELT 系列、Bluesky/YouTube/RSS/fulltext：先判断是原子 connector、内容获取器还是
   Research/媒体工作流，避免把异构行为硬塞进一个 data Schema。
5. Tiangong KB search、academic paper/download、email 和本地文件能力：保持既有产品
   边界，除非单独评审证明应迁入 data runtime。

每一批都先更新迁移清单，只以真实价值、许可清晰度、API 稳定性、维护成本、fixture
可得性和 Research 需求决定是否迁移，不追求旧 Skill 数量对等。

### 后续迁移 1：USGS Water IV

- 新增 `usgs.water-instantaneous-values/fetch`，执行一个 bbox 或 sites、period 或显式
  window 的有界 WaterServices IV 请求；闭合输入 Schema 使用官方 100 sites 与 bbox
  25 平方度上限，并保留旧 Skill 的 `ST/active` 和 `00060/00065` 默认值。
- WaterML JSON 输出归一化为 series summary 与 observation records；坏 row/series 保留
  可用数据并返回 partial，整体 envelope 或安全上限错误返回 blocked，record cap 返回
  complete-but-truncated。
- fixture 为按官方 WaterML JSON 结构重建的合成数据；catalog、describe、static doctor、
  connector conformance 与 dist pack 合同全部离线验证。
- Discovery Metadata 明确该 endpoint 为计划在 2027 年第一季度下线的 legacy 服务，
  并指向现代 Water Data APIs；这项迁移完成当前 Skill 去重，但不假装解决长期 API
  迁移，现代 endpoint 需要单独 capability/operation 评审。

## PR 与提交拆分

建议保持下列可独立审阅/回退单元：

1. CLI plan PR：本文、目标架构、docpact 路由；无运行时代码。
2. Skills plan PR：对应迁移架构、清单和 runbook；无 Skill 业务改动。
3. CLI TS7 PR：纯工具链和由此产生的兼容修复。
4. CLI foundation PR：空 registry、公共 Schema、runtime primitives 和 conformance。
5. CLI pilot PR：AirNow/Federal Register，可按 connector 再拆分。
6. Skills pilot PR：在 CLI 候选包可验证后开放，正式包发布后合并。
7. CLI Research adapter PR：在独立 data contract 稳定后进入。

本次实施按用户要求把 CLI 计划、TS7、foundation 和 pilot 保留为独立本地 commits，
最终统一进入一个 CLI PR；这不改变每个 commit 的独立审阅和回退边界。

计划 PR 先同步评审；实现 PR 不形成“Skills 先引用未存在的 CLI”或“CLI 发布时依赖
未合并 Skills pin”的循环。

## 每阶段通用验收

- 先写外部行为/安全回归并在要求的 clean container 中观察 RED，再实现 GREEN。
- `catalog`、`describe` 和默认 `doctor` 全程离线、确定、无副作用。
- 真实 provider live tests 明确 opt-in，不进入普通 CI，不携带个人凭证或用户数据。
- JSON fixtures 经过脱敏、大小审查和许可证/来源说明；错误、日志、回执无 secret。
- TypeScript 类型、JSON Schema、runtime validator 和文档示例由同一合同生成或交叉验证。
- 完成 AGENTS 列出的全仓门禁和 `npm pack --dry-run`；依赖/容器输入变化必须 cold gate。
- 每个 PR 记录兼容性、迁移/回退方式和未完成项，不以聊天记录作为事实来源。

## 准备完成定义

准备完成是指：两个仓库都从最新 `origin/main` 建立了不污染现有工作的干净分支，CLI
和 Skills 的权威边界、TypeScript 7 顺序、试点、PR 依赖和验收门槛已持久化并通过文档
治理检查。准备完成不代表已经授权修改 package、运行时或 Skill。
