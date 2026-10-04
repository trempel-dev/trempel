// index.ts — the kit's UI components (Trempel tml:type names), registered by createGame next to the
// game's own. Looks come from the skin (createGame({ skin }); default — procedural).
//
//   ui-button        wide button          w h variant size        text, disabled, variant
//   ui-icon-button   round icon button    size icon variant plate icon, disabled
//   ui-toggle        icon pair            size on off variant     checked
//   ui-plate         title plate / pill   w h size role color     text
//   ui-panel         panel                w h variant (dark)      —
//   ui-popup-frame   popup frame + title  w h title-w title-h     title
//   ui-badge         counter badge        size variant            text, count
//   ui-progress      progress bar         w h                     value 0..1
//   ui-slider        segmented slider     w h segments knob action value 0..1
//   ui-stars         result stars         count size gap          value
//   ui-slot          icon slot            size icon mode src      source, frame, state; reveal()
// Every component is centred on its node; params: data-* in the base or tml:* in the heir.

import type { ComponentFactory } from '@trempel/scene';
import type { UIServices } from './base.js';
import { controls } from './controls.js';
import { slot } from './slot.js';
import { values } from './values.js';

export function uiComponents(svc: UIServices): Record<string, ComponentFactory> {
  return { ...controls(svc), ...values(svc), ...slot(svc) };
}

export const UI_COMPONENTS = ['ui-button', 'ui-icon-button', 'ui-toggle', 'ui-plate', 'ui-panel', 'ui-popup-frame', 'ui-badge', 'ui-progress', 'ui-slider', 'ui-stars', 'ui-slot'] as const;

export type { UIServices } from './base.js';
export { UIButton, UIIconButton, UIToggle, UIPlate, UIPanel, UIPopupFrame, UIBadge, iconView } from './controls.js';
export { UIProgress, UISlider, UIStars } from './values.js';
export { UISlot, placeFrame, slotLook, silhouetteFilter, FULL_FRAME, SLOT, type SlotFrame, type SlotState } from './slot.js';
export { ICONS, drawIcon, starPoints, type IconName } from './icons.js';
export { shade, plateGraphics } from './base.js';
