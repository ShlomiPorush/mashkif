/**
 * Mashkif's service area: a deliberately coarse outline of the area that
 * Israeli internet providers serve, used only to recognize an area cell that
 * cannot be right (an agent reporting a cell in another country). A
 * resolution 7 cell whose center falls outside is stored as "area unknown".
 *
 * Source and license: drawn by hand for Mashkif from the approximate
 * coordinates of the well-known places named next to each vertex. It
 * contains no third-party map data and is part of the server, under
 * AGPL-3.0. It runs 10 to 20 km out to sea and a few kilometers past the
 * land borders, so coastal and border cells are never lost. It is not a
 * statement about borders and must not be shown as one.
 *
 * Vertices are [longitude, latitude] in WGS 84, clockwise, the ring closed
 * by the first vertex.
 */
export const SERVICE_AREA: readonly (readonly [number, number])[] = [
  [34.95, 33.12], // Sea west of Rosh HaNikra
  [35.1, 33.12], // Rosh HaNikra
  [35.5, 33.13], // Northern border, west of Metula
  [35.53, 33.3], // Metula
  [35.65, 33.36], // Northern Golan
  [35.85, 33.4], // Mount Hermon
  [35.98, 33.25], // Eastern Golan, north
  [35.98, 32.95], // Eastern Golan, south
  [35.82, 32.66], // Yarmouk River
  [35.65, 32.3], // Jordan River, Beit She'an valley
  [35.62, 31.75], // Northern Dead Sea
  [35.6, 31.1], // Southern Dead Sea
  [35.3, 30.5], // Arava
  [35.05, 29.45], // Eilat, east
  [34.85, 29.42], // Taba, south of Eilat
  [34.2, 31.2], // Kerem Shalom
  [34.1, 31.35], // Sea off Rafah
  [34.3, 31.7], // Sea off Ashkelon
  [34.55, 32.1], // Sea off Tel Aviv
  [34.75, 32.6], // Sea off Caesarea
  [34.85, 32.9], // Sea off Haifa
];

/** Whether a point is inside the service area (ray casting; an edge point may go either way). */
export function inServiceArea(latitude: number, longitude: number): boolean {
  let inside = false;
  const ring = SERVICE_AREA;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as readonly [number, number];
    const [xj, yj] = ring[j] as readonly [number, number];
    const crosses =
      yi > latitude !== yj > latitude && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}
