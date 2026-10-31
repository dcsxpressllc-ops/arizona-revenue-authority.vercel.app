/**
 * Natural Earth I projection for the landing world map, ported from
 * d3-geo-projection's polynomial so we don't pull in d3-geo for a static map.
 *
 * createProjection fits the globe into a viewBox and returns project(lon, lat)
 * -> [x, y]. Countries and city dots share the instance so they align. The
 * fit is computed from a lon/lat grid, not the loaded features, so dots can be
 * placed before the geometry arrives.
 */

/** Forward transform; inputs in degrees. */
function naturalEarth1Raw(lonDeg: number, latDeg: number): [number, number] {
  const l = (lonDeg * Math.PI) / 180;
  const p = (latDeg * Math.PI) / 180;
  const p2 = p * p;
  const p4 = p2 * p2;
  const x =
    l *
    (0.8707 -
      0.131979 * p2 +
      p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
  const y =
    p *
    (1.007226 +
      p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
  return [x, y];
}

export interface Projection {
  /** Degrees -> viewBox pixels. */
  project: (lon: number, lat: number) => [number, number];
  width: number;
  height: number;
}

export function createProjection(
  width: number,
  height: number,
  pad = 8,
): Projection {
  // Bounds from a coarse grid; the extremes sit on the frame and poles, so 5 degrees is plenty.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let lon = -180; lon <= 180; lon += 5) {
    for (let lat = -90; lat <= 90; lat += 5) {
      const [rx, ry] = naturalEarth1Raw(lon, lat);
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
  }

  const s = Math.min(
    (width - 2 * pad) / (maxX - minX),
    (height - 2 * pad) / (maxY - minY),
  );
  const drawnW = (maxX - minX) * s;
  const drawnH = (maxY - minY) * s;
  const tx = pad + (width - 2 * pad - drawnW) / 2;
  const ty = pad + (height - 2 * pad - drawnH) / 2;

  const project = (lon: number, lat: number): [number, number] => {
    const [rx, ry] = naturalEarth1Raw(lon, lat);
    // Raw +y is north, SVG +y is down.
    return [tx + (rx - minX) * s, ty + (maxY - ry) * s];
  };

  return { project, width, height };
}

/** SVG path `d` for a Polygon/MultiPolygon; rings become closed subpaths. */
export function geometryToPath(
  geometry: { type: string; coordinates: unknown },
  project: (lon: number, lat: number) => [number, number],
): string {
  const ringToPath = (ring: number[][]): string => {
    if (ring.length === 0) return "";
    let d = "";
    for (let i = 0; i < ring.length; i++) {
      const [lon, lat] = ring[i];
      const [x, y] = project(lon, lat);
      d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return d + "Z";
  };

  if (geometry.type === "Polygon") {
    return (geometry.coordinates as number[][][]).map(ringToPath).join("");
  }
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as number[][][][])
      .map((poly) => poly.map(ringToPath).join(""))
      .join("");
  }
  return "";
}
