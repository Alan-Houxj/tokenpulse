import type { AgentMeterApi } from './index'

declare global {
  interface Window {
    api: AgentMeterApi
  }
}

export {}
