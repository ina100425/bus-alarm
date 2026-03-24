"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import localFont from "next/font/local";
import {
  buildRouteStorageKey,
  getWalkMinutesBeforeFirstBoarding,
  getWalkSecondsBeforeFirstBoarding,
  mergeAdjacentWalkStepsForBar,
  transitLegSignature,
} from "@/lib/transit-path";
import {
  getRouteAlertOnMap,
  getRouteFavorites,
  setAlertThresholdsMinutes,
  getAlertThresholdsMinutes,
  isRouteAlertOn,
  isRouteFavorite,
  setRouteAlertOnMap,
  setRouteAlertOn,
  setRouteFavorites,
  toggleRouteFavorite,
} from "@/lib/user-storage";
import { getSupabaseClient } from "@/lib/supabase-client";

const peaceBold = localFont({
  src: "../public/fonts/PyeongChangPeace-Bold.ttf",
  display: "swap",
});
const atozLight = localFont({
  src: "../public/fonts/atoz-3Light.ttf",
  display: "swap",
});

type DepartureRegion = "seoul" | "gyeonggi" | "unknown";

type GeocodeDoc = {
  address?: {
    region_1depth_name?: string;
    region_2depth_name?: string;
    address_name?: string;
  };
  road_address?: {
    address_name?: string;
  };
  x: string; // lng
  y: string; // lat
};

type PlacePrediction = { description: string; place_id: string };

type TransitSubPath = {
  trafficType: number; // 1 subway, 2 bus, 3 walk
  distance: number;
  sectionTime: number;
  /** Google 구간 초(진행바 비율) */
  sectionDurationSec?: number;
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
  transitDepartureTimeMs?: number;
  transitArrivalTimeMs?: number;
  /** Google transit headway(초), 서버에서 버스 탑승 시각 보정에 사용 */
  headwaySec?: number;
  intermediateStopNames?: string[];
};

type TransitPath = {
  pathType: number;
  info: {
    totalTime: number;
    /** Google route 전체 초 */
    totalDurationSec?: number;
    totalWalk: number;
    firstStartStation: string;
    lastEndStation: string;
    payment?: number;
  };
  subPath: TransitSubPath[];
};

type TransitResponse = {
  result?: { searchType?: number; path?: TransitPath[] };
  error?: { message?: string };
};

type TransitPathSummary = {
  index: number;
  totalTimeMin: number;
  walkSummary: string;
  busSummary: string;
  firstBusStopName: string;
  raw: TransitPath;
};

/** 서울 지하철 실시간 도착 API 기반 표시용(역 승강장 도착 예정 시각) */
type MetroLiveEta = {
  platformArrivalMs: number;
  message: string;
  status: "ok" | "no_service" | "error";
};

type BusLiveEta = {
  platformArrivalMs: number;
  message: string;
  status: "ok" | "no_service" | "error";
};

type CloudPrefs = {
  favorites: ReturnType<typeof getRouteFavorites>;
  alertOnMap: Record<string, boolean>;
  alertThresholds: number[];
};

const DEFAULT_BUFFER_MIN = 3;

const CLOUD_PREFS_KEY = "busAlarmPrefs";

/**
 * 첫 탑승 정류장·역 기준 도착(탑승) 시각과 권장 출발 시각.
 * 지하철은 실시간 API(승강장 도착)를 우선, 없으면 Google 예정 출발 시각.
 */
function resolveBoardingAndLeave(params: {
  nowMs: number;
  subPath: TransitSubPath[];
  firstBoardingStep: TransitSubPath | null;
  googleBoardingMs: number | null;
  realtimePlatformArrivalMs: number | null;
  bufferMin: number;
}): { beAtStopMs: number | null; leaveAtMs: number | null; walkMin: number } {
  const { nowMs, subPath, firstBoardingStep, googleBoardingMs, realtimePlatformArrivalMs, bufferMin } =
    params;
  const walkMin = firstBoardingStep ? getWalkMinutesBeforeFirstBoarding(subPath) : 0;
  if (
    !firstBoardingStep ||
    (firstBoardingStep.trafficType !== 1 && firstBoardingStep.trafficType !== 2)
  ) {
    return { beAtStopMs: null, leaveAtMs: null, walkMin: 0 };
  }

  let beAtStopMs: number | null = null;
  if (
    (firstBoardingStep.trafficType === 1 || firstBoardingStep.trafficType === 2) &&
    realtimePlatformArrivalMs != null
  ) {
    if (realtimePlatformArrivalMs > nowMs - 750) {
      beAtStopMs = realtimePlatformArrivalMs;
    }
  }
  if (beAtStopMs == null && googleBoardingMs != null && googleBoardingMs > nowMs + 500) {
    beAtStopMs = googleBoardingMs;
  }

  if (beAtStopMs == null) {
    return { beAtStopMs: null, leaveAtMs: null, walkMin };
  }

  const leaveAtMs = beAtStopMs - walkMin * 60_000 - bufferMin * 60_000;
  return { beAtStopMs, leaveAtMs, walkMin };
}

function detectDepartureRegion(doc: GeocodeDoc | undefined): DepartureRegion {
  const depth = doc?.address?.region_1depth_name?.trim() ?? "";
  if (depth.includes("서울")) return "seoul";
  if (depth.includes("경기")) return "gyeonggi";
  return "unknown";
}

