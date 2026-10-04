/// <reference types="vite/client" />

declare module 'virtual:trempel-view-module' {
  import type { ViewConfig } from '../../view/api';
  const config: ViewConfig | null;
  export default config;
}
