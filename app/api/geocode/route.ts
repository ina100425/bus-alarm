import { NextResponse } from "next/server";

type GoogleAddressComponent = {
  long_name?: string;
  short_name?: string;
  types?: string[];
};

type GoogleGeocodeResult = {
  formatted_address?: string;
  address_components?: GoogleAddressComponent[];
  geometry?: {
    location?: { lat?: number; lng?: number };
  };
};

type GoogleGeocodeResponse = {
  results?: GoogleGeocodeResult[];
  status: string;
  error_message?: string;
};

function getAdministrativeAreaLevel1(components: GoogleAddressComponent[] | undefined): string | null {
  for (const c of components ?? []) {
    const types = c.types ?? [];
    if (types.includes("administrative_area_level_1")) {
      const v = (c.long_name ?? "").trim();
      return v || null;
    }
  }
  return null;
}

export async function POST(req: Request) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY 미설정", documents: [] },
      { status: 500 },
    );
  }

  let address = "";
  try {
    const body = (await req.json()) as { address?: string };
    address = (body.address ?? "").trim();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 올바르지 않습니다", documents: [] }, { status: 400 });
  }

  if (!address) {
    return NextResponse.json({ error: "address가 필요합니다", documents: [] }, { status: 400 });
  }

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", key);
  url.searchParams.set("language", "ko");

  const res = await fetch(url.toString(), { next: { revalidate: 0 } });
  const data = (await res.json()) as GoogleGeocodeResponse;

  if (!res.ok || data.status !== "OK") {
    return NextResponse.json(
      { error: data.error_message ?? "Geocoding 실패", documents: [] },
      { status: 502 },
    );
  }

  const first = data.results?.[0];
  const lat = first?.geometry?.location?.lat;
  const lng = first?.geometry?.location?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return NextResponse.json({ error: "좌표를 응답에서 찾을 수 없습니다", documents: [] }, { status: 502 });
  }

  const region1 = getAdministrativeAreaLevel1(first?.address_components);
  return NextResponse.json({
    documents: [
      {
        x: String(lng),
        y: String(lat),
        address: {
          region_1depth_name: region1 ?? undefined,
          address_name: first?.formatted_address ?? "",
        },
      },
    ],
  });
}

