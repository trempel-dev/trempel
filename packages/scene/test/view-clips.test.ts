// 2.2: the viewer / editor clip player tells the host the time shown and the markers crossed
// (the module's onClipTime: effects fired by `fx:<name>@<node>` catch up to the frame).
import { describe, expect, it } from 'vitest';
import { mountScene, parse } from '../src/core';
import { ClipPlayer, compileSceneClips, type ClipTime } from '../view/clips';
import { createMockBackend } from './helpers/mockBackend';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="star"/></svg>';
const MD = `# $clip shine
$duration: 2

## $track star
| t | alpha |
|---|---|
| 0 | 0 |
| 2 | 1 |

## $events
| t | event |
|---|---|
| 0.5 | fx:sparkle@star |
| 1.5 | done |
`;

describe('view clips: onTime (2.2)', () => {
  it('a seek and every played frame report the time and the markers crossed in the cycle', () => {
    const backend = createMockBackend();
    const scene = mountScene(SVG, { backend, context: {} });
    const { clips, errors } = compileSceneClips({ 'anim/x.md': MD }, parse(SVG));
    expect(errors).toEqual([]);
    const seen: ClipTime[] = [];
    const p = new ClipPlayer(scene, backend, { onTime: (x) => seen.push(x) });
    p.loop = false;
    p.select(clips[0]);
    expect(seen.at(-1)).toEqual({ clip: 'shine', t: 0, markers: [] });
    p.seek(1);
    expect(seen.at(-1)!.markers.map((m) => m.name)).toEqual(['fx:sparkle@star']);
    p.play();
    p.advance(700);
    expect(seen.at(-1)!.t).toBeCloseTo(1.7, 6);
    expect(seen.at(-1)!.markers.map((m) => [m.t, m.name])).toEqual([[0.5, 'fx:sparkle@star'], [1.5, 'done']]);
    // looping: the next cycle starts with no markers crossed
    p.loop = true;
    p.seek(0.2);
    p.play();
    p.advance(2000);
    expect(seen.at(-1)!.t).toBeCloseTo(0.2, 6);
    expect(seen.at(-1)!.markers).toEqual([]);
    // without onTime nothing is reported (and nothing breaks)
    const q = new ClipPlayer(scene, backend);
    q.select(clips[0]);
    q.seek(1);
  });
});
