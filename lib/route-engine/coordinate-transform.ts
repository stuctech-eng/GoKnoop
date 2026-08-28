import proj4 from "proj4";

/**
 * Officiële, gepubliceerde EPSG:28992 (Amersfoort / RD New) definitie
 * (bron: epsg.io) -- bewust GEEN handmatig getypte polynoom-benadering.
 * Een verkeerd onthouden coëfficiënt zou stille, moeilijk te detecteren
 * locatiefouten opleveren; proj4 met de gepubliceerde definitie is verifieerbaar.
 */
const RD_NEW =
  "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs";
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

export function wgs84ToRd(lat: number, lon: number): { x: number; y: number } {
  const [x, y] = proj4(WGS84, RD_NEW, [lon, lat]);
  return { x, y };
}

export function rdToWgs84(x: number, y: number): { lat: number; lon: number } {
  const [lon, lat] = proj4(RD_NEW, WGS84, [x, y]);
  return { lat, lon };
}
