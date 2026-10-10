// gates.ts — what the slot adds to the kit's Playables gates (no Pixi: imported by vite.config).
// The slot's own code has no third-party URLs. pixi-reels (the reels) animates with GSAP — its peer
// dependency, bundled with it — and GSAP ships its license comment and warning messages with these
// URLs: text, never requested. `trempelKit({ libraryUrls: LIBRARY_URLS })`.

export const LIBRARY_URLS = ['https://gsap.com', 'https://gsap.com/standard-license'];
