import { NextResponse } from "next/server";

type MetroArrivalRequestBody = {
  stationName: string;
  lineName: string;
  directionLabel?: string;
  /** 5개 역명(정류장 도트와 동일 순서) */
  stationNames?: string[];
};

type MetroArrivalResponse = {
  status?: "ok" | "no_service" | "error";
  error?: string;
  minutesUntilArrival?: number;
  /** barvlDt 기준 남은 초(클라이언트에서 절대 시각 도착 예정으로 환산) */
  secondsUntilArrival?: number;
  /** stationNames에서 현재 위치에 해당하는 인덱스(0~4), 없으면 undefined */
  currentIndex?: number;
  message?: string;
};

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizeLineToken(name: string): string {
  return name
    .replace(/\s+/g, "")
    .replace(/[()]/g, "")
    .replace(/호선|급행|일반|내선|외선/g, "")
    .trim()
    .toLowerCase();
}

function extractDigits(v: string): string {
  return String(v ?? "").replace(/\D/g, "");
}

function lineNameToSubwayIdCandidates(requestedLine: string): string[] {
  const n = normalizeLineToken(requestedLine);
  const digit = extractDigits(n);
  const out: string[] = [];
  if (digit) {
    if (digit.length === 1) out.push(`100${digit}`);
    if (digit.length === 2 && digit.startsWith("1")) out.push(`10${digit}`);
    out.push(digit);
  }
  if (n.includes("공항")) out.push("1065");
  if (n.includes("경의중앙")) out.push("1063");
  if (n.includes("수인분당")) out.push("1075");
  if (n.includes("신분당")) out.push("1077");
  if (n.includes("경춘")) out.push("1067");
  if (n.includes("우이신설")) out.push("1092");
  if (n.includes("gtx")) out.push("1032");
  return Array.from(new Set(out));
}

function canonicalSubwayLineNameForApi(lineName: string): string {
  const raw = String(lineName ?? "").trim();
  const digitMatch = raw.match(/([1-9])\s*호선/);
  if (digitMatch?.[1]) return `${digitMatch[1]}호선`;
  if (raw.includes("수인분당")) return "수인분당선";
  if (raw.includes("신분당")) return "신분당선";
  if (raw.includes("경의중앙")) return "경의중앙선";
  if (raw.includes("공항철도")) return "공항철도";
  if (raw.includes("경춘")) return "경춘선";
  if (raw.includes("우이신설")) return "우이신설선";
  if (raw.toUpperCase().includes("GTX")) return "GTX-A";
  return raw.replace(/\(.*?\)/g, "").replace(/급행|일반/g, "").trim();
}

function lineMatches(arrivalLine: string, requestedLine: string): boolean {
  const a = normalizeLineToken(arrivalLine);
  const b = normalizeLineToken(requestedLine);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ad = extractDigits(a);
  const bd = extractDigits(b);
  if (ad && bd && (ad === bd || ad.includes(bd) || bd.includes(ad))) return true;
  const idCandidates = lineNameToSubwayIdCandidates(requestedLine);
  if (idCandidates.some((id) => a === id || a.includes(id))) return true;
  return false;
}

/** arvlMsg2 등에서 "○○역" 형태 역명 추출 */
function extractStationFromArvlMsg(msg: string): string | null {
  const m = msg.match(/([가-힣A-Za-z0-9]+)\s*역/);
  if (!m?.[1]) return null;
  return m[1].trim();
}

type RealtimePositionCandidate = {
  statnNm: string;
  updnLine: string;
  trainSttus: string;
  lstcarAt: string;
};

function normalizeDirectionToken(v: string): string {
  return String(v ?? "").replace(/\s+/g, "");
}

function directionMatches(updnLine: string, directionLabel: string): boolean {
  const d = normalizeDirectionToken(directionLabel);
  const u = normalizeDirectionToken(updnLine);
  if (!d) return true;
  if (!u) return true;
  if (u === "0") return d.includes("상행") || d.includes("내선");
  if (u === "1") return d.includes("하행") || d.includes("외선");
  if (u.includes("상행") || u.includes("내선")) return d.includes("상행") || d.includes("내선");
  if (u.includes("하행") || u.includes("외선")) return d.includes("하행") || d.includes("외선");
  return u.includes(d) || d.includes(u);
}

async function fetchRealtimePosition(
  apiKey: string,
  lineName: string,
): Promise<RealtimePositionCandidate[]> {
  const canonicalLine = canonicalSubwayLineNameForApi(lineName);
  const url =
    `http://swopenapi.seoul.go.kr/api/subway/${apiKey}/json/realtimePosition/0/200/` +
    `${encodeURIComponent(canonicalLine)}`;
  const res = await fetch(url, { next: { revalidate: 0 } });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !json || typeof json !== "object") return [];
  const root = json as Record<string, unknown>;
  const listRaw = root.realtimePositionList;
  const list = asArray(listRaw as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const out: RealtimePositionCandidate[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const statnNm = typeof rec.statnNm === "string" ? rec.statnNm.trim() : "";
    const updnLine = typeof rec.updnLine === "string" ? rec.updnLine : "";
    const trainSttus = typeof rec.trainSttus === "string" ? rec.trainSttus : "";
    const lstcarAt = typeof rec.lstcarAt === "string" ? rec.lstcarAt : "";
    if (!statnNm) continue;
    out.push({ statnNm, updnLine, trainSttus, lstcarAt });
  }
  return out;
}

