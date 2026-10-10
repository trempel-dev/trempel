// api.ts — the consumer module's API as the viewer resolves `@trempel/scene/view` (the sources of
// src/view.ts — the package entry `@trempel/scene/view` is its build).

export { defineView, FX_DRAG_MIME } from '../src/view.js';
export type { FontSpec, ViewClipArgs, ViewConfig, ViewHookArgs, InspectorFactory, InspectorHost, InspectorPanel, InspectorUi } from '../src/view.js';
