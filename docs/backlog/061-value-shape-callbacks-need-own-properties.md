---
summary: >
  The callbacks waiting on a shape named by `[package, name]` (value-shape links and the deferred
  tighten-only comparison) run only when that shape has decorated properties of its own: a value
  shape with none never connects the links waiting on it, and their comparison never runs.
packages: [core]
---

# 061 — Value-shape callbacks run only for shapes with their own properties

Source: CN plan 070, step K3 (report 044), from the independent review.

## Problem

`applyLinkedShape` (`src/utils/Package.ts`) runs the node callbacks a shape's id collected
(`getAndClearCallbacks`) inside `if (constructor['shapeCallbacks'])`, so only when the class has
decorated properties. A shape without any, named by `[package, name]` before it registers, never
fires them: the waiting properties keep `valueShape` unset by the callback (the id set at
decoration stands), and the deferred tighten-only value-shape comparison is skipped, so a widening
there is not refused.

## First questions

- Move the node-callback run out of the `shapeCallbacks` branch (and confirm nothing depends on the
  current order).
- A test: a property-less value shape registered after an override that widens to it throws.
