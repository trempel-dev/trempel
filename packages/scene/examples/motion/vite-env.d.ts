/// <reference types="vite/client" />

// Raw string imports for the scene files (Vite `?raw` suffix).
declare module '*.svg?raw' {
  const content: string;
  export default content;
}
declare module '*.xml?raw' {
  const content: string;
  export default content;
}
