# TokenPulse

> 本地优先的 AI Agent token 消耗监控 — 消耗看得清 · 成本可控 · 实时感知

一个开源的跨平台托盘应用：把 Claude Code、Codex、Gemini CLI、Qwen Code、ZCode 等 AI 编程 Agent 散落在本地的用量记录，统一到一个实时仪表盘。

> **当前版本 v0.1 仅提供 Windows 安装包**（`TokenPulse Setup x.x.x.exe`，也附带免安装便携版 exe）。代码本身跨平台（数据路径按 macOS/Linux 约定编写），macOS / Linux 构建在 CI 计划中。

**零配置**：下载 → 双击 → 看到自己的用量。不登录、不填 API Key、不需要管理员权限、数据不出本机。

## 它解决什么问题

同时用多个 AI Agent 的开发者，token 消耗散落在各工具自己的记录里，谁也不告诉你今天烧了多少、成本多少、现在还有哪些 Agent 在跑。TokenPulse 读取它们本来就写在磁盘上的用量文件（这些文件是 Agent 用来恢复会话的，我们**只读不改不上传**），统一聚合呈现。

## 功能

- **总览**：任意日期范围内的 token 与成本汇总，按 Agent、按模型拆分
- **趋势**：分模型堆叠柱状图（补零完整时间轴 + 底部 Brush 拖拽窗口），24 小时/自定义粒度自动切换
- **会话**：每会话明细（模型、token 构成、项目、≈成本），支持 Agent / 模型 / 日期三重筛选
- **活动看板**：Agent 实时可观测性面板——一个 Agent 一张卡片（多会话折叠），实时状态推断（思考中 / 等待模型 / 调用工具 / 空闲 / 异常）、动态动作描述、当前任务累计 token 与时长平滑走表、异常标记（挂起请求 / 卡死工具 / 报错）、点击展开请求流水、右键定位日志文件
- **数据源**：四态探测（已检测到 / 未安装 / 为空 / 格式不识别），自定义路径即时校验
- **成本引擎**：四类 token（input / output / cache 读 / cache 写）分别计价，2026-09 价格快照，内置档可改可停用、支持自建模型档，价格变更自动重算全部历史
- **日期选择**：双日历面板（时间段 / 单日模式、悬停预高亮、快捷档、禁选未来）
- **托盘**：图标显示今日总量档位，tooltip 分 Agent 小结，双击开窗，关窗常驻

## 支持的 Agent

| Agent | 数据源 | 说明 |
|---|---|---|
| Claude Code | `~/.claude/projects/**.jsonl` | 含官方 costUSD；Qwen Code 同构复用 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 新版逐响应格式 + 旧版累计格式（累计指纹去重）均已支持 |
| Gemini CLI | `~/.gemini/tmp/` | chunk 文件 |
| Qwen Code | `~/.qwen` | gemini-cli fork，同构解析 |
| ZCode | `~/.zcode/cli/db/db.sqlite` | model_usage 表，只读连接（签名合并 WAL 保证实时增量） |

## 快速开始（开发）

```bash
# 需要 Node.js 20+
npm install
npm test        # 36 个单测（适配器/存储/引擎/活动看板状态机）
npm start       # 开发模式运行
npm run package # 打包 Windows Portable + NSIS 安装版（产物在 dist/）
```

## 工作机制

```
采集层 SourceAdapters（插件式，每 Agent 一个）
  发现文件 → 与上次签名(mtime+size，SQLite 含 WAL)比对 → 从 offset 位点增量读取
        ↓  统一 UsageEvent 事件流（跨增量段保持解析状态）
聚合层  SQLite 索引库（%APPDATA%/AgentMeter，幂等键去重）
  成本引擎（内置价格表 + 用户覆盖/停用 × 四类 token，价格版本化重算）
        ↓  IPC + 5s tick 广播
展示层  Electron 无边框窗口（TokenPulse 顶栏 + 六页）+ 托盘
```

- **准实时**：调度器每 5 秒比对数据文件签名，内容未变零读取；变化才增量读新行
- **幂等**：事件以 `agent:session:request` 为主键，重复采集 / 回填 / 重扫安全
- **资源**：CPU/磁盘近零；Electron 常驻内存 ~100MB 量级

## 成本口径的诚实说明

- UI 所有成本数字标注 **"API 等价估算"**：按公开 API 价格表计算的等价成本，**不是订阅账单**
- cache read 通常占 90%+ token 量但价格约为 input 的 1/10，四类分别计价，绝不合并
- 内置价格表是快照（含少量推断项，标注于代码注释），设置页可改可停用可自建档

## 路线图

- **V1.1**：BYOK 聊天客户端（Cherry Studio / ChatBox / Jan / AnythingLLM）、CSV 导出
- **V1.2**：配额页（5h/周窗口 + Codex 官方 rate_limits 透传）
- **V2**：GitHub Actions 三平台发布流水线、自动更新、winget / brew 上架

## 项目结构

```
src/core/     引擎（零 Electron 依赖，可独立测试）
  adapters/     claude-code codex gemini-like qwen zcode registry
  store/        SQLite 仓储（events + file_positions + 聚合查询 + 迁移）
  engine/       cost scheduler detect live
src/main/     Electron 主进程（托盘、无边框窗口、IPC、装配）
src/renderer/ React 窗口（总览/趋势/会话/活动看板/数据源/设置 + 首启引导）
tests/        36 个单测（含各 Agent 格式 fixtures 与状态机用例）
build/        图标生成（零依赖 PNG 编码）
```

## License

MIT
