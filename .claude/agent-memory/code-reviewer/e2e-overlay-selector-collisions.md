---
name: e2e-overlay-selector-collisions
description: Kelpie overlays (hosts/runs pages) sit over a still-mounted workspace; e2e d.click takes the first CSS match, so shared data-* attrs break tests
metadata:
  type: feedback
---

Full-page overlays (`.runs-page`, hosts page) are `position: fixed` and rendered after the workspace, which stays mounted underneath. `scripts/e2e/wd.py` `click(css)` uses the first match, so any new `data-*` attribute on panes/tabs that matches an overlay selector, e.g. `[data-host=alias]`, makes the click hit the hidden pane ("element click intercepted").

**Why:** Found in the 2026-10-22 SSH-panes review: `.pane[data-host]` collided with the hosts list's `[data-host]`.
**How to apply:** When a diff adds data-* attributes to workspace elements, grep `scripts/e2e` and overlay components for the same attribute name.
