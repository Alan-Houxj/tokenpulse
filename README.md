# AgentMeter

> 本地优先的 AI Agent token 消耗监控 — 消耗看得清 · 成本可控 · 实时感知

一个开源的 Windows/macOS/Linux 托盘常驻应用：把 Claude Code、Codex、Gemini CLI、Qwen Code、ZCode 等 AI 编程 Agent 散落在本地的用量记录，统一到一个实时仪表盘。

**零配置**：下载 → 双击 → 看到自己的用量。不登录、不填 API Key、不需要管理员权限、数据不出本机。

## 它解决什么问题

同时用多个 AI Agent 的开发者，token 消耗散落在各工具自己的记录里，谁也不告诉你今天烧了多少、成本多少、现在还有哪些 Agent 在跑。AgentMeter 读取它们本来就写在磁盘上的用量文件（这些文件是 Agent 用来恢复会话的，我们**只读不改不上传**），统一聚合呈现。

## 功能

- **总览**：今日 / 近 7 天 / 近 30 天 token 与成本，按 Agent、按模型拆分
- **趋势**：24 小时 / 7 天 / 30 天消耗曲线（总量、输入、输出、估算成本）
- **会话**：每会话明细（模型、token 构成、跨度、项目）
- **实时**：任务管理器 for Agents — 正在跑的会话、燃烧速率（tok/min）、采集心跳
- **数据源**：四态探测（已检测到 / 未安装 / 为空 / 格式不识别），自定义路径即时校验
- **成本引擎**：四类 token（input / output / cache 读 / cache 写）分别计价，价格表可覆盖
- **托盘**：图标显示今日总量档位，tooltip 分 Agent 小结，双击开窗，关窗常驻

## 支持的 Agent

| Agent | 数据源 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/projects/**.jsonl` | 含官方 costUSD；Qwen Code 同构复用 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 取每响应增量，规避累计值双计坑 |
| Gemini CLI | `~/.gemini/tmp/` | chunk 文件 |
| Qwen Code | `~/.qwen` | gemini-cli fork，同构解析 |
| ZCode | `~/.zcode/cli/db/db.sqlite` | model_usage 表，只读连接 |

已知边界：2026-09 之前旧版 Codex 会话文件只记录累计值（`token_count`），为避免双计暂不解析，规划在 V1.1 用社区共识的"last 增量 + 去重"算法支持。

## 快速开始（开发）

```bash
# 需要 Node.js 20+
npm install
npm test        # 21 个单测（适配器/存储/引擎）
npm start       # 开发模式运行
npm run package # 打包 Windows Portable + NSIS 安装版（产物在 dist/）
```

## 工作机制

```
采集层 SourceAdapters（插件式，每 Agent 一个）
  发现文件 → 与上次签名(mtime+size)比对 → 从 offset 位点增量读取
        ↓  统一 UsageEvent 事件流
聚合层  SQLite 索引库（%APPDATA%/AgentMeter，幂等键去重）
  成本引擎（内置价格表 + 用户覆盖 × 四类 token）
        ↓  IPC + 5s tick 广播
展示层  Electron 托盘 + React 窗口（六页）
```

- **准实时**：调度器每 5 秒 stat 数据文件，内容未变零读取；变化才增量读新行
- **幂等**：事件以 `agent:session:request` 为主键，重复采集 / 回填安全
- **资源**：CPU/磁盘近零；Electron 常驻内存 ~100MB 量级（同类产品相同量级，这是"点开即有完整图表"的代价，README 坦诚告知）

## 成本口径的诚实说明

- UI 所有成本数字标注 **"≈ API 等价估算"**：按公开 API 价格表计算的等价成本，**不是订阅账单**（订阅制按配额窗口计，无美元成本概念）
- cache read 通常占 90%+ token 量但价格约为 input 的 1/10，四类分别计价，绝不合并
- 内置价格表是快照，设置页可覆盖（应对第三方中转定价）

## 路线图

- **V1.1**：BYOK 聊天客户端（Cherry Studio / ChatBox / Jan / AnythingLLM，社区有真实需求真空）、旧版 Codex 格式支持、CSV 导出
- **V1.2**：配额页（5h/周窗口 + Codex 官方 rate_limits 透传）、托盘点击直达卡片
- **V2**：GitHub Actions 三平台发布流水线、自动更新、winget / brew 上架、可选的官方用量 API 增强模块

## 项目结构

```
src/core/     引擎（零 Electron 依赖，可独立测试）
  adapters/     claude-code codex gemini-like qwen zcode registry
  store/        SQLite 仓储（events + file_positions）
  engine/       cost scheduler detect
src/main/     Electron 主进程（托盘、窗口、IPC、装配）
src/renderer/ React 窗口（总览/趋势/会话/实时/数据源/设置 + 首启引导）
tests/        21 个单测（含各 Agent 格式 fixtures）
build/        图标生成（零依赖 PNG 编码）
```

## License

MIT
