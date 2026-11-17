# Graph Report - zespol-hopla  (2026-11-17)

## Corpus Check
- 13 files · ~75,179 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 77 nodes · 105 edges · 8 communities (6 shown, 2 thin omitted)
- Extraction: 70% EXTRACTED · 30% INFERRED · 0% AMBIGUOUS · INFERRED: 32 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e764227b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- hopla3d.js
- api
- fx
- input
- sys
- manifest.json
- makeHumanoid
- sw.js

## God Nodes (most connected - your core abstractions)
1. `input()` - 10 edges
2. `fx` - 8 edges
3. `canvasTexture()` - 7 edges
4. `tex()` - 7 edges
5. `api` - 6 edges
6. `srgb()` - 5 edges
7. `makeHumanoid()` - 5 edges
8. `particles()` - 5 edges
9. `tickQuality()` - 4 edges
10. `addPostFX()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `glowSprite()` --calls--> `glowTexture()`  [EXTRACTED]
  hopla3d.js → hopla3d.js  _Bridges community 0 → community 6_

## Import Cycles
- None detected.

## Communities (8 total, 2 thin omitted)

### Community 0 - "hopla3d.js"
Cohesion: 0.21
Nodes (10): bibTexture(), canvasTexture(), createSky(), dotTexture(), glowTexture(), panelTexture(), resolvePreset(), rockTexture() (+2 more)

### Community 1 - "api"
Cohesion: 0.17
Nodes (7): addPostFX(), api, createRenderer(), hud(), injectStyle(), setShadowSize(), tickQuality()

### Community 2 - "fx"
Cohesion: 0.20
Nodes (3): createFX(), fx, poseHumanoid()

### Community 3 - "input"
Cohesion: 0.31
Nodes (8): input(), bindTouch(), enableTilt(), onKeyDown(), onTilt(), poll(), press(), readPad()

### Community 5 - "manifest.json"
Cohesion: 0.22
Nodes (8): background_color, display, icons, name, orientation, short_name, start_url, theme_color

### Community 6 - "makeHumanoid"
Cohesion: 0.29
Nodes (6): glowSprite(), makeHumanoid(), particles(), makeDust(), makePool(), srgb()

## Knowledge Gaps
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `particles()` connect `makeHumanoid` to `hopla3d.js`, `sys`?**
  _High betweenness centrality (0.195) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `input()` (e.g. with `hopla3d.js` and `bindTouch()`) actually correct?**
  _`input()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Why does `input()` connect `input` to `hopla3d.js`?**
  _High betweenness centrality (0.187) - this node is a cross-community bridge._
- **Why does `sys` connect `sys` to `makeHumanoid`?**
  _High betweenness centrality (0.170) - this node is a cross-community bridge._