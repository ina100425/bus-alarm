import { NextResponse } from "next/server";

type MetroStationListResponse = {
  error?: string;
  stationNames: string[];
};

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function slicePadTo5(items: string[], leftPadValue: string = ""): string[] {
  const cleaned = items.filter((s) => (s ?? "").trim() !== "").map((s) => s.trim());
  if (cleaned.length >= 5) return cleaned.slice(-5);
  const padCount = 5 - cleaned.length;
  const pad = Array.from({ length: padCount }, () => leftPadValue);
  return [...pad, ...cleaned];
}

function normalizeLineNameForOpenApi(lineName: string): string {
  const t = lineName.trim();
  if (!t) return t;
  if (/^\d+$/.test(t)) return `${t}호선`;
  return t;
}

function extractStatnNmRows(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const block = root.SearchSTNBySubwayLineInfo;
  if (!block || typeof block !== "object") return [];
  const rowsRaw = (block as Record<string, unknown>).row;
  const rows = asArray(rowsRaw as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const out: string[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const nm = rec.STATN_NM ?? rec.statnNm;
    if (typeof nm === "string" && nm.trim()) out.push(nm.trim());
  }
  return out;
}

export async function GET(req: Request) {
  const apiKey = process.env.NEXT_PUBLIC_SEOUL_METRO_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_SEOUL_METRO_API_KEY 미설정", stationNames: [] } satisfies MetroStationListResponse,
      { status: 500 },
    );
  }

  const { searchParams } = new URL(req.url);
  const lineNameRaw = (searchParams.get("lineName") ?? "").trim();
  const startName = (searchParams.get("startName") ?? "").trim();
  const endName = (searchParams.get("endName") ?? "").trim();

  if (!lineNameRaw) {
    return NextResponse.json({ error: "lineName이 필요합니다", stationNames: [] }, { status: 400 });
  }
  if (!startName || !endName) {
    return NextResponse.json(
      { error: "startName과 endName이 필요합니다", stationNames: [] },
      { status: 400 },
    );
  }

  const lineParam = normalizeLineNameForOpenApi(lineNameRaw);
  // 서울 openapi 경로의 인증키는 인코딩 없이 그대로 사용(서버가 디코딩된 키를 기대하는 경우가 많음)
  const url = `http://openapi.seoul.go.kr:8088/${apiKey}/json/SearchSTNBySubwayLineInfo/1/100/${encodeURIComponent(lineParam)}`;

  const res = await fetch(url, { next: { revalidate: 0 } });
  const json: unknown = await res.json().catch(() => null);

  if (!res.ok || !json || typeof json !== "object") {
    return NextResponse.json(
      { error: "지하철 역 목록 조회 실패", stationNames: [] },
      { status: 502 },
    );
  }

  const stationNamesAll = extractStatnNmRows(json);
  if (!stationNamesAll.length) {
    return NextResponse.json({ stationNames: [] } satisfies MetroStationListResponse);
  }

  const startIdx = stationNamesAll.findIndex((s) => s.trim() === startName);
  const endIdx = stationNamesAll.findIndex((s) => s.trim() === endName);

  if (startIdx < 0 || endIdx < 0) {
    return NextResponse.json({ stationNames: [] } satisfies MetroStationListResponse);
  }

  const ordered =
    startIdx <= endIdx
      ? stationNamesAll.slice(startIdx, endIdx + 1)
      : stationNamesAll.slice(endIdx, startIdx + 1).reverse();

  if (ordered.length >= 5) {
    const stationNames = ordered.slice(-5);
    return NextResponse.json({ stationNames } satisfies MetroStationListResponse);
  }

  const padded = slicePadTo5(ordered, "");
  return NextResponse.json({ stationNames: padded } satisfies MetroStationListResponse);
}
