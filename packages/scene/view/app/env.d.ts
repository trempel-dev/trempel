/// <reference types="vite/client" />

declare module 'virtual:trempel-view-module' {
  import type { ViewConfig } from '../api';
  const config: ViewConfig | null;
  export default config;
}