export async function POST(req: Request) {
  const apiKey = (
    process.env.NEXT_PUBLIC_SEOUL_METRO_REALTIME_API_KEY ??
    process.env.NEXT_PUBLIC_SEOUL_SUBWAY_POSITION_API_KEY ??
    ""
  ).trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "NEXT_PUBLIC_SEOUL_METRO_REALTIME_API_KEY 또는 NEXT_PUBLIC_SEOUL_SUBWAY_POSITION_API_KEY 미설정",
        status: "error",
      } satisfies MetroArrivalResponse,
      { status: 500 },
    );
  }

  let body: MetroArrivalRequestBody;
  try {
    body = (await req.json()) as MetroArrivalRequestBody;
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }

  const stationName = (body.stationName ?? "").trim();
  const lineName = (body.lineName ?? "").trim();
  const directionLabel = (body.directionLabel ?? "").trim();
  const stationNames = Array.isArray(body.stationNames)
    ? body.stationNames.map((s) => String(s ?? "").trim()).filter(Boolean)
    : [];

  if (!stationName || !lineName) {
    return NextResponse.json({ error: "stationName과 lineName이 필요합니다" }, { status: 400 });
  }

  // 경로의 API 키는 encodeURIComponent 하면 포털 등록값과 불일치해 실패할 수 있음(역명만 인코딩)
  const url = `http://swopenapi.seoul.go.kr/api/subway/${apiKey}/json/realtimeStationArrival/1/100/${encodeURIComponent(stationName)}`;
  const res = await fetch(url, { next: { revalidate: 0 } });
  const json: unknown = await res.json().catch(() => null);

  if (!res.ok || !json || typeof json !== "object") {
    return NextResponse.json({ error: "실시간 도착 조회 실패", status: "error" }, { status: 502 });
  }

  const root = json as Record<string, unknown>;
  const topCode =
    typeof (root.errorMessage as Record<string, unknown> | undefined)?.code === "string"
      ? String((root.errorMessage as Record<string, unknown>).code)
      : "";
  const listRaw = root.realtimeArrivalList;
  const list = asArray(listRaw as Record<string, unknown> | Record<string, unknown>[] | undefined);

  const candidates: {
    barvlDtSec: number;
    arvlMsg2: string;
    subwayId: string;
    updnLine: string;
    trainLineNm: string;
    lstcarAt: string;
  }[] = [];

  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const barvlRaw = rec.barvlDt;
    const barvlDtSec =
      typeof barvlRaw === "string"
        ? parseInt(barvlRaw.replace(/\D/g, ""), 10)
        : typeof barvlRaw === "number"
          ? barvlRaw
          : NaN;
    const arvlMsg2 = typeof rec.arvlMsg2 === "string" ? rec.arvlMsg2 : "";
    const subwayId =
      typeof rec.subwayId === "string" ? rec.subwayId : typeof rec.subwayId === "number" ? String(rec.subwayId) : "";
    const updnLine = typeof rec.updnLine === "string" ? rec.updnLine : "";
    const trainLineNm = typeof rec.trainLineNm === "string" ? rec.trainLineNm : "";
    const lstcarAt = typeof rec.lstcarAt === "string" ? rec.lstcarAt : "";
    if (!Number.isFinite(barvlDtSec)) continue;
    candidates.push({ barvlDtSec, arvlMsg2, subwayId, updnLine, trainLineNm, lstcarAt });
  }

  const expectedSubwayIds = new Set(lineNameToSubwayIdCandidates(lineName));
  const byLine = candidates.filter((c) => {
    const subwayId = String(c.subwayId ?? "").trim();
    if (subwayId && expectedSubwayIds.has(subwayId)) return true;
    if (lineMatches(subwayId, lineName)) return true;
    return lineMatches(c.trainLineNm, lineName);
  });

  const withDirection =
    directionLabel.trim().length > 0
      ? byLine.filter((c) => directionMatches(c.updnLine, directionLabel))
      : byLine;

  const pick = withDirection[0] ?? byLine[0];
  if (pick) {
    const secondsUntilArrival = Math.max(0, Math.round(pick.barvlDtSec));
    const minutesUntilArrival = Math.max(0, Math.round(pick.barvlDtSec / 60));
    const extracted = extractStationFromArvlMsg(pick.arvlMsg2);
    let currentIndex: number | undefined;
    if (extracted && stationNames.length) {
      const idx = stationNames.findIndex((s) => s === extracted || `${s}역` === `${extracted}역`);
      if (idx >= 0) currentIndex = idx;
    }

    return NextResponse.json({
      status: "ok",
      minutesUntilArrival,
      secondsUntilArrival,
      currentIndex,
      message: pick.arvlMsg2,
    } satisfies MetroArrivalResponse);
  }

  // 도착 API에서 후보가 없으면 realtimePosition으로 보조 조회
  const posAll = await fetchRealtimePosition(apiKey, lineName);
  const posByDirection =
    directionLabel.trim().length > 0
      ? posAll.filter((p) => directionMatches(p.updnLine, directionLabel))
      : posAll;
  const posPick = posByDirection[0] ?? posAll[0];
  if (!posPick) {
    // API가 명시적으로 데이터 없음을 준 경우만 no_service로 처리
    if (topCode === "INFO-200") {
      return NextResponse.json({ status: "no_service" } satisfies MetroArrivalResponse);
    }
    return NextResponse.json(
      { status: "error", error: "노선/방향 식별 실패 또는 응답 불일치" } satisfies MetroArrivalResponse,
      { status: 502 },
    );
  }
  let currentIndex: number | undefined;
  if (stationNames.length) {
    const statnNm = posPick.statnNm.replace(/역$/, "");
    const idx = stationNames.findIndex((s) => s === statnNm || `${s}역` === `${statnNm}역`);
    if (idx >= 0) currentIndex = idx;
  }
  return NextResponse.json({
    status: "no_service",
    currentIndex,
    message: `${posPick.statnNm} 부근 운행중`,
  } satisfies MetroArrivalResponse);
}
