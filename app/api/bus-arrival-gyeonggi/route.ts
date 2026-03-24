import { NextResponse } from "next/server";

type Body = {
  stationName: string;
  routeLabel: string;
};

type BusArrivalResponse = {
  status?: "ok" | "no_service" | "error";
  error?: string;
  minutesUntilArrival?: number;
  message?: string;
};

type JsonMap = Record<string, unknown>;

function normalizeName(v: string): string {
  return String(v ?? "")
    .replace(/\s+/g, "")
    .replace(/역|정류장/g, "")
    .trim()
    .toLowerCase();
}

function normalizeRoute(v: string): string {
  return String(v ?? "").replace(/\s+/g, "").trim().toLowerCase();
}

function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { next: { revalidate: 0 } });
  return res.json().catch(() => null);
}

function getResponseBody(root: unknown): JsonMap | null {
  if (!root || typeof root !== "object") return null;
  const obj = root as JsonMap;
  const response = obj.response;
  if (!response || typeof response !== "object") return null;
  const msgBody = (response as JsonMap).msgBody;
  if (!msgBody || typeof msgBody !== "object") return null;
  return msgBody as JsonMap;
}

function pickString(rec: JsonMap, keys: string[]): string {
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (typeof val === "number") return String(val);
  }
  return "";
}

function pickNumber(rec: JsonMap, keys: string[]): number | null {
  for (const key of keys) {
    const val = rec[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string") {
      const n = Number(val.replace(/[^\d.-]/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function matchRoute(routeLabel: string, candidate: string): boolean {
  const a = normalizeRoute(routeLabel);
  const b = normalizeRoute(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const ad = a.replace(/\D/g, "");
  const bd = b.replace(/\D/g, "");
  if (!ad || !bd) return false;
  return ad === bd || ad.includes(bd) || bd.includes(ad);
}

export async function POST(req: Request) {
  const serviceKey = (
    process.env.NEXT_PUBLIC_GYEONGGI_BUS_API_KEY ?? process.env.NEXT_PUBLIC_PUBLIC_DATA_API_KEY ?? ""
  ).trim();
  if (!serviceKey) {
    return NextResponse.json(
      { error: "경기 버스 API 키 미설정", status: "error" } satisfies BusArrivalResponse,
      { status: 500 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" } satisfies BusArrivalResponse, { status: 400 });
  }

  const stationName = (body.stationName ?? "").trim();
  const routeLabel = (body.routeLabel ?? "").trim();
  if (!stationName || !routeLabel) {
    return NextResponse.json(
      { error: "stationName, routeLabel이 필요합니다", status: "error" } satisfies BusArrivalResponse,
      { status: 400 },
    );
  }

  const stationUrl =
    "https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationListv2?" +
    new URLSearchParams({
      serviceKey,
      keyword: stationName,
      format: "json",
    }).toString();
  const stationJson = await getJson(stationUrl);
  const stationBody = getResponseBody(stationJson);
  const stationItems = asArray(stationBody?.busStationList as JsonMap | JsonMap[] | undefined);
  if (stationItems.length === 0) {
    return NextResponse.json(
      { error: "정류소 조회 결과 없음", status: "error" } satisfies BusArrivalResponse,
      { status: 502 },
    );
  }
  const stationPicked =
    stationItems.find((it) => normalizeName(pickString(it, ["stationName"])) === normalizeName(stationName)) ??
    stationItems[0];
  const stationId = pickString(stationPicked, ["stationId", "stationid"]);
  if (!stationId) {
    return NextResponse.json(
      { error: "정류소 ID 추출 실패", status: "error" } satisfies BusArrivalResponse,
      { status: 502 },
    );
  }

  const viaRouteUrl =
    "https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationViaRouteListv2?" +
    new URLSearchParams({
      serviceKey,
      stationId,
      format: "json",
    }).toString();
  const viaRouteJson = await getJson(viaRouteUrl);
  const viaBody = getResponseBody(viaRouteJson);
  const viaItems = asArray(viaBody?.busRouteList as JsonMap | JsonMap[] | undefined);
  if (viaItems.length === 0) {
    return NextResponse.json(
      { error: "정류소 경유 노선 없음", status: "error" } satisfies BusArrivalResponse,
      { status: 502 },
    );
  }
  const viaPicked =
    viaItems.find((it) => matchRoute(routeLabel, pickString(it, ["routeName", "routeNm", "routeNo"]))) ??
    viaItems[0];
  const routeId = pickString(viaPicked, ["routeId", "routeid"]);
  const staOrderNum = pickNumber(viaPicked, ["staOrder", "stationSeq", "stationOrder"]);
  if (!routeId || staOrderNum == null) {
    return NextResponse.json(
      { error: "routeId/staOrder 추출 실패", status: "error" } satisfies BusArrivalResponse,
      { status: 502 },
    );
  }

  const arrivalUrl =
    "https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalItemv2?" +
    new URLSearchParams({
      serviceKey,
      stationId,
      routeId,
      staOrder: String(Math.trunc(staOrderNum)),
      format: "json",
    }).toString();
  const arrivalJson = await getJson(arrivalUrl);
  const arrBody = getResponseBody(arrivalJson);
  const arrItems = asArray(arrBody?.busArrivalItem as JsonMap | JsonMap[] | undefined);
  const arr = arrItems[0];
  if (!arr) {
    return NextResponse.json({ error: "도착 정보 없음", status: "no_service" } satisfies BusArrivalResponse, { status: 404 });
  }

  const predictMin =
    pickNumber(arr, ["predictTime1", "predictTime", "remainMin", "locationNo1"]) ??
    pickNumber(arr, ["locationNo1"]);
  if (predictMin == null || !Number.isFinite(predictMin)) {
    return NextResponse.json(
      { error: "도착 분 정보 파싱 실패", status: "error" } satisfies BusArrivalResponse,
      { status: 502 },
    );
  }

  const minutesUntilArrival = Math.max(0, Math.round(predictMin));
  return NextResponse.json({
    status: "ok",
    minutesUntilArrival,
    message: `${minutesUntilArrival}분 뒤 도착 예정`,
  } satisfies BusArrivalResponse);
}