function formatKoreanTime(d: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDurationHourMin(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}분`;
  if (m <= 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

function pathHasTransit(path: TransitPath): boolean {
  return path.subPath.some((s) => s.trafficType === 1 || s.trafficType === 2);
}

function getWalkMetersBeforeFirstBoarding(subPath: TransitSubPath[]): number {
  let walk = 0;
  for (const s of subPath) {
    if (s.trafficType === 1 || s.trafficType === 2) break;
    if (s.trafficType === 3) walk += Math.max(0, s.distance);
  }
  return Math.round(walk);
}

function formatWalkMeters(subPaths: TransitSubPath[]): string {
  let walk = 0;
  for (const s of subPaths) {
    if (s.trafficType === 3) walk += s.distance;
  }
  return walk > 0 ? `도보 약 ${Math.round(walk)}m` : "도보 없음";
}

function collectBusLabels(path: TransitPath): string {
  const nums: string[] = [];
  for (const s of path.subPath) {
    if (s.trafficType !== 2) continue;
    const busNo = (s.lane?.[0]?.busNo ?? "").trim();
    if (busNo && !nums.includes(busNo)) nums.push(busNo);
  }
  return nums.length ? nums.join(" → ") : "버스 없음";
}

function summarizePaths(paths: TransitPath[]): TransitPathSummary[] {
  return paths.map((raw, index) => {
    const firstTransit = raw.subPath.find((s) => s.trafficType === 1 || s.trafficType === 2);
    const firstStop = firstTransit?.startName?.trim() || raw.info.firstStartStation;
    return {
      index,
      totalTimeMin: raw.info.totalTime,
      walkSummary: formatWalkMeters(raw.subPath ?? []),
      busSummary: collectBusLabels(raw),
      firstBusStopName: firstStop || raw.info.firstStartStation,
      raw,
    };
  });
}

/** Google 탑승 출발 시각 기준 남은 분 문구 */
function formatGoogleDepartSummary(
  departureMs: number | undefined,
  nowMs: number,
  fallbackSectionMin: number,
): string {
  if (departureMs != null && Number.isFinite(departureMs)) {
    const min = (departureMs - nowMs) / 60_000;
    if (min <= 0) return "곧 출발";
    return `약 ${Math.ceil(min)}분 후 출발`;
  }
  const m = Math.max(0, fallbackSectionMin);
  return m <= 0 ? "시간 미상" : `약 ${Math.ceil(m)}분 후 도착(경로 추정)`;
}

function getUniqueBusNumbers(path: TransitPath): string[] {
  const nums: string[] = [];
  for (const s of path.subPath) {
    if (s.trafficType !== 2) continue;
    const busNo = (s.lane?.[0]?.busNo ?? "").trim();
    if (!busNo) continue;
    if (!nums.includes(busNo)) nums.push(busNo);
  }
  return nums;
}

function getUniqueSubwayLines(path: TransitPath): string[] {
  const lines: string[] = [];
  for (const s of path.subPath) {
    if (s.trafficType !== 1) continue;
    const lineName = (s.lane?.[0]?.busNo ?? "").trim();
    if (!lineName) continue;
    if (!lines.includes(lineName)) lines.push(lineName);
  }
  return lines;
}

function getTransitLinesInBoardingOrder(path: TransitPath): Array<{
  lineName: string;
  trafficType: 1 | 2;
  key: string;
}> {
  const ordered: Array<{ lineName: string; trafficType: 1 | 2; key: string }> = [];
  for (let i = 0; i < path.subPath.length; i += 1) {
    const s = path.subPath[i];
    if (s.trafficType !== 1 && s.trafficType !== 2) continue;
    const fallback = s.trafficType === 1 ? "지하철" : "버스";
    const lineName = (s.lane?.[0]?.busNo ?? "").trim() || fallback;
    ordered.push({
      lineName,
      trafficType: s.trafficType,
      key: `${i}-${s.startName}-${s.endName}-${lineName}-${s.trafficType}`,
    });
  }
  return ordered;
}


/** 같은 첫 버스 키로 묶이면 지하철 포함 대안이 사라지므로, 대중교통 구간 전체 시그니처로 구분 */
/** Google 도보 구간 초 합을 사람이 읽기 좋게 표시 */
/** 노선 행: 가로 스위치 OFF(왼쪽) / ON(오른쪽) */
function RouteAlertSwitch(props: {
  enabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const { enabled, onChange } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="알림 켜기"
      onClick={(e) => {
        e.stopPropagation();
        onChange(!enabled);
      }}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
        enabled ? "bg-pink-500" : "bg-zinc-300 dark:bg-zinc-600"
      }`}
    >
      <span
        className={`pointer-events-none absolute top-0.5 left-0.5 block h-5 w-5 rounded-full bg-white shadow-md ring-1 ring-black/5 transition-transform duration-200 ${
          enabled ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function formatWalkLeadText(subPath: TransitSubPath[]): string {
  const sec = getWalkSecondsBeforeFirstBoarding(subPath);
  if (sec <= 0) return "도보 없음";
  if (sec < 60) return `약 ${sec}초`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (r === 0) return `약 ${m}분`;
  return `약 ${m}분 ${r}초`;
}

function dedupePathsByTransitSignature(paths: TransitPathSummary[]): TransitPathSummary[] {
  const seen = new Set<string>();
  const out: TransitPathSummary[] = [];
  for (const p of paths) {
    const key = transitLegSignature(p.raw.subPath, {
      totalTimeMin: p.raw.info.totalTime,
      totalDurationSec: p.raw.info.totalDurationSec,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.map((p, idx) => ({ ...p, index: idx }));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function truncateLabel(s: string, maxLen: number): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}...`;
}

