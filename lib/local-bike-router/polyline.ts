/**
 * Decodeert een Google-encoded polyline-string naar een lijst coördinaten.
 *
 * BELANGRIJK: Valhalla gebruikt 6 decimalen precisie, NIET de gangbare 5
 * decimalen uit Google's oorspronkelijke algoritme (bevestigd via de
 * officiële Valhalla-documentatie, 8-9-2026: "It is very important that you
 * use six digits, rather than five... With fewer than six digits, your
 * locations are incorrectly placed (commonly, in the middle of an ocean)").
 * Vandaar `precision` als parameter i.p.v. een vast getal -- voorkomt dat
 * dit bestand per ongeluk voor een andere polyline-bron (5 decimalen)
 * hergebruikt wordt met de verkeerde aanname.
 */
export function decodePolyline(encoded: string, precision: 5 | 6): { lat: number; lon: number }[] {
  const factor = Math.pow(10, precision);
  const coordinates: { lat: number; lon: number }[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLon = result & 1 ? ~(result >> 1) : result >> 1;
    lon += deltaLon;

    coordinates.push({ lat: lat / factor, lon: lon / factor });
  }

  return coordinates;
}
