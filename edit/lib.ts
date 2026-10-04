// lib.ts — the editor page as a library (`@trempel/scene/edit`): a host mounts it over its own
// SceneIO (a desktop shell, a chat tab, a test page). The page markup and styles ship next to it:
// `@trempel/scene/edit/index.html` (the body the editor expects; its script tag is the host's) and
// `@trempel/scene/edit/style.css`.

export { mountEditor, type MountOptions } from './app/ui';
export type { Editor } from './app/editor';
export { sha1, relativeTo, IMAGE_EXT, type SceneIO, type FolderListing, type FileChange } from './io';
