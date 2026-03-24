"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase-client";

export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const home = pathname === "/";
  const my = pathname === "/mypage";
  const [isAuthed, setIsAuthed] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setIsAuthed(false);
      setAuthReady(true);
      return;
    }
    const hydrate = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      setIsAuthed(Boolean(session?.user));
      setAuthReady(true);
    };
    void hydrate();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAuthed(Boolean(session?.user));
      setAuthReady(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const showBottomNav = authReady && isAuthed && pathname !== "/signin";

  return (
    <>
      <div
        className={`flex-1 flex flex-col min-h-0 ${
          showBottomNav ? "pb-[calc(4rem+env(safe-area-inset-bottom,0px))]" : ""
        }`}
      >
        {children}
      </div>
      {showBottomNav ? (
        <nav
          className="fixed bottom-0 left-0 right-0 z-30 border-t border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          aria-label="하단 메뉴"
        >
          <div className="mx-auto flex max-w-[480px] h-16 items-stretch justify-around text-sm font-medium">
            <Link
              href="/"
              className={`flex flex-1 items-center justify-center ${
                home
                  ? "bg-[#E8F2FC] text-[#378ADD] border-t-2 border-[#378ADD]"
                  : "text-zinc-500 border-t-2 border-transparent"
              }`}
            >
              홈
            </Link>
            <Link
              href="/mypage"
              className={`flex flex-1 items-center justify-center ${
                my
                  ? "bg-[#E8F2FC] text-[#378ADD] border-t-2 border-[#378ADD]"
                  : "text-zinc-500 border-t-2 border-transparent"
              }`}
            >
              마이페이지
            </Link>
          </div>
        </nav>
      ) : null}
    </>
  );
}
