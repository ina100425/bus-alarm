import type { TransitLegSlice } from "@/lib/transit-path";
import { buildRouteStorageKey } from "@/lib/transit-path";

const NICKNAME_KEY = "bus_alarm_nickname";
const ALERT_THRESHOLDS_KEY = "bus_alarm_alert_thresholds_min";
const ROUTE_FAVORITES_KEY = "bus_alarm_route_favorites_v1";
const ROUTE_ALERT_ON_KEY = "bus_alarm_route_alert_on_v1";

const DEFAULT_ALERT_THRESHOLDS = [60, 30, 15, 10, 5] as const;

export type RouteFavoriteEntry = {
  key: string;
  origin: string;
  destination: string;
  label: string;
  savedAt: string;
};

function readJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getNickname(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(NICKNAME_KEY)?.trim() ?? "";
}

export function setNickname(value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NICKNAME_KEY, value.trim());
}

export function getAlertThresholdsMinutes(): number[] {
  if (typeof window === "undefined") return [...DEFAULT_ALERT_THRESHOLDS];
  const parsed = readJson<number[] | null>(
    window.localStorage.getItem(ALERT_THRESHOLDS_KEY),
    null,
  );
  if (!Array.isArray(parsed) || parsed.length === 0) return [...DEFAULT_ALERT_THRESHOLDS];
  const cleaned = parsed
    .map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null))
    .filter((n): n is number => n != null && n > 0);
  return cleaned.length ? [...new Set(cleaned)].sort((a, b) => b - a) : [...DEFAULT_ALERT_THRESHOLDS];
}

export function setAlertThresholdsMinutes(minutes: number[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ALERT_THRESHOLDS_KEY, JSON.stringify(minutes));
}

export function getRouteFavorites(): RouteFavoriteEntry[] {
  if (typeof window === "undefined") return [];
  const raw = readJson<unknown>(window.localStorage.getItem(ROUTE_FAVORITES_KEY), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is RouteFavoriteEntry =>
      typeof x === "object" &&
      x !== null &&
      typeof (x as RouteFavoriteEntry).key === "string" &&
      typeof (x as RouteFavoriteEntry).origin === "string" &&
      typeof (x as RouteFavoriteEntry).destination === "string",
  );
}

export function setRouteFavorites(entries: RouteFavoriteEntry[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ROUTE_FAVORITES_KEY, JSON.stringify(entries));
}

export function toggleRouteFavorite(params: {
  origin: string;
  destination: string;
  subPath: TransitLegSlice[];
  label: string;
}): boolean {
  const key = buildRouteStorageKey(params.origin, params.destination, params.subPath);
  const list = getRouteFavorites();
  const idx = list.findIndex((e) => e.key === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    setRouteFavorites(list);
    return false;
  }
  list.push({
    key,
    origin: params.origin.trim(),
    destination: params.destination.trim(),
    label: params.label.trim() || `${params.origin} → ${params.destination}`,
    savedAt: new Date().toISOString(),
  });
  setRouteFavorites(list);
  return true;
}

export function isRouteFavorite(
  origin: string,
  destination: string,
  subPath: TransitLegSlice[],
): boolean {
  const key = buildRouteStorageKey(origin, destination, subPath);
  return getRouteFavorites().some((e) => e.key === key);
}

export function getRouteAlertOnMap(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  return readJson<Record<string, boolean>>(
    window.localStorage.getItem(ROUTE_ALERT_ON_KEY),
    {},
  );
}

export function setRouteAlertOnMap(map: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ROUTE_ALERT_ON_KEY, JSON.stringify(map));
}

export function setRouteAlertOn(key: string, on: boolean): void {
  if (typeof window === "undefined") return;
  const next = { ...getRouteAlertOnMap() };
  if (on) next[key] = true;
  else delete next[key];
  window.localStorage.setItem(ROUTE_ALERT_ON_KEY, JSON.stringify(next));
}

export function isRouteAlertOn(
  origin: string,
  destination: string,
  subPath: TransitLegSlice[],
): boolean {
  const key = buildRouteStorageKey(origin, destination, subPath);
  return getRouteAlertOnMap()[key] === true;
}

export function listActiveAlertRouteKeys(): string[] {
  const m = getRouteAlertOnMap();
  return Object.entries(m)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}
