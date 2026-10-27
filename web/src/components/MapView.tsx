import { type GeoJSONSource, type MapLayerMouseEvent, MapLibreMap, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";
import { cellsToGeoJSON, hoodsToGeoJSON, placesToGeoJSON } from "../map-data.ts";
import type { CityInfo, MapCell, Place, RankedHood } from "../types.ts";

export interface MapViewProps {
  city: CityInfo;
  cells: MapCell[];
  hoods: RankedHood[];
  activeHoodId: string;
  onSelectHood: (hoodId: string) => void;
  /** Spots for the active neighborhood, numbered in list order. */
  places?: Place[];
}

setWorkerUrl(workerUrl);

const STYLE = "https://tiles.openfreemap.org/styles/dark";
const EMPTY = { type: "FeatureCollection" as const, features: [] };
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const NO_PLACES: Place[] = [];

export function MapView({ city, cells, hoods, activeHoodId, onSelectHood, places = NO_PLACES }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const select = useRef(onSelectHood);
  const [ready, setReady] = useState(false);
  select.current = onSelectHood;

  useEffect(() => {
    const [south, west, north, east] = city.bbox;
    const map = new MapLibreMap({
      container: container.current!,
      style: STYLE,
      bounds: [
        [west, south],
        [east, north],
      ],
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.on("load", () => {
      map.addSource("taste", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "taste-heat",
        type: "heatmap",
        source: "taste",
        paint: {
          "heatmap-weight": ["get", "w"],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.9, 14, 2],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 14, 12, 34, 15, 60],
          "heatmap-opacity": 0.85,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(194,65,12,0)",
            0.25,
            "rgba(194,65,12,0.45)",
            0.55,
            "#ea580c",
            0.8,
            "#f59e0b",
            1,
            "#fde68a",
          ],
        },
      });
      map.addSource("spots", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "spot-dots",
        type: "circle",
        source: "spots",
        paint: {
          "circle-radius": 8,
          "circle-color": "#c2410c",
          "circle-stroke-color": "#fde68a",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "spot-numbers",
        type: "symbol",
        source: "spots",
        layout: { "text-field": ["get", "n"], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-allow-overlap": true },
        paint: { "text-color": "#fff7e6" },
      });
      map.addLayer({
        id: "spot-names",
        type: "symbol",
        source: "spots",
        minzoom: 14,
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": "#fde68a", "text-halo-color": "#0e1015", "text-halo-width": 1.2 },
      });
      map.addSource("hoods", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "hood-dots",
        type: "circle",
        source: "hoods",
        paint: {
          "circle-radius": ["case", ["get", "active"], 9, 6],
          "circle-color": ["case", ["get", "active"], "#fde68a", "#e9e4da"],
          "circle-stroke-color": "#0e1015",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "hood-labels",
        type: "symbol",
        source: "hoods",
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-offset": [0, 1.3], "text-anchor": "top" },
        paint: { "text-color": "#e9e4da", "text-halo-color": "#0e1015", "text-halo-width": 1.5 },
      });
      map.on("click", "hood-dots", (event: MapLayerMouseEvent) => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === "string") select.current(id);
      });
      map.on("mouseenter", "hood-dots", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "hood-dots", () => {
        map.getCanvas().style.cursor = "";
      });
      setReady(true);
    });
    return () => {
      setReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, [city]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("taste") as GeoJSONSource).setData(cellsToGeoJSON(cells));
    (map.getSource("hoods") as GeoJSONSource).setData(hoodsToGeoJSON(hoods, activeHoodId));
    (map.getSource("spots") as GeoJSONSource).setData(placesToGeoJSON(places));
  }, [ready, cells, hoods, activeHoodId, places]);

  useEffect(() => {
    const hood = hoods.find((h) => h.id === activeHoodId);
    if (ready && hood) mapRef.current?.flyTo({ center: [hood.lng, hood.lat], zoom: 13, duration: reducedMotion() ? 0 : 1400 });
  }, [ready, hoods, activeHoodId]);

  return <div ref={container} className="map" role="img" aria-label={`Taste heatmap of ${city.name}`} />;
}
