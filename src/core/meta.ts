/** 应用元信息（主进程/渲染端/测试共用） */
export const appInfo = {
  name: 'agentmeter',
  displayName: 'AgentMeter',
  /** 我们自己的数据落点：%APPDATA%/AgentMeter（Windows）或 ~/Library/Application Support/AgentMeter */
  userDataDirName: 'AgentMeter'
} as const
