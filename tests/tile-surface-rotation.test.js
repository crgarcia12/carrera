import assert from "node:assert/strict";
import test from "node:test";

import { getTileSurfaceRotationDegrees } from "../src/web/tile-surface-rotation.js";

// Validates: specs/pr.md REQ-006 (render the track from TrackLoaded data)

test("straight tiles swap the backend horizontal and vertical orientations for rendering", () => {
  assert.equal(getTileSurfaceRotationDegrees("straight", 0), 90);
  assert.equal(getTileSurfaceRotationDegrees("straight", 90), 0);
});

test("curve tiles rotate into the corner orientation used by Dusty Fields", () => {
  assert.equal(getTileSurfaceRotationDegrees("curve", 0), 270);
  assert.equal(getTileSurfaceRotationDegrees("curve", 90), 180);
  assert.equal(getTileSurfaceRotationDegrees("curve", 180), 90);
  assert.equal(getTileSurfaceRotationDegrees("curve", 270), 0);
});
