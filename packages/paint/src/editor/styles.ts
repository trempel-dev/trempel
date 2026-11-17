/**
 * Styles, scoped by the `tp-` prefix and themed by CSS variables on the
 * container (or any ancestor):
 *
 *   --paint-bg, --paint-surface, --paint-fg, --paint-muted, --paint-line,
 *   --paint-accent, --paint-error, --paint-mask, --paint-font, --paint-radius
 */
export const CSS = `
.tp-root{--_bg:var(--paint-bg,#1b1b1f);--_sf:var(--paint-surface,#24242a);--_fg:var(--paint-fg,#e8e8ec);--_mu:var(--paint-muted,#9a9aa6);--_ln:var(--paint-line,#3a3a44);--_ac:var(--paint-accent,#6aa8ff);--_er:var(--paint-error,#ff6b6b);--_r:var(--paint-radius,6px);
display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--_bg);color:var(--_fg);font:13px/1.35 var(--paint-font,system-ui,sans-serif);outline:none;user-select:none}
.tp-root *{box-sizing:border-box}
.tp-bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--_ln);background:var(--_sf)}
.tp-sep{width:1px;height:20px;background:var(--_ln);margin:0 4px}
.tp-btn{appearance:none;border:1px solid var(--_ln);background:transparent;color:var(--_fg);border-radius:var(--_r);padding:3px 8px;font:inherit;cursor:pointer;white-space:nowrap}
.tp-btn:hover:not(:disabled){border-color:var(--_ac)}
.tp-btn:disabled{opacity:.45;cursor:default}
.tp-btn[aria-pressed=true]{background:var(--_ac);border-color:var(--_ac);color:#fff}
.tp-btn.tp-primary{background:var(--_ac);border-color:var(--_ac);color:#fff}
.tp-range{display:flex;align-items:center;gap:4px;color:var(--_mu)}
.tp-range input{width:80px}
.tp-main{display:flex;flex:1;min-height:0}
.tp-stage{position:relative;flex:1;min-width:0;overflow:hidden;background:var(--_bg);touch-action:none}
.tp-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.tp-panel{width:300px;flex-shrink:0;overflow:auto;border-left:1px solid var(--_ln);background:var(--_sf);padding:10px;display:flex;flex-direction:column;gap:10px;user-select:text}
.tp-sec{display:flex;flex-direction:column;gap:6px}
.tp-sec>h4{margin:0;font-size:12px;font-weight:600;color:var(--_mu);text-transform:none}
.tp-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tp-row>label{color:var(--_mu);min-width:78px}
.tp-in{flex:1;min-width:0;background:var(--_bg);color:var(--_fg);border:1px solid var(--_ln);border-radius:var(--_r);padding:4px 6px;font:inherit}
textarea.tp-in{resize:vertical;min-height:52px}
.tp-note{color:var(--_mu);font-size:12px}
.tp-err{color:var(--_er)}
.tp-prog{height:4px;background:var(--_ln);border-radius:2px;overflow:hidden}
.tp-prog>i{display:block;height:100%;width:0;background:var(--_ac);transition:width .2s}
.tp-cands{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.tp-cand{border:2px solid transparent;border-radius:var(--_r);padding:0;background:var(--_bg);cursor:pointer;aspect-ratio:1;overflow:hidden}
.tp-cand[aria-pressed=true]{border-color:var(--_ac)}
.tp-cand img{width:100%;height:100%;object-fit:contain;display:block}
.tp-layers{display:flex;flex-direction:column;gap:2px}
.tp-layer{display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:var(--_r);cursor:pointer}
.tp-layer[aria-selected=true]{background:color-mix(in srgb,var(--_ac) 22%,transparent)}
.tp-layer>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-layer input{flex:1;min-width:0}
.tp-x{appearance:none;border:0;background:transparent;color:var(--_mu);cursor:pointer;padding:0 4px;font:inherit}
.tp-x:hover{color:var(--_fg)}
.tp-preview{max-width:100%;border-radius:var(--_r);display:block}
`

const STYLE_ID = 'trempel-paint-styles'

/** Inject once per document (or shadow root). */
export function injectStyles(root: Node): void {
  const doc = root.ownerDocument ?? (root as Document)
  const host = (root.getRootNode?.() as Document | ShadowRoot | undefined) ?? doc
  const scope = 'getElementById' in host && typeof host.getElementById === 'function' ? host : doc
  if (scope.getElementById?.(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  const target = scope instanceof Document ? scope.head : scope
  target.appendChild(style)
}