function getBusBadgeClass(busNo: string, departureRegion: DepartureRegion): string {
  const v = (busNo ?? "").trim();
  const upper = v.toUpperCase();
  const digits = v.replace(/\D/g, "");
  const digitLen = digits.length;
  const firstDigit = digitLen > 0 ? digits[0] : "";

  if (departureRegion === "gyeonggi") {
    // 경기: 확실한 규칙은 광역(4자리 + 앞자리 9)만 적용
    if (digitLen === 4 && firstDigit === "9") return "bg-[#e60012] text-white";
    // 경기: 그 외는 기존 시내일반 색상으로 처리
    return "bg-[#33CC99] text-white";
  }

  // 서울 심야: 앞자리 N
  if (upper.startsWith("N")) return "bg-[#3d5bab] text-white";
  // 서울 순환: 2자리
  if (digitLen === 2) return "bg-[#f2b70a] text-black";
  // 서울 광역: 4자리 + 앞자리 9
  if (digitLen === 4 && firstDigit === "9") return "bg-[#e60012] text-white";
  // 서울 지선: 4자리(광역 제외)
  if (digitLen === 4) return "bg-[#53b332] text-white";
  // 서울 간선: 3자리
  if (digitLen === 3) return "bg-[#0068b7] text-white";
  return "bg-[#0068b7] text-white";
}

/** 진행바: 전체 초 대비 구간 비율(%), 최소 폭 반영 후 100% 초과 시 마지막 구간에서 조정 */
function computeProgressPercents(
  subPath: TransitSubPath[],
  totalDurationSec: number,
): number[] {
  const cardW = 480;
  const minWalkPct = (8 / cardW) * 100;
  const minTransitPct = (20 / cardW) * 100;
  const total = Math.max(1, totalDurationSec || 1);
  const secs = subPath.map((st) =>
    Math.max(1, st.sectionDurationSec ?? st.sectionTime * 60),
  );
  const sumSec = secs.reduce((a, b) => a + b, 0);
  const scaled = sumSec > total ? secs.map((s) => (s * total) / sumSec) : secs;
  const sum2 = scaled.reduce((a, b) => a + b, 0) || 1;
  let pct = scaled.map((s) => (s / sum2) * 100);
  pct = pct.map((p, i) =>
    Math.max(subPath[i].trafficType === 3 ? minWalkPct : minTransitPct, p),
  );
  let tot = pct.reduce((a, b) => a + b, 0);
  if (tot > 100 && pct.length > 0) {
    const li = pct.length - 1;
    const floor = subPath[li].trafficType === 3 ? minWalkPct : minTransitPct;
    pct[li] = Math.max(floor, pct[li] - (tot - 100));
    tot = pct.reduce((a, b) => a + b, 0);
    if (tot > 100) {
      const scale = 100 / tot;
      pct = pct.map((p) => p * scale);
    }
  }
  return pct;
}

function getSubwayBadgeClass(lineName: string): string {
  const v = (lineName ?? "").trim();
  if (v.includes("1호선")) return "bg-[#0052A4] text-white";
  if (v.includes("2호선")) return "bg-[#009D3E] text-white";
  if (v.includes("3호선")) return "bg-[#EF7C1C] text-white";
  if (v.includes("4호선")) return "bg-[#00A5DE] text-white";
  if (v.includes("5호선")) return "bg-[#996CAC] text-white";
  if (v.includes("6호선")) return "bg-[#CD7C2F] text-white";
  if (v.includes("7호선")) return "bg-[#777F00] text-white";
  if (v.includes("8호선")) return "bg-[#F55091] text-white";
  if (v.includes("9호선")) return "bg-[#BDB092] text-white";
  if (v.includes("신분당선")) return "bg-[#D4003B] text-white";
  if (v.includes("경의중앙선")) return "bg-[#77C4A3] text-white";
  if (v.includes("수인분당선")) return "bg-[#F5A200] text-white";
  if (v.includes("공항철도")) return "bg-[#0090D2] text-white";
  return "bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100";
}

function extractBgAndTextFromBadgeClass(badgeClass: string): {
  bgClass: string;
  textClass: string;
} {
  const tokens = badgeClass.split(/\s+/).filter(Boolean);
  const bg = tokens.find((t) => t.startsWith("bg-")) ?? "bg-zinc-200";
  const text = tokens.find((t) => t.startsWith("text-")) ?? "text-zinc-900";
  return { bgClass: bg, textClass: text };
}

/** 30초 갱신 후 동일 경로 행 유지용 */
function pathReselectSignature(p: TransitPathSummary): string {
  return transitLegSignature(p.raw.subPath, {
    totalTimeMin: p.raw.info.totalTime,
    totalDurationSec: p.raw.info.totalDurationSec ?? p.raw.info.totalTime * 60,
  });
}

async function postGeocode(address: string): Promise<GeocodeDoc | null> {
  const res = await fetch("/api/geocode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const data = (await res.json()) as {
    documents?: GeocodeDoc[];
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "주소 검색에 실패했습니다");
  return data.documents?.[0] ?? null;
}

async function fetchTransitPaths(params: {
  sx: string;
  sy: string;
  ex: string;
  ey: string;
}): Promise<TransitPathSummary[]> {
  const url = `/api/transit?sx=${encodeURIComponent(params.sx)}&sy=${encodeURIComponent(params.sy)}&ex=${encodeURIComponent(
    params.ex,
  )}&ey=${encodeURIComponent(params.ey)}`;
  const res = await fetch(url);
  const json = (await res.json()) as TransitResponse;
  if (!res.ok) {
    const msg = json.error?.message ?? "길찾기 요청에 실패했습니다";
    throw new Error(msg);
  }
  const paths = json.result?.path ?? [];
  if (!paths.length) throw new Error("검색된 경로가 없습니다");
  const summarized = summarizePaths(paths);
  return dedupePathsByTransitSignature(summarized);
}

