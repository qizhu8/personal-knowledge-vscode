// @ts-check
import { OPERATIONS } from "./protocol.mjs";

// This static same-origin module is the only integration configuration surface.
// Host owners may replace mappings with registered canonical operation IDs, not arbitrary URLs.
export const hostConfig = Object.freeze({ operations: OPERATIONS });
