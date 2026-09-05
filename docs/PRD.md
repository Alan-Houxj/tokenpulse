# AgentMeter 产品需求文档（PRD）

> 版本：v0.1（MVP） · 状态：MVP 已实现 · 定位：开源社区工具

## 一、产品定义

**一句话**：本地优先的 AI Agent token 消耗托盘监控——把 Claude Code / Codex / Gemini CLI / Qwen Code / ZCode 散落在本地的用量记录，统一到一个实时仪表盘。

**目标用户**
1. 同时用 2+ 个编程 Agent 的开发者（消耗分散、心里没数）
2. API / 第三方中转用户（官方用量页看不到真实分布）

**场景优先级**（需求对齐确认）：① 消耗看得清 ② 成本可控 ③ 实时感知。订阅配额预警（5h/周窗口）为后续可选项。

**产品原则**：local-first（数据不出本机）、零配置（装完即用）、诚实数据（四类 token 分别计价、官方值/估算值打标签、订阅场景明示"API 等价估算"非账单）。

## 二、关键产品决策记录（含调研依据）

| 决策 | 结论 | 依据 |
|---|---|---|
| 数据获取 | 纯本地文件解析，不碰凭据/官方 API | 唯一对订阅制和第三方中转都有效的路线；cc-switch 证实"能改配置"≠"能拿聊天数据" |
| 覆盖边界 | MVP=编程 CLI；V1.1=BYOK 客户端；订阅制聊天 App 标"暂不支持" | 订阅制聊天 App 本地无 usage 数据（IndexedDB 只有内容），BYOK 客户端逐消息存精确 usage 且官方拒绝做聚合（Cherry Studio issue #6544 关闭）——真实需求真空 |
| 形态 | Electron 托盘常驻 + 点击展开窗口 | 用户确认接受 ~100MB 级常驻内存换取完整图表体验 |
| 采集方式 | 5s 轮询 + mtime/size 签名比对 + offset 增量读 | 社区共识：比纯文件监听可靠（缓冲溢出兜底即重扫）；CPU 近零 |
| 探测可见性 | 首启引导页 + 常驻数据源面板，不做 CLI 探测命令 | 用户确认：静默探测失败不吭声是排障地狱 |
| 存储 | Node 内置 node:sqlite（Electron 44 内嵌 Node 24 已验证可用） | 零原生依赖，规避 better-sqlite3 的 ABI/打包问题 |

## 三、功能规格（MVP 交付范围）

### 3.1 采集内核（插件式 Adapter）
- 五个数据源适配器（见 README 支持表），统一输出 `UsageEvent`
- 归一化口径：`input` 恒为非缓存输入（Codex/Gemini 的原始口径已减去 cached）；Codex 的 output 已拆出 reasoning
- 幂等键 `agent:session:request`（zcode 用内容寻址键防库重建 rowid 复用）
- 位点续读（jsonl=字节偏移处理残缺尾行；sqlite=rowid + 截断重扫）
- 社区坑对策：Codex 累计值绝不求和、Claude requestId 去重、超大文件永不全量重读

### 3.2 聚合与引擎
- SQLite（WAL）：events + file_positions 两表；日/会话/模型/趋势/活动 全 SQL 聚合
- 成本引擎：四类 token 分别计价，模型名归一化聚档（gpt-5.x→gpt-5 等），按事件时间戳选价，用户可覆盖；未知模型明示"缺价格"而非记 0
- 四态探测：ok（含统计摘要）/ absent / empty / unrecognized（提示提 issue，不阻塞其他源）

### 3.3 界面
- 托盘：动态图标（今日总量档位，位图字体手绘）、tooltip 分 Agent 小结、双击开窗、关窗常驻
- 首启引导：逐源探测结果 → 一键进入（后台回填历史）；空状态给安装指引
- 六页：总览（今日/7天/30天 × Agent/模型）、趋势（24h/7d/30d 曲线）、会话（明细表）、实时（活动会话+燃烧速率+心跳）、数据源（四态+重扫+自定义路径即时校验）、设置（轮询间隔/价格覆盖/重看引导）

## 四、验收结果（真机）

| 验收项 | 结果 |
|---|---|
| `npm start` 零配置启动，托盘+窗口+引导页正常 | ✅（截图存档） |
| 本机 Codex 34 文件回填 266 事件 / ZCode 843 行对齐 841（差=采集后实时增长，按位点验证一致） | ✅ |
| ZCode 全表 SUM 六项核对 | ✅（reasoning/cacheWrite 精确一致，其余按位点一致） |
| Codex 抽样会话 202 事件手工扫描 vs 库内 | ✅（事件数/input/cacheRead/output 全一致） |
| 21 个单测（适配器 fixtures/存储/引擎/端到端） | ✅ 全绿 |
| 引导页四态探测、缺价模型提示、≈API 等价估算标签 | ✅ 实机确认 |

## 五、已知边界与路线图

- 旧版 Codex（<2026-09）只有累计 token_count，暂不解析（双计风险），V1.1 用 last 增量+去重算法支持
- V1.1：BYOK 四客户端适配器（Cherry Studio V2 文件 / ChatBox IndexedDB / Jan JSONL / AnythingLLM SQLite）、CSV 导出
- V1.2：配额页（5h 窗口 + Codex rate_limits 透传）
- V2：CI 三平台发布、自动更新、winget/brew、官方用量 API 可选增强

## 六、非目标（明确不做）

- 订阅制聊天 App 的对话内容 tokenizer 重算估算（±10-20% 误差、工程重、收益低）
- 代理/网关拦截路线（用户配置门槛高）
- 账号体系 / 云同步（架构预留事件流上报接口即可）
