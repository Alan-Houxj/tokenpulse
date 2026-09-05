import type { TokenPulseApi } from './index'

declare global {
  interface Window {
    api: TokenPulseApi
  }
}

export {}
