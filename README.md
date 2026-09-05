<div align="center">

# TokenPulse

**你的 AI Agent，今天烧了多少 token？**

本地优先的 AI Agent 消耗监控 · 常驻托盘 · 零配置

[![下载](https://img.shields.io/badge/%E4%B8%8B%E8%BD%BD-Releases-blue)](https://github.com/Alan-Houxj/tokenpulse/releases)
[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows-informational)](#下载安装)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

</div>

---

## 为什么需要 TokenPulse

同时用 Claude Code、Codex、ZCode 好几个 Agent 干活，每个工具的消耗各记各的账——今天总共烧了多少、哪个项目最费、这个月估算成本多少、**现在还有哪些 Agent 在跑**，谁也不告诉你。

TokenPulse 把它们统统读出来，放进一个仪表盘。

## 核心功能

| 模块 | 你能做什么 |
|---|---|
| **总览** | 任意日期范围的 token 与成本，按 Agent / 模型拆分，一眼看清花在哪 |
| **趋势** | 分模型堆叠柱状图，拖拽窗口聚焦任意时段 |
| **会话** | 每个会话的明细（项目、模型、成本），Agent / 模型 / 日期三重筛选 |
| **活动看板** | 此刻谁在跑、在干什么（思考中 / 调用工具 / 等待模型）、当前任务烧了多少 token——任务管理器 for Agents |
| **成本估算** | 四类 token 分别计价，价格表可改可停用，支持自建模型档，改价自动重算全部历史 |
| **托盘常驻** | 图标实时显示今日消耗，悬停看分 Agent 小结，关窗不打扰 |

## 下载安装

> **当前版本 v0.1 仅提供 Windows 安装包**，代码跨平台，macOS / Linux 在计划中。

1. 进入 [Releases 下载页](https://github.com/Alan-Houxj/tokenpulse/releases)
2. 展开 Assets，选择：
   - **`TokenPulse Setup.exe`** — 安装版（推荐，带开始菜单和快捷方式）
   - **`TokenPulse.exe`** — 便携版（免安装，双击即用）
3. 首次运行遇到 Windows SmartScreen 提示时：*更多信息 → 仍要运行*（开源应用未购买代码签名的正常现象）

**装完即用**：不用登录、不用填 API Key、不用选目录——它会自动发现你电脑上装过哪些 Agent 并回填全部历史。数据只存在你本机，没有任何上传。

## 支持的 Agent

| Agent | 支持情况 |
|---|---|
| Claude Code | ✓ 完整（含官方成本字段） |
| Codex | ✓ 完整（新版 + 2026-09 前旧格式） |
| ZCode | ✓ 完整（SQLite 直读，含实时状态） |
| Gemini CLI | ✓ 完整 |
| Qwen Code | ✓ 完整 |

你的 Agent 没在列表里？[提个 issue](https://github.com/Alan-Houxj/tokenpulse/issues) 告诉我们它的数据存在哪。

## 路线图

- [ ] BYOK 聊天客户端（Cherry Studio / ChatBox / Jan / AnythingLLM）
- [ ] 订阅配额页（5 小时 / 周窗口用量与预警）
- [ ] macOS / Linux 构建（CI 流水线）
- [ ] CSV 导出 · 自动更新 · winget / brew 上架

## 参与开发

```bash
git clone https://github.com/Alan-Houxj/tokenpulse.git
cd tokenpulse
npm install
npm test         # 36 个单测
npm start        # 开发模式
npm run package  # 打包
```

## License

[MIT](LICENSE)
