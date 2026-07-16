// 1초 노래 맞추기 — API 서버 (Deno Deploy)
// /search   : iTunes 검색 슬림 중계 (필요 필드만 남겨 응답 축소)
// /feedback : 사용자 의견 저장 (POST)
// /track    : 방문·체류시간 기록 (POST)
// /admin    : 관리자 대시보드 데이터 (key 필요 — 코드에는 SHA-256 해시만 보관)
const ADMIN_HASH = "2aa116a11e048e5815c75f2b97e6466945d89e4aaec259ce671df7dccd43753c";

// KV는 지연 초기화 — 혹시 KV를 못 열어도 /search(게임 검색)는 영향받지 않게 한다
let kvPromise: Promise<Deno.Kv> | null = null;
function getKv(): Promise<Deno.Kv> {
  if (!kvPromise) kvPromise = Deno.openKv();
  return kvPromise;
}

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
function json(body: unknown, status: number, cacheable = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheable ? "public, max-age=3600" : "no-store",
      ...corsHeaders(),
    },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ---------- iTunes 검색 슬림 중계 ----------
  if (url.pathname === "/search") {
    try {
      const upstream = "https://itunes.apple.com/search" + url.search;
      const r = await fetch(upstream, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; intro-quiz/1.0)" },
      });
      if (!r.ok) return json({ error: "upstream", status: r.status }, 502);
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
      return json({ resultCount: results.length, results }, 200, true);
    } catch (_e) {
      return json({ error: "fetch-failed" }, 502);
    }
  }

  // ---------- 사용자 피드백 저장 ----------
  if (url.pathname === "/feedback" && req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      const text = String(body.text || "").trim().slice(0, 2000);
      if (!text) return json({ ok: false, error: "empty" }, 400);
      const kv = await getKv();
      await kv.set(["fb", Date.now()], {
        text,
        ts: new Date().toISOString(),
        ua: (req.headers.get("user-agent") || "").slice(0, 160),
      });
      return json({ ok: true }, 200);
    } catch (_e) {
      return json({ ok: false }, 400);
    }
  }

  // ---------- 방문·체류시간 기록 ----------
  if (url.pathname === "/track" && req.method === "POST") {
    try {
      const body = JSON.parse(await req.text());
      const day = new Date().toISOString().slice(0, 10);
      const rid = () => Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      const kv = await getKv();
      if (body.type === "visit") {
        const sid = String(body.sid || "").slice(0, 40);
        if (sid) await kv.set(["visit", day, sid], 1);
      } else if (body.type === "leave") {
        const dur = Math.min(7200, Math.max(1, Math.round(Number(body.dur) || 0)));
        if (dur > 0) await kv.set(["dwell", day, rid()], dur);
      } else if (body.type === "q") {
        // 문제 1개가 끝날 때의 게임 행동 지표
        await kv.set(["q", day, rid()], {
          plays: Math.min(99, Math.max(0, Math.round(Number(body.plays) || 0))),
          hint: body.hint ? 1 : 0,
          wrongs: Math.min(99, Math.max(0, Math.round(Number(body.wrongs) || 0))),
          dur: Math.min(5, Math.max(0.5, Number(body.dur) || 1)),
          result: body.result === "correct" ? "correct" : "giveup",
        });
      } else if (body.type === "start") {
        // 게임 시작 시 선택한 가수들
        const names = Array.isArray(body.artists)
          ? body.artists.slice(0, 10).map((s: unknown) => String(s).slice(0, 60)).filter(Boolean)
          : [];
        if (names.length) await kv.set(["astart", day, rid()], names);
      }
      return json({ ok: true }, 200);
    } catch (_e) {
      return json({ ok: false }, 400);
    }
  }

  // ---------- 관리자 대시보드 데이터 ----------
  if (url.pathname === "/admin") {
    const key = url.searchParams.get("key") || "";
    if ((await sha256(key)) !== ADMIN_HASH) {
      return json({ ok: false, error: "unauthorized" }, 403);
    }
    try {
    const kv = await getKv();
    const feedback: unknown[] = [];
    for await (const e of kv.list({ prefix: ["fb"] }, { reverse: true, limit: 200 })) {
      feedback.push(e.value);
    }
    const days: unknown[] = [];
    // 최근 14일 게임 행동 집계
    const q = { n: 0, plays: 0, wrongs: 0, hints: 0, correct: 0 };
    const durDist: Record<string, number> = {};
    const artistCount: Record<string, number> = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      let visitors = 0;
      for await (const _e of kv.list({ prefix: ["visit", d] })) visitors++;
      let sum = 0, n = 0;
      for await (const e of kv.list({ prefix: ["dwell", d] })) {
        sum += e.value as number;
        n++;
      }
      days.push({ date: d, visitors, sessions: n, avgDwellSec: n ? Math.round(sum / n) : 0 });

      for await (const e of kv.list({ prefix: ["q", d] })) {
        const v = e.value as { plays: number; hint: number; wrongs: number; dur: number; result: string };
        q.n++;
        q.plays += v.plays || 0;
        q.wrongs += v.wrongs || 0;
        q.hints += v.hint || 0;
        if (v.result === "correct") q.correct++;
        const dk = String(v.dur);
        durDist[dk] = (durDist[dk] || 0) + 1;
      }
      for await (const e of kv.list({ prefix: ["astart", d] })) {
        for (const name of (e.value as string[])) {
          artistCount[name] = (artistCount[name] || 0) + 1;
        }
      }
    }
    const topArtists = Object.entries(artistCount)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    return json({ ok: true, feedback, days, q, durDist, topArtists }, 200);
    } catch (_e) {
      return json({ ok: false, error: "kv-unavailable" }, 500);
    }
  }

  return new Response("intro-quiz api", { status: 200, headers: corsHeaders() });
});
