"use client";

import { useEffect, useState } from "react";
import localFont from "next/font/local";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase-client";

const peaceBold = localFont({
  src: "../../public/fonts/PyeongChangPeace-Bold.ttf",
  display: "swap",
});

const atozLight = localFont({
  src: "../../public/fonts/atoz-3Light.ttf",
  display: "swap",
});

export default function SignInPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [authErr, setAuthErr] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setChecking(false);
      return;
    }
    const boot = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.user) {
        router.replace("/");
        return;
      }
      setChecking(false);
    };
    void boot();
  }, [router]);

  const signInWithGoogle = async () => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setAuthErr("Supabase 설정이 없어 로그인할 수 없습니다.");
      return;
    }
    setAuthErr(null);
    const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/` : undefined;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) {
      if (error.message.includes("Unsupported provider")) {
        setAuthErr("Google 로그인 제공자가 비활성화되어 있습니다. Supabase 대시보드에서 Google Provider를 활성화해 주세요.");
      } else {
        setAuthErr(`로그인 실패: ${error.message}`);
      }
    }
  };

  return (
    <div
      className={`w-full min-h-[100dvh] flex items-center justify-center bg-[#F5F5F5] text-[#1A1A1A] ${atozLight.className}`}
    >
      <div className="w-full max-w-[375px] px-4 py-6">
        <div className="rounded-[12px] border border-black/10 bg-white p-5 text-center space-y-3 shadow-sm">
          <h1 className={`text-[32px] leading-tight ${peaceBold.className}`}>출발해라!</h1>
          <p className="text-xs text-[#888]">Google 로그인 후 택시비를 아끼세요.</p>
          {authErr ? <p className="text-xs text-red-600">{authErr}</p> : null}
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            disabled={checking}
            className="w-full rounded-[8px] bg-[#378ADD] py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {checking ? "확인 중…" : "Google로 로그인"}
          </button>
        </div>
      </div>
    </div>
  );
}

