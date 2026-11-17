# Changelog

## 0.1.0

- `createImageEditor`: canvas with pan/zoom/pinch, fit, 1:1, pixel mode with grid; mask tools (brush, eraser, lasso free/polygon, rectangle, invert, clear, undo/redo); region frame with the working resolution; panel built from the generator's caps; presets; candidates; series of states; layers (patches) with before/after and “apply and keep editing”.
- Geometry: `planCrop`, `cropScaled`, `maskScaled`, `pasteBack` (byte-exact outside the mask, inward feather, colour match, alpha `keep` / `result` / `matte`).
- `createHttpGenerator` / `describeHttpGenerator` — plain HTTP adapter contract.
- `exportLayers()` with a neutral manifest; `export()` flattened PNG; exact PNG encoder.
- Zero dependencies (guarded by a test).
