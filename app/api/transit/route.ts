import { NextResponse } from "next/server";

type GoogleTransitStopDetails = {
  departureStop?: {
    name?: string;
    location?: { latLng?: { latitude?: number; longitude?: number } };
  };
  arrivalStop?: {
    name?: string;
    location?: { latLng?: { latitude?: number; longitude?: number } };
  };
  /** RFC3339, 탑승 정류장·역 출발 예정 시각 */
  departureTime?: string;
  /** RFC3339, 하차 정류장·역 도착 예정 시각 */
  arrivalTime?: string;
};

type GoogleTransitLine = {
  nameShort?: string;
  name?: string;
  vehicle?: { type?: string };
};

/** 문서 외 확장 필드(intermediateStops 등) 수용 */
type GoogleTransitDetails = {
  stopDetails?: GoogleTransitStopDetails;
  transitLine?: GoogleTransitLine;
  headsign?: string;
  /** 배차 간격(예: "600s") — 간선·광역버스 등에서 시간표 다음 편만 멀리 잡힐 때 보정에 사용 */
  headway?: string | { seconds?: string | number };
  intermediateStops?: { name?: string }[];
};

type GoogleTransitStep = {
  travelMode?: string;
  distanceMeters?: number;
  staticDuration?: string;
  transitDetails?: GoogleTransitDetails;
};

type GoogleLeg = {
  duration?: string;
  distanceMeters?: number;
  steps?: GoogleTransitStep[];
};

type GoogleRoute = {
  duration?: string;
  distanceMeters?: number;
  legs?: GoogleLeg[];
};

type GoogleRoutesResponse = {
  routes?: GoogleRoute[];
  error?: { message?: string };
};

export type TransitSubPath = {
  trafficType: number;
  distance: number;
  sectionTime: number;
  sectionDurationSec: number;
  stationCount?: number;
  lane?: { busNo?: string }[];
  transitHeadsign?: string;
  startName: string;
  startX: number;
  startY: number;
  endName: string;
  endX: number;
  endY: number;
  startID: number;
  endID: number;
  /** Google stopDetails.departureTime (Unix ms) */
  transitDepartureTimeMs?: number;
  /** Google stopDetails.arrivalTime (Unix ms) */
  transitArrivalTimeMs?: number;
  /** Google transitDetails.headway 초(있을 때만) */
  headwaySec?: number;
  /** 응답에 있으면 경유 정류장·역 이름 */
  intermediateStopNames?: string[];
};

type TransitPath = {
  pathType: number;
  info: {
    totalTime: number;
    totalDurationSec: number;
    totalWalk: number;
    firstStartStation: string;
    lastEndStation: string;
    payment?: number;
  };
  subPath: TransitSubPath[];
};

