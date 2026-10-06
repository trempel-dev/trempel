// node/ — the Node side of the package (`@trempel/scene/node`): the project file and its
// collections on disk, flatten into a vanilla SVG file, picture sizes.

export { findProjectRoot, findPackageDir, loadProject, isInside, collectionPath, heirsOf } from './project.js';
export type { Project } from './project.js';
export { flattenFile, sceneStemOf } from './flatten.js';
export type { FlattenFileOptions, FlattenFileResult } from './flatten.js';
export { imageSize, imageSizeOf, mimeOf } from './imagesize.js';
export type { PixelSize } from './imagesize.js';
