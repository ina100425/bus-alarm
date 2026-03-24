import { Suspense } from "react";
import BusAlarmApp from "@/components/BusAlarmApp";

export default function Home() {
  return (
    <Suspense fallback={<div className="flex min-h-[50vh] items-center justify-center text-zinc-500">로딩…</div>}>
      <BusAlarmApp />
    </Suspense>
  );
}
