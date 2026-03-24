import { NextResponse } from "next/server";

type GooglePrediction = {
  description: string;
  place_id: string;
};

type GoogleAutocompleteResponse = {
  predictions?: GooglePrediction[];
  status: string;
  error_message?: string;
};

export async function GET(req: Request) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY 미설정", predictions: [] },
      { status: 500 },
    );
  }

  const input = new URL(req.url).searchParams.get("input")?.trim() ?? "";
  if (input.length < 2) return NextResponse.json({ predictions: [] });

  const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  url.searchParams.set("input", input);
  url.searchParams.set("key", key);
  url.searchParams.set("language", "ko");
  url.searchParams.set("components", "country:kr");

  const res = await fetch(url.toString(), { next: { revalidate: 0 } });
  const data = (await res.json()) as GoogleAutocompleteResponse;

  if (!res.ok) {
    return NextResponse.json(
      { error: "Places API HTTP 오류", predictions: [] },
      { status: 502 },
    );
  }

  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    return NextResponse.json(
      { error: data.error_message ?? `Places Autocomplete: ${data.status}`, predictions: [] },
      { status: 200 },
    );
  }

  return NextResponse.json({ predictions: data.predictions ?? [] });
}

