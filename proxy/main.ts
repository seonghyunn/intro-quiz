// 1초 노래 맞추기 — iTunes 검색 슬림 중계 서버 (Deno Deploy)
// 애플 응답(200곡 약 300KB)에서 게임에 필요한 필드만 남겨 ~30KB로 줄여 전달한다.
// 느린 모바일 네트워크에서도 전체 곡 목록을 빠르게 받을 수 있게 하는 용도.
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname !== "/search") {
    return new Response("intro-quiz slim itunes proxy", { status: 200 });
  }
  try {
    const upstream = "https://itunes.apple.com/search" + url.search;
    const r = await fetch(upstream, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; intro-quiz/1.0)" },
    });
    if (!r.ok) {
      return json({ error: "upstream", status: r.status }, 502);
    }
    const d = await r.json();
    const results = (d.results || []).map((t: Record<string, unknown>) => ({
      trackId: t.trackId,
      trackName: t.trackName,
      artistId: t.artistId,
      artistName: t.artistName,
      previewUrl: t.previewUrl,
      artworkUrl100: t.artworkUrl100,
      releaseDate: t.releaseDate,
      primaryGenreName: t.primaryGenreName,
      collectionId: t.collectionId,
      collectionName: t.collectionName,
      copyright: t.copyright,       // entity=album 조회 시 발매 레이블 판별용
      wrapperType: t.wrapperType,
    }));
    return json({ resultCount: results.length, results }, 200);
  } catch (_e) {
    return json({ error: "fetch-failed" }, 502);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
    },
  });
}
// build trigger
