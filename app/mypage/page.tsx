"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import localFont from "next/font/local";
import { useRouter } from "next/navigation";
import {
  getAlertThresholdsMinutes,
  getRouteAlertOnMap,
  getRouteFavorites,
  listActiveAlertRouteKeys,
  setAlertThresholdsMinutes,
  setRouteFavorites,
  type RouteFavoriteEntry,
} from "@/lib/user-storage";
import { getSupabaseClient } from "@/lib/supabase-client";

const atozLight = localFont({
  src: "../../public/fonts/atoz-3Light.ttf",
  display: "swap",
});

export default function MyPage() {
  const router = useRouter();
  const [thresholdsStr, setThresholdsStr] = useState("");
  const [favorites, setFavorites] = useState<RouteFavoriteEntry[]>([]);
  const [alertKeys, setAlertKeys] = useState<string[]>([]);
  const [openSettings, setOpenSettings] = useState(false);
  const [openFavorites, setOpenFavorites] = useState(false);
  const [openAlerts, setOpenAlerts] = useState(false);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [authName, setAuthName] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const refreshLocal = useCallback(() => {
    setThresholdsStr(getAlertThresholdsMinutes().join(", "));
    setFavorites(getRouteFavorites());
    setAlertKeys(listActiveAlertRouteKeys());
  }, []);

  useEffect(() => {
    refreshLocal();
  }, [refreshLocal]);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    const hydrate = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      setAuthEmail(session?.user?.email ?? null);
      const nm = session?.user?.user_metadata?.full_name ?? session?.user?.user_metadata?.name;
      setAuthName(typeof nm === "string" ? nm : null);
      setAuthReady(true);
      const prefs = session?.user?.user_metadata?.busAlarmPrefs as
        | { favorites?: RouteFavoriteEntry[]; alertThresholds?: number[] }
        | undefined;
      if (prefs?.favorites && Array.isArray(prefs.favorites)) setRouteFavorites(prefs.favorites);
      if (prefs?.alertThresholds && Array.isArray(prefs.alertThresholds)) {
        setAlertThresholdsMinutes(prefs.alertThresholds);
      }
      refreshLocal();
    };
    void hydrate();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthEmail(session?.user?.email ?? null);
      const nm = session?.user?.user_metadata?.full_name ?? session?.user?.user_metadata?.name;
      setAuthName(typeof nm === "string" ? nm : null);
      setAuthReady(true);
      refreshLocal();
    });
    return () => listener.subscription.unsubscribe();
  }, [refreshLocal]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (
        e.key === "bus_alarm_route_favorites_v1" ||
        e.key === "bus_alarm_route_alert_on_v1" ||
        e.key === "bus_alarm_alert_thresholds_min"
      ) {
        refreshLocal();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshLocal]);

  const signOut = async () => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    await supabase.auth.signOut();
    setAuthEmail(null);
  };

  const alertKeyLabels = useMemo(() => {
    const favByKey = new Map(favorites.map((f) => [f.key, f]));
    const onMap = getRouteAlertOnMap();
    return alertKeys.map((key) => {
      const fav = favByKey.get(key);
      if (fav) return { key, label: fav.label };
      const parts = key.split("|");
      const o = parts[0] ?? "";
      const d = parts[1] ?? "";
      return { key, label: o && d ? `${o} → ${d}` : key };
    });
  }, [alertKeys, favorites]);

  const syncCloudPrefs = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (!supabase) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.auth.updateUser({
      data: {
        ...(user.user_metadata ?? {}),
        busAlarmPrefs: {
          favorites: getRouteFavorites(),
          alertOnMap: getRouteAlertOnMap(),
          alertThresholds: getAlertThresholdsMinutes(),
        },
      },
    });
  }, []);

  const saveSettings = () => {
    const parts = thresholdsStr.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const nums = parts
      .map((p) => Number(p))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length > 0) setAlertThresholdsMinutes([...new Set(nums)].sort((a, b) => b - a));
    refreshLocal();
    void syncCloudPrefs();
  };

  const removeFavorite = (key: string) => {
    setRouteFavorites(getRouteFavorites().filter((f) => f.key !== key));
    refreshLocal();
    void syncCloudPrefs();
  };

  useEffect(() => {
    if (!authReady) return;
    if (!authEmail) router.replace("/signin");
  }, [authReady, authEmail, router]);

  if (!authReady) {
    return (
      <div className={`min-h-full w-full flex items-center justify-center bg-[#F5F5F5] ${atozLight.className}`}>
        <p className="text-sm text-[#888]">로그인 확인 중…</p>
      </div>
    );
  }

  return (
    <div className={`min-h-full w-full flex justify-center bg-[#F5F5F5] text-[#1A1A1A] ${atozLight.className}`}>
      <div className="w-full max-w-[375px] px-4 py-6 flex flex-col gap-4">
        <header className="text-center">
          <h1 className="text-xl font-bold">마이페이지</h1>
          <p className="text-xs text-[#888] mt-1">
            설정·알림·즐겨찾기 노선을 관리합니다.
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-[8px] border border-black/10 bg-white px-3 py-1 text-xs"
            >
              {authEmail} · 로그아웃
            </button>
          </div>
        </header>

        <section className="rounded-[12px] bg-white shadow-sm border border-black/10">
          <button
            type="button"
            onClick={() => setOpenSettings((v) => !v)}
            className="w-full px-4 py-3 flex items-center justify-between text-left"
          >
            <h2 className="text-sm font-semibold">설정</h2>
            <span className="text-xs text-[#888]">{openSettings ? "접기" : "펼치기"}</span>
          </button>
          {openSettings ? (
            <div className="px-4 pb-4 space-y-3 border-t border-black/10">
              <div className="pt-3">
                <p className="text-xs text-[#888]">Google 계정</p>
                <p className="text-sm font-semibold mt-1">{authName ?? "이름 정보 없음"}</p>
                <p className="text-xs text-[#888] mt-0.5">{authEmail}</p>
              </div>
              <label className="block text-xs text-[#888] mt-2">
                출발 알림 (분 단위, 쉼표로 구분) — 기본 60,30,15,10,5
              </label>
              <input
                type="text"
                value={thresholdsStr}
                onChange={(e) => setThresholdsStr(e.target.value)}
                placeholder="60, 30, 15, 10, 5"
                className="w-full rounded-[8px] border border-black/10 bg-white px-3 py-2 text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => saveSettings()}
                className="w-full rounded-[8px] bg-[#378ADD] hover:bg-[#2f79c2] text-white font-semibold py-2.5 text-sm"
              >
                설정 저장
              </button>
            </div>
          ) : null}
        </section>

        <section className="rounded-[12px] bg-white shadow-sm border border-black/10">
          <button
            type="button"
            onClick={() => setOpenAlerts((v) => !v)}
            className="w-full px-4 py-3 flex items-center justify-between text-left"
          >
            <h2 className="text-sm font-semibold">알림 설정한 노선</h2>
            <span className="text-xs text-[#888]">{openAlerts ? "접기" : "펼치기"}</span>
          </button>
          {openAlerts ? (
            <div className="px-4 pb-4 border-t border-black/10">
              {alertKeyLabels.length === 0 ? (
                <p className="text-sm text-[#888] pt-3">홈에서 노선 카드의 알림을 켜면 여기에 표시됩니다.</p>
              ) : (
                <ul className="space-y-2 pt-3">
                  {alertKeyLabels.map(({ key, label }) => {
                    const fromLabel = label.split("→").map((v) => v.trim());
                    const fromKey = key.split("|");
                    const origin = (fromLabel[0] || fromKey[0] || "").trim();
                    const destination = (fromLabel[1] || fromKey[1] || "").trim();
                    return (
                      <li
                        key={key}
                        className="rounded-[8px] border border-[#D5E7F8] bg-[#F3F9FF] px-3 py-2 text-sm"
                      >
                        <p className="text-xs text-[#5A6470]">출발지: {origin || "-"}</p>
                        <p className="text-center text-sm leading-tight text-[#5A6470]">↓</p>
                        <p className="text-xs text-[#5A6470]">목적지: {destination || "-"}</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </section>

        <section className="rounded-[12px] bg-white shadow-sm border border-black/10">
          <button
            type="button"
            onClick={() => setOpenFavorites((v) => !v)}
            className="w-full px-4 py-3 flex items-center justify-between text-left"
          >
            <h2 className="text-sm font-semibold">즐겨찾기 노선</h2>
            <span className="text-xs text-[#888]">{openFavorites ? "접기" : "펼치기"}</span>
          </button>
          {openFavorites ? (
            <div className="px-4 pb-4 border-t border-black/10">
              {favorites.length === 0 ? (
                <p className="text-sm text-[#888] pt-3">홈에서 노선별 저장 버튼으로 추가할 수 있습니다.</p>
              ) : (
                <ul className="space-y-2 pt-3">
                  {favorites.map((f) => (
                    <li
                      key={f.key}
                      className="flex flex-wrap items-center gap-2 rounded-[8px] border border-black/10 px-3 py-2 text-sm"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{f.label}</p>
                        <p className="text-xs text-[#888] truncate">
                          {f.origin} → {f.destination}
                        </p>
                      </div>
                      <Link
                        href={`/?origin=${encodeURIComponent(f.origin)}&dest=${encodeURIComponent(f.destination)}`}
                        className="shrink-0 rounded-[8px] bg-[#EEF3F8] px-2 py-1 text-xs font-medium"
                      >
                        길찾기
                      </Link>
                      <button
                        type="button"
                        onClick={() => removeFavorite(f.key)}
                        className="shrink-0 text-xs text-red-600 dark:text-red-400"
                      >
                        삭제
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </section>

        <p className="text-center text-xs text-[#888] pb-2">
          브라우저 알림은 홈에서 노선 알림을 켤 때 권한을 요청합니다.
        </p>
      </div>
    </div>
  );
}