/** Google Routes duration 문자열(예: "3600s") → 초 */
function parseGoogleDurationSeconds(duration: string | undefined): number {
  if (!duration || typeof duration !== "string") return 0;
  const n = parseInt(duration.replace("s", ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Routes API JSON에서 Duration이 "600s" 또는 { seconds: "600" } 형태일 수 있음 */
function parseHeadwaySeconds(value: unknown): number {
  if (typeof value === "string") return parseGoogleDurationSeconds(value);
  if (value && typeof value === "object") {
    const rec = value as { seconds?: string | number };
    const s = rec.seconds;
    const n =
      typeof s === "number"
        ? s
        : typeof s === "string"
          ? parseInt(s, 10)
          : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}

/** RFC3339 → Unix ms */
function parseTimestampMs(iso: string | undefined): number | null {
  if (!iso || typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 버스: 시간표상 탑승지 출발이 한참 뒤로만 오는데 배차 간격이 짧은 경우,
 * 실제로는 곧 다음 편이 올 수 있어 `departureTime`과 `now+headway` 중 이른 쪽을 탑승 기준으로 사용.
 */
function adjustBusBoardingDepartureMs(
  depMs: number,
  requestNowMs: number,
  headwaySec: number,
): number {
  if (!Number.isFinite(headwaySec) || headwaySec <= 0 || headwaySec > 45 * 60) {
    return depMs;
  }
  const deltaMs = depMs - requestNowMs;
  const headwayMs = headwaySec * 1000;
  if (deltaMs <= headwayMs * 2.5) {
    return depMs;
  }
  return Math.min(depMs, requestNowMs + headwayMs);
}

function travelTypeFromGoogleStep(
  step: GoogleTransitStep,
  lineName: string,
  lineLongName: string,
): number {
  const mode = (step.travelMode ?? "").toUpperCase();
  if (mode === "WALK") return 3;
  if (mode !== "TRANSIT") return 3;

  const vtRaw = step.transitDetails?.transitLine?.vehicle?.type;
  const vehicleType = String(vtRaw ?? "").toUpperCase();
  if (vehicleType === "BUS" || vehicleType.includes("BUS")) return 2;
  if (
    vehicleType === "SUBWAY" ||
    vehicleType === "HEAVY_RAIL" ||
    vehicleType === "COMMUTER_TRAIN" ||
    vehicleType === "LIGHT_RAIL" ||
    vehicleType === "MONORAIL" ||
    vehicleType === "TRAIN" ||
    vehicleType.includes("SUBWAY") ||
    vehicleType.includes("HEAVY_RAIL") ||
    vehicleType.includes("COMMUTER_TRAIN") ||
    vehicleType.includes("LIGHT_RAIL") ||
    vehicleType.includes("TRAM")
  ) {
    return 1;
  }

  const short = lineName.trim();
  const long = lineLongName.trim();
  const combined = `${short} ${long}`.trim();
  if (
    combined &&
    /(호선|전철|신분당|경의|분당|공항철도|김포|우이|신림|용인|에버라인|의정부|GTX)/i.test(
      combined,
    )
  ) {
    return 1;
  }
  if (short && (short.includes("호선") || short.includes("신분당"))) return 1;

  if (short && (/^\d+$/.test(short) || /^M/i.test(short))) return 2;
  return 2;
}

function getStopLatLng(stop?: { location?: { latLng?: { latitude?: number; longitude?: number } } }) {
  const ll = stop?.location?.latLng;
  if (!ll) return null;
  const lat = ll.latitude;
  const lng = ll.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { latitude: lat, longitude: lng };
}

function normalizeGoogleRoutes(
  data: GoogleRoutesResponse,
  requestNowMs: number,
): { result: { searchType: number; path: TransitPath[] } } {
  const routes = data.routes ?? [];
  const normalizedPath: TransitPath[] = [];

  for (const route of routes) {
    const legs = route.legs ?? [];
    const allSteps = legs.flatMap((leg) => leg.steps ?? []);

    const routeTotalSec = parseGoogleDurationSeconds(route.duration);
    const totalTimeMin = Math.max(1, Math.round(routeTotalSec / 60));

    const subPath: TransitSubPath[] = [];
    for (let idx = 0; idx < allSteps.length; idx += 1) {
      const step = allSteps[idx];
      const transit = step.transitDetails;
      const line = transit?.transitLine;
      let lineName = (line?.nameShort?.trim() ?? "").trim();
      const lineLongName = (line?.name?.trim() ?? "").trim();
      if (!lineName && lineLongName) lineName = lineLongName;

      const sd = transit?.stopDetails;
      const departure = sd?.departureStop;
      const arrival = sd?.arrivalStop;

      const startName = departure?.name?.trim() || "";
      const endName = arrival?.name?.trim() || "";

      const ll = getStopLatLng(departure);
      const startLat = ll?.latitude;
      const startLng = ll?.longitude;
      const llArr = getStopLatLng(arrival);
      const endLat = llArr?.latitude;
      const endLng = llArr?.longitude;

      const trafficType = travelTypeFromGoogleStep(step, lineName, lineLongName);
      if (trafficType === 1 && !lineName.trim()) {
        lineName = (lineLongName || "지하철").trim();
      }

      const stepSec = parseGoogleDurationSeconds(step.staticDuration);
      const sectionDurationSec = Math.max(1, stepSec);
      const sectionTimeMin = Math.max(1, Math.round(stepSec / 60));

      const depMsRaw = parseTimestampMs(sd?.departureTime);
      const arrMs = parseTimestampMs(sd?.arrivalTime);
      const headwaySec = parseHeadwaySeconds(transit?.headway);

      let depMs = depMsRaw;
      if (trafficType === 2 && depMs != null) {
        if (headwaySec > 0) {
          depMs = adjustBusBoardingDepartureMs(depMs, requestNowMs, headwaySec);
        }
      }

      const intermediateRaw = transit?.intermediateStops;
      const intermediateStopNames =
        Array.isArray(intermediateRaw) && intermediateRaw.length > 0
          ? intermediateRaw.map((s) => (s?.name ?? "").trim()).filter(Boolean)
          : undefined;

      const sub: TransitSubPath = {
        trafficType,
        distance: Math.max(0, Number(step.distanceMeters ?? 0)),
        sectionTime: sectionTimeMin,
        sectionDurationSec,
        stationCount: (transit as { stopCount?: number })?.stopCount,
        lane: lineName ? [{ busNo: lineName }] : undefined,
        transitHeadsign: transit?.headsign?.trim() || undefined,
        startName,
        startX: startLng ?? 0,
        startY: startLat ?? 0,
        endName,
        endX: endLng ?? 0,
        endY: endLat ?? 0,
        startID: idx + 1,
        endID: idx + 1001,
        transitDepartureTimeMs: depMs ?? undefined,
        transitArrivalTimeMs: arrMs ?? undefined,
        headwaySec: headwaySec > 0 ? headwaySec : undefined,
        intermediateStopNames,
      };

      subPath.push(sub);
    }

    const walkDistance = subPath
      .filter((s) => s.trafficType === 3)
      .reduce((sum, s) => sum + s.distance, 0);

    const hasBus = subPath.some((s) => s.trafficType === 2);
    const hasSubway = subPath.some((s) => s.trafficType === 1);
    const pathType = hasBus && hasSubway ? 3 : hasBus ? 2 : 1;

    const first = subPath[0];
    const last = subPath[subPath.length - 1];

    normalizedPath.push({
      pathType,
      info: {
        totalTime: totalTimeMin,
        totalDurationSec: Math.max(1, routeTotalSec),
        totalWalk: Math.round(walkDistance),
        firstStartStation: first?.startName ?? "",
        lastEndStation: last?.endName ?? "",
        payment: undefined,
      },
      subPath,
    });
  }

  return { result: { searchType: 0, path: normalizedPath } };
}

function routeStructuralKey(route: GoogleRoute): string {
  const parts: string[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const mode = (step.travelMode ?? "").toUpperCase();
      const short = (step.transitDetails?.transitLine?.nameShort ?? "").trim();
      const nm = (step.transitDetails?.transitLine?.name ?? "").trim();
      const veh = String(step.transitDetails?.transitLine?.vehicle?.type ?? "");
      parts.push(`${mode}|${short}|${nm}|${veh}|${step.distanceMeters ?? 0}|${step.staticDuration ?? ""}`);
    }
  }
  return parts.join("§");
}

function mergeUniqueGoogleRoutes(lists: GoogleRoute[][]): GoogleRoute[] {
  const seen = new Set<string>();
  const out: GoogleRoute[] = [];
  for (const list of lists) {
    for (const r of list) {
      const k = routeStructuralKey(r);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

function routeTransitDiversityScore(route: GoogleRoute): number {
  let subway = 0;
  let bus = 0;
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      if ((step.travelMode ?? "").toUpperCase() !== "TRANSIT") continue;
      const v = String(step.transitDetails?.transitLine?.vehicle?.type ?? "").toUpperCase();
      const nm = `${step.transitDetails?.transitLine?.nameShort ?? ""} ${step.transitDetails?.transitLine?.name ?? ""}`;
      if (v.includes("BUS")) bus += 1;
      else if (/(SUBWAY|RAIL|TRAIN|LIGHT|MONORAIL|COMMUTER|HEAVY|TRAM)/i.test(v)) subway += 1;
      else if (/(호선|전철|신분당)/i.test(nm)) subway += 1;
      else bus += 1;
    }
  }
  if (subway > 0 && bus > 0) return 4;
  if (subway > 0) return 3;
  if (bus > 0) return 2;
  return 1;
}

function routeHasSubway(route: GoogleRoute): boolean {
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      if ((step.travelMode ?? "").toUpperCase() !== "TRANSIT") continue;
      const v = String(step.transitDetails?.transitLine?.vehicle?.type ?? "").toUpperCase();
      const nm = `${step.transitDetails?.transitLine?.nameShort ?? ""} ${step.transitDetails?.transitLine?.name ?? ""}`;
      if (/(SUBWAY|RAIL|TRAIN|LIGHT|MONORAIL|COMMUTER|HEAVY|TRAM)/i.test(v)) return true;
      if (/(호선|전철|신분당|경의|분당|공항철도|GTX)/i.test(nm)) return true;
    }
  }
  return false;
}

export async function GET(req: Request) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: { message: "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY 미설정" } }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const sx = Number(searchParams.get("sx"));
  const sy = Number(searchParams.get("sy"));
  const ex = Number(searchParams.get("ex"));
  const ey = Number(searchParams.get("ey"));

  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(ex) || !Number.isFinite(ey)) {
    return NextResponse.json(
      { error: { message: "sx, sy, ex, ey 쿼리가 모두 필요합니다" } },
      { status: 400 },
    );
  }

  const fieldMask =
    "routes.duration,routes.distanceMeters,routes.legs.duration,routes.legs.distanceMeters," +
    "routes.legs.steps.travelMode,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration," +
    "routes.legs.steps.transitDetails,routes.legs.steps.transitDetails.headsign," +
    "routes.legs.steps.transitDetails.stopDetails,routes.legs.steps.transitDetails.stopDetails.departureStop," +
    "routes.legs.steps.transitDetails.stopDetails.arrivalStop," +
    "routes.legs.steps.transitDetails.stopDetails.departureTime,routes.legs.steps.transitDetails.stopDetails.arrivalTime," +
    "routes.legs.steps.transitDetails.transitLine,routes.legs.steps.transitDetails.transitLine.nameShort," +
    "routes.legs.steps.transitDetails.transitLine.name,routes.legs.steps.transitDetails.transitLine.vehicle," +
    "routes.legs.steps.transitDetails.stopCount,routes.legs.steps.transitDetails.headway";

  const departureTimeIso = new Date().toISOString();

  const baseBody = {
    origin: { location: { latLng: { latitude: sy, longitude: sx } } },
    destination: { location: { latLng: { latitude: ey, longitude: ex } } },
    travelMode: "TRANSIT" as const,
    computeAlternativeRoutes: true,
    languageCode: "ko",
    departureTime: departureTimeIso,
  };

  async function postComputeRoutes(
    mapsKey: string,
    extra?: Record<string, unknown>,
  ): Promise<GoogleRoutesResponse> {
    const body = extra ? { ...baseBody, ...extra } : baseBody;
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": mapsKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      next: { revalidate: 0 },
    });
    return (await res.json()) as GoogleRoutesResponse;
  }

  const [dataDefault, dataFewerTransfers, dataLessWalking] = await Promise.all([
    postComputeRoutes(apiKey),
    postComputeRoutes(apiKey, { transitPreferences: { routingPreference: "FEWER_TRANSFERS" } }),
    postComputeRoutes(apiKey, { transitPreferences: { routingPreference: "LESS_WALKING" } }),
  ]);

  const errMsg =
    dataDefault.error?.message ??
    dataFewerTransfers.error?.message ??
    dataLessWalking.error?.message;

  const mergedRoutes = mergeUniqueGoogleRoutes([
    dataDefault.routes ?? [],
    dataFewerTransfers.routes ?? [],
    dataLessWalking.routes ?? [],
  ]);

  if (mergedRoutes.length === 0) {
    if (errMsg) {
      return NextResponse.json({ error: { message: errMsg } }, { status: 502 });
    }
    return NextResponse.json({ error: { message: "검색된 경로가 없습니다" } }, { status: 200 });
  }

  mergedRoutes.sort((a, b) => routeTransitDiversityScore(b) - routeTransitDiversityScore(a));
  const cappedRoutes = mergedRoutes.slice(0, 10);
  // 지하철 포함 경로가 존재하면 결과 상위 목록에서 절대 누락되지 않도록 보정합니다.
  if (!cappedRoutes.some(routeHasSubway)) {
    const subwayRoute = mergedRoutes.find(routeHasSubway);
    if (subwayRoute) {
      if (cappedRoutes.length >= 10) cappedRoutes[cappedRoutes.length - 1] = subwayRoute;
      else cappedRoutes.push(subwayRoute);
    }
  }

  const normalized = normalizeGoogleRoutes({ routes: cappedRoutes }, Date.now());
  return NextResponse.json(normalized);
}
