/// <reference types="vite/client" />

import type { JingpanApi } from '../../shared/types'

declare global {
  interface Window {
    jingpan: JingpanApi
  }
}

export {}
