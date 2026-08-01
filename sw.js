// ============================================================
//  슬라임 머지 디펜스 — 서비스워커 (Phase 4 PWA)
//  전략: 캐시 우선(cache-first) + 미스 시 네트워크 → 캐시 저장
//  CACHE_VERSION 문자열을 올리면 새 캐시로 교체되고 구 캐시는 전부 삭제된다.
//  (= 배포 후 버전만 올리면 업데이트가 영구히 막히지 않는다)
// ============================================================
"use strict";

const CACHE_VERSION = "smd-v4.0.0";
// './' 도 함께 캐싱해야 start_url(디렉터리 루트) 오프라인 진입이 된다
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon.svg"];

// ---------- 설치: 정적 자산 프리캐시 ----------
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.all(ASSETS.map((u) => {
        // { cache: "reload" } — HTTP 캐시를 우회해 버전업 직후에도 항상 최신 자산을 담는다
        const req = new Request(u, { cache: "reload" });
        // 핵심 문서(index.html, './')는 실패 시 설치 자체를 실패시켜 불완전 캐시를 막는다
        const critical = u === "./" || u === "./index.html";
        return cache.add(req).catch((err) => { if (critical) throw err; });
      })))
      .then(() => self.skipWaiting())
  );
});

// ---------- 활성화: 구 버전 캐시 청소 ----------
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE_VERSION ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});

// ---------- 페치: 캐시 우선 ----------
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                        // GET 외에는 관여하지 않음
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;         // 외부 도메인은 그대로 통과
  if (url.search) return;                                  // ?v=... 같은 캐시버스터는 항상 네트워크

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // 정상 응답만 캐시에 적재 (opaque/에러 응답은 저장하지 않는다)
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => {
        // 오프라인 폴백: 문서 요청이면 캐시된 index.html 로
        if (req.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      });
    })
  );
});

// ---------- 페이지에서 즉시 업데이트를 요청할 때 ----------
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
