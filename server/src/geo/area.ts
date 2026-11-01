import { cellToLatLng, getResolution, isValidCell } from "h3-js";
import { inServiceArea } from "./service-area.js";

/** Resolution of every area cell: about 5 km2 (decision D3). */
export const AREA_CELL_RESOLUTION = 7;

const CELL_PATTERN = /^[0-9a-f]{15}$/;

/**
 * Checks an area cell.
 * - invalid: not an H3 cell at resolution 7.
 * - outside: a valid cell whose center is outside the service area.
 * - inside: a valid cell inside the service area.
 */
export function classifyAreaCell(cell: string): "invalid" | "outside" | "inside" {
  if (!CELL_PATTERN.test(cell) || !isValidCell(cell)) {
    return "invalid";
  }
  if (getResolution(cell) !== AREA_CELL_RESOLUTION) {
    return "invalid";
  }
  const [latitude, longitude] = cellToLatLng(cell);
  return inServiceArea(latitude, longitude) ? "inside" : "outside";
}