function AddressFieldWithPlaces(props: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onManualChange: (v: string) => void;
  onPickDescription: (description: string) => void | Promise<void>;
}) {
  const { id, label, placeholder, value, onManualChange, onPickDescription } = props;
  const [open, setOpen] = useState(false);
  const [preds, setPreds] = useState<PlacePrediction[]>([]);
  const [loadingAc, setLoadingAc] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!el.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const q = value.trim();
    if (q.length < 2) {
      setPreds([]);
      setLoadingAc(false);
      return;
    }

    debounceRef.current = window.setTimeout(() => {
      void (async () => {
        setLoadingAc(true);
        try {
          const res = await fetch(`/api/place?input=${encodeURIComponent(q)}`);
          const data = (await res.json()) as { predictions?: PlacePrediction[] };
          if (res.ok && Array.isArray(data.predictions)) {
            setPreds(data.predictions);
          } else {
            setPreds([]);
          }
        } catch {
          setPreds([]);
        } finally {
          setLoadingAc(false);
        }
      })();
    }, 320);

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [value]);

  const inputCls =
    "w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-emerald-500/40";

  return (
    <div ref={wrapRef} className="relative">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        className={inputCls}
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        onChange={(e) => {
          onManualChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (value.trim().length >= 2 && (preds.length > 0 || loadingAc)) setOpen(true);
        }}
      />
      {open && (loadingAc || preds.length > 0) ? (
        <ul
          className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          role="listbox"
        >
          {loadingAc && preds.length === 0 ? (
            <li className="px-3 py-2 text-sm text-zinc-500">검색 중…</li>
          ) : null}
          {preds.map((p) => (
            <li key={p.place_id} role="option">
              <button
                type="button"
                className="w-full px-3 py-2.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onClick={() => {
                  void onPickDescription(p.description);
                  setOpen(false);
                  setPreds([]);
                }}
              >
                {p.description}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function BusAlarmApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [originText, setOriginText] = useState("");
  const [destText, setDestText] = useState("");
  const [originDoc, setOriginDoc] = useState<GeocodeDoc | null>(null);
  const [destDoc, setDestDoc] = useState<GeocodeDoc | null>(null);
  const [region, setRegion] = useState<DepartureRegion>("unknown");
  const [paths, setPaths] = useState<TransitPathSummary[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const selectedRouteSigRef = useRef<string | null>(null);

  /** 로컬 저장소(즐겨찾기·알림 스위치) 변경 후 리렌더용 */
  const [prefsTick, setPrefsTick] = useState(0);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [metroLive, setMetroLive] = useState<MetroLiveEta | null>(null);
  const [busLive, setBusLive] = useState<BusLiveEta | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const notifiedThresholdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const o = searchParams.get("origin")?.trim();
    const d = searchParams.get("dest")?.trim();
    if (o) setOriginText(o);
    if (d) setDestText(d);
  }, [searchParams]);

  const savePrefsToCloud = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const payload: CloudPrefs = {
      favorites: getRouteFavorites(),
      alertOnMap: getRouteAlertOnMap(),
      alertThresholds: getAlertThresholdsMinutes(),
    };
    await supabase.auth.updateUser({
      data: {
        ...(user.user_metadata ?? {}),
        [CLOUD_PREFS_KEY]: payload,
      },
    });
  }, []);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    const hydrate = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user ?? null;
      setAuthEmail(user?.email ?? null);
      setAuthReady(true);
      const metaRaw = user?.user_metadata?.[CLOUD_PREFS_KEY] as CloudPrefs | undefined;
      if (metaRaw) {
        if (Array.isArray(metaRaw.favorites)) setRouteFavorites(metaRaw.favorites);
        if (metaRaw.alertOnMap && typeof metaRaw.alertOnMap === "object") {
          setRouteAlertOnMap(metaRaw.alertOnMap);
        }
        if (Array.isArray(metaRaw.alertThresholds) && metaRaw.alertThresholds.length > 0) {
          setAlertThresholdsMinutes(metaRaw.alertThresholds);
        }
        setPrefsTick((v) => v + 1);
      }
    };
    void hydrate();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setAuthEmail(user?.email ?? null);
      setAuthReady(true);
    });
    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (!authEmail) router.replace("/signin");
  }, [authReady, authEmail, router]);

  const sendBrowserNotif = useCallback((title: string, body: string) => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try {
      // 브라우저 기본 알림
      // eslint-disable-next-line no-new
      new Notification(title, { body, lang: "ko-KR" });
    } catch {
      // 알림 실패는 무시
    }
  }, []);

  const requestNotifPermission = useCallback(async () => {
    if (!("Notification" in window)) {
      setInfoMsg("이 브라우저는 알림을 지원하지 않습니다");
      return;
    }
    const p = await Notification.requestPermission();
    if (p !== "granted") setInfoMsg("알림 권한이 거부되었습니다");
    else setInfoMsg(null);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!authEmail) return;
    void savePrefsToCloud();
  }, [prefsTick, authEmail, savePrefsToCloud]);

  // 출발 시각은 스냅샷+nowTick으로 매초 재계산되므로, 경로 바뀔 때만 임계값 알림 상태를 초기화합니다.
  useEffect(() => {
    notifiedThresholdsRef.current = new Set();
  }, [selectedIdx]);

  useEffect(() => {
    if (selectedIdx == null || !paths[selectedIdx]) return;
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    const p = paths[selectedIdx];
    if (!isRouteAlertOn(originText, destText, p.raw.subPath)) return;

    const firstBoard = p.raw.subPath.find((s) => s.trafficType === 1 || s.trafficType === 2);
    const googleMs = firstBoard?.transitDepartureTimeMs ?? null;
    const realtimeMs =
      firstBoard?.trafficType === 1 && metroLive != null
        ? metroLive.platformArrivalMs
        : firstBoard?.trafficType === 2 && busLive != null
          ? busLive.platformArrivalMs
          : null;
    const { leaveAtMs: leaveWallMs } = resolveBoardingAndLeave({
      nowMs: nowTick,
      subPath: p.raw.subPath,
      firstBoardingStep: firstBoard ?? null,
      googleBoardingMs: googleMs,
      realtimePlatformArrivalMs: realtimeMs,
      bufferMin: DEFAULT_BUFFER_MIN,
    });
    if (leaveWallMs == null || leaveWallMs <= nowTick) return;

    const until = leaveWallMs - nowTick;

    const thresholds = getAlertThresholdsMinutes();
    for (const tMin of thresholds) {
      const ms = tMin * 60 * 1000;
      if (until <= ms && !notifiedThresholdsRef.current.has(tMin)) {
        notifiedThresholdsRef.current.add(tMin);
        const atLabel = formatKoreanTime(new Date(leaveWallMs));
        sendBrowserNotif(
          "출발 알림",
          `${tMin}분 전입니다. ${atLabel} 출발 기준으로 준비하세요.`,
        );
      }
    }
  }, [
    nowTick,
    selectedIdx,
    paths,
    originText,
    destText,
    sendBrowserNotif,
    prefsTick,
    metroLive,
    busLive,
  ]);

  const pickOrigin = async (description: string) => {
    setOriginText(description);
    try {
      const doc = await postGeocode(description);
      setOriginDoc(doc);
      setRegion(detectDepartureRegion(doc ?? undefined));
    } catch {
      setOriginDoc(null);
      setRegion("unknown");
    }
  };

  const pickDest = async (description: string) => {
    setDestText(description);
    try {
      const doc = await postGeocode(description);
      setDestDoc(doc);
    } catch {
      setDestDoc(null);
    }
  };

  const runSearchByText = async (originQuery: string, destinationQuery: string) => {
    setErr(null);
    setPaths([]);
    setSelectedIdx(null);
    selectedRouteSigRef.current = null;
    setLoading(true);
    try {
      const oq = originQuery.trim();
      const dq = destinationQuery.trim();
      if (!oq || !dq) throw new Error("출발지와 목적지를 모두 입력해 주세요");

      const canReuseOriginDoc = originDoc != null && originText.trim() === oq;
      const canReuseDestDoc = destDoc != null && destText.trim() === dq;
      const od = canReuseOriginDoc ? originDoc : await postGeocode(oq);
      const dd = canReuseDestDoc ? destDoc : await postGeocode(dq);
      if (!od) throw new Error("출발지 주소를 찾을 수 없습니다");
      if (!dd) throw new Error("목적지 주소를 찾을 수 없습니다");

      setOriginDoc(od);
      setDestDoc(dd);

      const reg = detectDepartureRegion(od);
      setRegion(reg);
      if (reg === "unknown") throw new Error("출발지는 서울특별시 또는 경기도 주소만 지원합니다");

      const list = await fetchTransitPaths({ sx: od.x, sy: od.y, ex: dd.x, ey: dd.y });
      setPaths(list);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "알 수 없는 오류";
      setErr(msg);
    } finally {
      setLoading(false);
    }
  };

  const searchRoutes = async () => {
    await runSearchByText(originText, destText);
  };

  useEffect(() => {
    if (selectedIdx != null && paths[selectedIdx]) {
      selectedRouteSigRef.current = pathReselectSignature(paths[selectedIdx]);
    }
  }, [selectedIdx, paths]);

  /** 30초마다 Google Routes 재호출로 탑승 출발 시각 갱신 */
  useEffect(() => {
    if (!originDoc || !destDoc || paths.length === 0) return;
    const od = originDoc;
    const dd = destDoc;
    const tick = () => {
      void (async () => {
        const sig = selectedRouteSigRef.current;
        try {
          const list = await fetchTransitPaths({ sx: od.x, sy: od.y, ex: dd.x, ey: dd.y });
          setPaths(list);
          if (sig != null) {
            const idx = list.findIndex((p) => pathReselectSignature(p) === sig);
            if (idx >= 0) setSelectedIdx(idx);
          }
        } catch {
          /* 이전 목록 유지 */
        }
      })();
    };
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [originDoc?.x, originDoc?.y, destDoc?.x, destDoc?.y, paths.length]);

  /** Google 예정 출발이 이미 지난 경우 즉시 재조회해 다음 배차를 반영 */
  const lastStaleRefetchAtRef = useRef(0);
  useEffect(() => {
    if (!originDoc || !destDoc || selectedIdx == null || paths.length === 0) return;
    const dep = paths[selectedIdx]?.raw.subPath.find(
      (s) => s.trafficType === 1 || s.trafficType === 2,
    )?.transitDepartureTimeMs;
    const googleStale = dep != null && dep < nowTick - 8_000;
    if (!googleStale) return;
    const since = Date.now() - lastStaleRefetchAtRef.current;
    if (since < 6_000) return;
    lastStaleRefetchAtRef.current = Date.now();
    void (async () => {
      const sig = selectedRouteSigRef.current;
      try {
        const list = await fetchTransitPaths({
          sx: originDoc.x,
          sy: originDoc.y,
          ex: destDoc.x,
          ey: destDoc.y,
        });
        setPaths(list);
        if (sig != null) {
          const idx = list.findIndex((p) => pathReselectSignature(p) === sig);
          if (idx >= 0) setSelectedIdx(idx);
        }
      } catch {
        /* 유지 */
      }
    })();
  }, [nowTick, originDoc, destDoc, selectedIdx, paths]);

  const firstBoardingStep =
    selectedIdx != null && paths[selectedIdx]
      ? paths[selectedIdx].raw.subPath.find((s) => s.trafficType === 1 || s.trafficType === 2) ??
        null
      : null;

  const selectedPathSigForLive =
    selectedIdx != null && paths[selectedIdx] ? pathReselectSignature(paths[selectedIdx]) : "";

  const firstBoardingSubwayStation =
    firstBoardingStep?.trafficType === 1 ? (firstBoardingStep.startName ?? "").trim() : "";
  const firstBoardingSubwayLine =
    firstBoardingStep?.trafficType === 1
      ? (firstBoardingStep.lane?.[0]?.busNo ?? "").trim()
      : "";
  const firstBoardingSubwayHeadsign =
    firstBoardingStep?.trafficType === 1 ? (firstBoardingStep.transitHeadsign ?? "").trim() : "";
  const firstBoardingBusStopName =
    firstBoardingStep?.trafficType === 2 ? (firstBoardingStep.startName ?? "").trim() : "";
  const firstBoardingBusRouteLabel =
    firstBoardingStep?.trafficType === 2 ? (firstBoardingStep.lane?.[0]?.busNo ?? "").trim() : "";

  /** 첫 탑승이 지하철일 때 실시간 도착 정보(서울 API) */
  useEffect(() => {
    if (!firstBoardingSubwayStation || !firstBoardingSubwayLine) {
      setMetroLive(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch("/api/metro-arrival", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stationName: firstBoardingSubwayStation,
            lineName: firstBoardingSubwayLine,
            directionLabel: firstBoardingSubwayHeadsign,
          }),
        });
        const data = (await res.json()) as {
          status?: "ok" | "no_service" | "error";
          minutesUntilArrival?: number;
          secondsUntilArrival?: number;
          message?: string;
        };
        if (cancelled) return;
        if (!res.ok || data.status === "error") {
          setMetroLive({ platformArrivalMs: 0, message: "", status: "error" });
          return;
        }
        if (data.status === "no_service") {
          setMetroLive({ platformArrivalMs: 0, message: "", status: "no_service" });
          return;
        }
        const secRaw =
          typeof data.secondsUntilArrival === "number" && Number.isFinite(data.secondsUntilArrival)
            ? data.secondsUntilArrival
            : typeof data.minutesUntilArrival === "number" && Number.isFinite(data.minutesUntilArrival)
              ? data.minutesUntilArrival * 60
              : NaN;
        if (!Number.isFinite(secRaw)) {
          setMetroLive({ platformArrivalMs: 0, message: "", status: "error" });
          return;
        }
        const sec = Math.max(0, Math.round(secRaw));
        setMetroLive({
          platformArrivalMs: Date.now() + sec * 1000,
          message: typeof data.message === "string" ? data.message : "",
          status: "ok",
        });
      } catch {
        if (!cancelled) setMetroLive({ platformArrivalMs: 0, message: "", status: "error" });
      }
    };
    void run();
    const id = window.setInterval(run, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    selectedPathSigForLive,
    firstBoardingSubwayStation,
    firstBoardingSubwayLine,
    firstBoardingSubwayHeadsign,
  ]);

  /** 첫 탑승이 경기 버스일 때 실시간 도착 예정(경기 버스 API) */
  useEffect(() => {
    if (region !== "gyeonggi" || !firstBoardingBusStopName || !firstBoardingBusRouteLabel) {
      setBusLive(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch("/api/bus-arrival-gyeonggi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stationName: firstBoardingBusStopName,
            routeLabel: firstBoardingBusRouteLabel,
          }),
        });
        const data = (await res.json()) as {
          status?: "ok" | "no_service" | "error";
          minutesUntilArrival?: number;
          message?: string;
        };
        if (cancelled) return;
        if (res.status === 404 || data.status === "no_service") {
          setBusLive({ platformArrivalMs: 0, message: "", status: "no_service" });
          return;
        }
        if (!res.ok || data.status === "error") {
          setBusLive({ platformArrivalMs: 0, message: "", status: "error" });
          return;
        }
        const min = typeof data.minutesUntilArrival === "number" ? data.minutesUntilArrival : NaN;
        if (!Number.isFinite(min)) {
          setBusLive({ platformArrivalMs: 0, message: "", status: "error" });
          return;
        }
        setBusLive({
          platformArrivalMs: Date.now() + Math.max(0, Math.round(min)) * 60_000,
          message: typeof data.message === "string" ? data.message : "",
          status: "ok",
        });
      } catch {
        if (!cancelled) setBusLive({ platformArrivalMs: 0, message: "", status: "error" });
      }
    };
    void run();
    const id = window.setInterval(run, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [region, selectedPathSigForLive, firstBoardingBusStopName, firstBoardingBusRouteLabel]);

  const boardingDepMs = firstBoardingStep?.transitDepartureTimeMs ?? null;
  const boardingLineLabel =
    (firstBoardingStep?.lane?.[0]?.busNo ?? "").trim() ||
    (firstBoardingStep?.trafficType === 1
      ? "지하철"
      : firstBoardingStep?.trafficType === 2
        ? "버스"
        : "");

  const realtimePlatformMs =
    firstBoardingStep?.trafficType === 1 && metroLive?.status === "ok"
      ? metroLive.platformArrivalMs
      : firstBoardingStep?.trafficType === 2 && busLive?.status === "ok"
        ? busLive.platformArrivalMs
      : null;

  const { beAtStopMs, leaveAtMs } = useMemo(() => {
    const subPath =
      selectedIdx != null && paths[selectedIdx] ? paths[selectedIdx].raw.subPath : [];
    return resolveBoardingAndLeave({
      nowMs: nowTick,
      subPath,
      firstBoardingStep,
      googleBoardingMs: boardingDepMs,
      realtimePlatformArrivalMs: realtimePlatformMs,
      bufferMin: DEFAULT_BUFFER_MIN,
    });
  }, [nowTick, selectedIdx, paths, firstBoardingStep, boardingDepMs, realtimePlatformMs]);
  const displayWalkSec =
    selectedIdx != null && paths[selectedIdx]
      ? getWalkSecondsBeforeFirstBoarding(paths[selectedIdx].raw.subPath)
      : 0;
  const displayWalkMin = displayWalkSec <= 0 ? 0 : Math.max(1, Math.ceil(displayWalkSec / 60));
  const displayWalkMeters =
    selectedIdx != null && paths[selectedIdx]
      ? getWalkMetersBeforeFirstBoarding(paths[selectedIdx].raw.subPath)
      : 0;

  /** 탑승·도착 시각이 현재 이하이면 이미 지난 배차로 보고 다음 편으로 갱신 */
  const vehicleMissed = beAtStopMs != null && beAtStopMs <= nowTick;
  /** 권장 시각은 지났으나 첫 차량은 아직 탑승 가능 */
  const immediateLeaveNeeded =
    beAtStopMs != null &&
    beAtStopMs > nowTick &&
    leaveAtMs != null &&
    leaveAtMs <= nowTick;
  /** 권장 출발이 아직 미래 */
  const futureLeaveOk = leaveAtMs != null && leaveAtMs > nowTick;

  const vehicleMinUntil =
    beAtStopMs != null && !vehicleMissed
      ? Math.max(0, Math.ceil((beAtStopMs - nowTick) / 60_000))
      : null;
  const vehicleEtaText =
    firstBoardingStep?.trafficType === 1
      ? metroLive == null
        ? "정보 로딩중"
        : metroLive.status === "error"
          ? "불러오기 실패"
          : metroLive.status === "no_service"
            ? "도착 예정 정보 없음"
            : vehicleMinUntil == null || vehicleMinUntil <= 0
              ? "곧 도착 예정"
              : `${vehicleMinUntil}분 뒤 도착 예정`
      : firstBoardingStep?.trafficType === 2
        ? busLive == null
          ? "정보 로딩중"
          : busLive.status === "error"
            ? "불러오기 실패"
            : busLive.status === "no_service"
              ? "도착 예정 정보 없음"
              : vehicleMinUntil == null || vehicleMinUntil <= 0
                ? "곧 도착 예정"
                : `${vehicleMinUntil}분 뒤 도착 예정`
        : null;

  const countdownMs =
    futureLeaveOk && leaveAtMs != null
      ? leaveAtMs - nowTick
      : immediateLeaveNeeded
        ? 0
        : null;

  const leaveHeadline =
    futureLeaveOk && leaveAtMs != null
      ? formatKoreanTime(new Date(leaveAtMs))
      : immediateLeaveNeeded
        ? "지금 바로 나가세요"
        : null;

  const leaveSubline =
    futureLeaveOk && leaveAtMs != null
      ? "에 나가면 됩니다"
      : immediateLeaveNeeded
        ? "도보 시간을 맞추려면 지금 출발하세요"
        : null;

  const googleTimeMissingHint =
    selectedIdx != null &&
    paths[selectedIdx] &&
    pathHasTransit(paths[selectedIdx].raw) &&
    firstBoardingStep &&
    firstBoardingStep.transitDepartureTimeMs == null
      ? "탑승 예정 시각을 불러오지 못했습니다. 아래 구간 소요만 참고해 주세요."
      : null;
  const selectedPath = selectedIdx != null && paths[selectedIdx] ? paths[selectedIdx] : null;

  if (!authReady) {
    return (
      <div className={`min-h-full w-full flex items-center justify-center bg-[#F5F5F5] ${atozLight.className}`}>
        <p className="text-sm text-[#888]">로그인 확인 중…</p>
      </div>
    );
  }

  return (
    <div className={`min-h-full w-full flex justify-center bg-[#F5F5F5] text-[#1A1A1A] ${atozLight.className}`}>
      <div
        className={`w-full max-w-[375px] px-4 pt-6 ${selectedPath ? "pb-56" : "pb-6"} flex flex-col gap-4`}
      >
        <header className="space-y-1 text-center">
          <h1 className={`text-[34px] leading-tight ${peaceBold.className}`}>출발해라!</h1>
          <p className="text-xs text-[#888]">당신의 택시비를 아껴드립니다</p>
        </header>

        <section className="rounded-[12px] bg-white border border-black/10 p-3 space-y-2 relative">
          <div className="relative space-y-3">
            <div className="absolute left-1.5 top-6 bottom-10 border-l border-dashed border-[#C8D5E2]" />
            <div className="relative">
              <div className="flex items-center gap-2 mb-1">
                <span className="h-2 w-2 rounded-full bg-[#378ADD]" />
                <span className="text-xs text-[#888]">출발지</span>
              </div>
              <AddressFieldWithPlaces
                id="origin-input"
                label=""
                placeholder="예: 서울시 강남구 테헤란로 123"
                value={originText}
                onManualChange={(v) => {
                  setOriginText(v);
                  setOriginDoc(null);
                  setRegion("unknown");
                }}
                onPickDescription={pickOrigin}
              />
            </div>
            <div className="relative">
              <div className="flex items-center gap-2 mb-1">
                <span className="h-2 w-2 rounded-full bg-[#E0373D]" />
                <span className="text-xs text-[#888]">목적지</span>
              </div>
              <AddressFieldWithPlaces
                id="dest-input"
                label=""
                placeholder="예: 경기도 성남시 분당구 정자동"
                value={destText}
                onManualChange={(v) => {
                  setDestText(v);
                  setDestDoc(null);
                }}
                onPickDescription={pickDest}
              />
            </div>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void searchRoutes()}
            className="w-full rounded-[8px] bg-[#378ADD] hover:bg-[#2f79c2] disabled:opacity-60 text-white font-semibold py-2.5 text-sm transition-colors"
          >
            {loading ? "검색 중…" : "경로 검색"}
          </button>
          {infoMsg ? <p className="text-xs text-[#888]">{infoMsg}</p> : null}
        </section>

        {err ? <p className="text-center text-sm text-red-600">{err}</p> : null}

        <section className="space-y-3">
          {paths.map((p, i) => {
            const totalDur = Math.max(1, p.raw.info.totalDurationSec ?? p.totalTimeMin * 60);
            const barPath = mergeAdjacentWalkStepsForBar(p.raw.subPath);
            const barPcts = computeProgressPercents(barPath, totalDur);
            const orderedLines = getTransitLinesInBoardingOrder(p.raw);
            return (
              <div
                key={`${buildRouteStorageKey(originText, destText, p.raw.subPath)}-${i}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedIdx(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedIdx(i);
                  }
                }}
                className={`w-full overflow-hidden rounded-[12px] border bg-white p-3 text-left ${
                  selectedIdx === i ? "border-[1.5px] border-[#378ADD]" : "border-black/10"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="whitespace-nowrap text-[20px] font-bold leading-none">
                      {formatDurationHourMin(p.totalTimeMin)}
                    </p>
                    <p className="mt-1 text-xs text-[#888]">
                      {formatKoreanTime(new Date(Date.now() + p.totalTimeMin * 60 * 1000))} 도착
                    </p>
                  </div>
                  <div className="flex min-w-0 max-w-[56%] flex-col items-end gap-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        title="즐겨찾기"
                        aria-label="즐겨찾기"
                        className={`text-[18px] leading-none ${
                          isRouteFavorite(originText, destText, p.raw.subPath)
                            ? "text-[#E0A100]"
                            : "text-zinc-300"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleRouteFavorite({
                            origin: originText,
                            destination: destText,
                            subPath: p.raw.subPath,
                            label: `${formatDurationHourMin(p.totalTimeMin)} · ${p.busSummary}`,
                          });
                          setPrefsTick((t) => t + 1);
                        }}
                      >
                        ★
                      </button>
                      <div onClick={(e) => e.stopPropagation()}>
                        <RouteAlertSwitch
                          enabled={isRouteAlertOn(originText, destText, p.raw.subPath)}
                          onChange={(next) => {
                            const k = buildRouteStorageKey(originText, destText, p.raw.subPath);
                            if (next) void requestNotifPermission();
                            setRouteAlertOn(k, next);
                            setPrefsTick((t) => t + 1);
                          }}
                        />
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-wrap justify-end gap-1">
                    {orderedLines.map((item) => (
                      <span
                        key={item.key}
                        className={`inline-flex max-w-full items-center truncate whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          item.trafficType === 1
                            ? getSubwayBadgeClass(item.lineName)
                            : getBusBadgeClass(item.lineName, region)
                        }`}
                      >
                        {item.lineName}
                      </span>
                    ))}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex w-full items-end gap-1 overflow-hidden">
                  {barPath.map((st, si) => {
                    const segMin = Math.max(1, Math.round((st.sectionDurationSec ?? st.sectionTime * 60) / 60));
                    const nm =
                      (st.lane?.[0]?.busNo ?? "").trim() ||
                      (st.trafficType === 1 ? "지하철" : st.trafficType === 2 ? "버스" : "");
                    const badgeForBar =
                      st.trafficType === 2
                        ? getBusBadgeClass(nm, region)
                        : st.trafficType === 1
                          ? getSubwayBadgeClass(nm)
                          : "bg-[#BDBDBD] text-white";
                    const barBgClass =
                      st.trafficType === 3
                        ? "bg-[#BDBDBD]"
                        : extractBgAndTextFromBadgeClass(badgeForBar).bgClass;
                    const wPct = barPcts[si] ?? 0;
                    return (
                      <div
                        key={`prog-${si}`}
                        className="flex min-w-0 flex-col items-center"
                        style={{ flex: `0 1 ${wPct}%` }}
                      >
                        <span className="mb-1 whitespace-nowrap text-[10px] text-[#888]">{segMin}분</span>
                        <div className={`h-[6px] w-full rounded-[3px] ${barBgClass}`} />
                      </div>
                    );
                  })}
                </div>

                <div className="mt-3 text-xs text-[#888]">
                  {p.raw.info.firstStartStation} → {p.raw.info.lastEndStation}
                </div>
              </div>
            );
          })}
        </section>
      </div>

      {selectedPath ? (
        <section
          className="fixed left-1/2 z-40 w-full max-w-[375px] -translate-x-1/2 px-4"
          style={{ bottom: "calc(4rem + env(safe-area-inset-bottom, 0px) + 8px)" }}
        >
          <div
            className="overflow-y-auto rounded-[12px] border border-black/10 bg-white p-4 shadow-md"
            style={{ maxHeight: "calc(100vh - (4rem + env(safe-area-inset-bottom, 0px)) - 110px)" }}
          >
            <div className="flex justify-end">
              <button
                type="button"
                aria-label="출발 안내 닫기"
                onClick={() => setSelectedIdx(null)}
                className="rounded-[8px] border border-black/10 px-2 py-0.5 text-xs text-[#666]"
              >
                ˅
              </button>
            </div>
            <p className="mt-1 whitespace-nowrap text-[28px] font-bold text-[#378ADD] leading-none">{leaveHeadline ?? "계산 중"}</p>
            <p className="mt-1 text-xs text-[#888]">{leaveSubline ?? "출발 시각 계산 중"}</p>
            <p className="mt-2 text-xs text-[#888]">
              {firstBoardingStep?.trafficType === 1 ? "탑승 지하철역" : "탑승 정류장"}까지 도보 약 {displayWalkMin}분 ({displayWalkMeters}m)
            </p>
            <div className="my-3 border-t border-black/10" />
            <p className="text-[18px] font-bold">
              {countdownMs == null
                ? "도착 예정 계산 중"
                : countdownMs <= 0
                  ? "지금 출발하면 탑승 가능"
                  : `${Math.max(0, Math.ceil(countdownMs / 60_000))}분 후 출발하면 탑승 가능`}
            </p>
            {googleTimeMissingHint ? <p className="mt-2 text-[11px] text-[#888]">{googleTimeMissingHint}</p> : null}
            {vehicleEtaText != null ? (
              <p className="mt-1 text-[12px] text-[#5A6470] font-medium">
                버스/지하철 도착 예정 시간: {vehicleEtaText}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

