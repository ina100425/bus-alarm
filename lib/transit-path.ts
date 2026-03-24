/** 대중교통 구간 시그니처(경로 중복 제거·로컬 저장 키용) */
export type TransitLegSlice = {
  trafficType: number;
  lane?: { busNo?: string }[];
  startName: string;
  endName: string;
};

export function transitLegSignature(
  subPath: TransitLegSlice[],
  noTransit?: { totalTimeMin: number; totalDurationSec?: number },
): string {
  const legs = subPath.filter((s) => s.trafficType === 1 || s.trafficType === 2);
  if (legs.length === 0) {
    if (noTransit) {
      return `no-transit:${noTransit.totalTimeMin}:${noTransit.totalDurationSec ?? 0}`;
    }
    return "no-transit";
  }
  return legs
    .map((s) => {
      const line = (s.lane?.[0]?.busNo ?? "").trim() || "-";
      return `${s.trafficType}:${line}:${s.startName.trim()}:${s.endName.trim()}`;
    })
    .join("||");
}

export function buildRouteStorageKey(
  origin: string,
  destination: string,
  subPath: TransitLegSlice[],
): string {
  return `${origin.trim()}|${destination.trim()}|${transitLegSignature(subPath)}`;
}

type WalkStep = {
  trafficType: number;
  sectionTime: number;
  sectionDurationSec?: number;
};

/** 첫 탑승 전 도보 구간의 실제 초 합(Google staticDuration 기준) */
export function getWalkSecondsBeforeFirstBoarding(subPath: WalkStep[]): number {
  let sumSec = 0;
  for (const s of subPath) {
    if (s.trafficType === 1 || s.trafficType === 2) break;
    if (s.trafficType === 3) {
      const sec =
        typeof s.sectionDurationSec === "number" && s.sectionDurationSec > 0
          ? s.sectionDurationSec
          : Math.max(0, s.sectionTime) * 60;
      sumSec += sec;
    }
  }
  return sumSec;
}

/**
 * 출발 시각 계산용: 도보 초 합을 분으로 올림(실제보다 짧게 잡아 늦게 나가는 것 방지).
 * 도보가 없으면 0.
 */
export function getWalkMinutesBeforeFirstBoarding(subPath: WalkStep[]): number {
  const sec = getWalkSecondsBeforeFirstBoarding(subPath);
  if (sec <= 0) return 0;
  return Math.max(1, Math.ceil(sec / 60));
}

/** Google이 도보를 짧은 step 여러 개로 쪼개는 경우 진행바·비율 계산용으로 인접 도보만 합칩니다. */
export type MergedWalkSlice = WalkStep & {
  trafficType: number;
  distance: number;
  sectionTime: number;
  sectionDurationSec?: number;
  startName: string;
  endName: string;
  startX: number;
  startY: number;
  startID: number;
  endID: number;
  lane?: { busNo?: string; busLocalBlID?: string; seoulBusRouteId?: string; type?: number }[];
};

export function mergeAdjacentWalkStepsForBar<T extends MergedWalkSlice>(subPath: T[]): T[] {
  const out: T[] = [];
  let buf: T | null = null;

  const secOf = (s: T): number =>
    Math.max(1, s.sectionDurationSec ?? Math.max(1, s.sectionTime) * 60);

  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = null;
    }
  };

  for (const st of subPath) {
    if (st.trafficType === 3) {
      if (!buf) {
        const sc = secOf(st);
        buf = {
          ...st,
          distance: Math.max(0, st.distance),
          sectionDurationSec: sc,
          sectionTime: Math.max(1, Math.round(sc / 60)),
        };
      } else {
        const prev: T = buf;
        const sumSec: number = secOf(prev) + secOf(st);
        buf = {
          ...prev,
          distance: Math.max(0, prev.distance) + Math.max(0, st.distance),
          sectionDurationSec: sumSec,
          sectionTime: Math.max(1, Math.round(sumSec / 60)),
          endName: st.endName,
          endID: st.endID,
        };
      }
    } else {
      flush();
      out.push(st);
    }
  }
  flush();
  return out;
}
