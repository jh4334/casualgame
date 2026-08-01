# Phase 4 구현 명세 — 확장 & 공유

대상: `/home/user/casualgame/` (index.html + 신규 파일들)
원칙: GitHub Pages 정적 호스팅에서 동작해야 함. 외부 백엔드/유료 서비스 금지.
(온라인 리더보드는 백엔드 필요로 이번 범위에서 제외 — 로컬 랭킹으로 대체)

## 4-1. PWA 전환

1. `manifest.json` 신규 생성: name "슬라임 머지 디펜스", short_name "슬라임머지", display standalone, orientation portrait, theme_color `#a8cc3e`, background_color `#2a3d1f`, start_url `.`.
2. 앱 아이콘: 외부 파일 대신 **SVG data URI 아이콘** 혹은 `icon.svg` 파일 생성(캔버스 스타일 슬라임 그림). manifest icons에 등록 (192/512 사이즈는 svg 하나로 대체 가능, `purpose: any`).
3. `sw.js` 서비스워커: 캐시 우선(cache-first) 전략으로 `index.html`, `manifest.json`, `icon.svg` 캐싱. 버전 문자열로 캐시 무효화. `index.html`에서 등록 (`navigator.serviceWorker.register`, https/localhost 가드).
4. `<head>`에 manifest 링크, theme-color 메타, apple-touch-icon 추가.

## 4-2. 일일 도전 모드

1. 타이틀에 "📅 일일 도전" 버튼 → 일반 모드와 분리된 런 시작.
2. 시드 고정 RNG: `mulberry32(seed)` 구현, 시드 = `YYYYMMDD` 정수. 일일 모드에서는 게임 내 모든 `Math.random()` 호출을 시드 RNG로 치환할 수 있도록 `rng()` 헬퍼 도입 (일반 모드에서는 Math.random 위임).
   - 대상: 뽑기, 스폰 위치/타입, 대박 판정, 카드 제시 등 게임플레이 랜덤 전부. (파티클 등 순수 연출은 Math.random 유지 허용)
3. 일일 모드는 메타 영구 강화 효과 **미적용** (공정성), 별조각 획득은 절반.
4. 결과 화면에 "오늘의 기록" 표시 + 날짜. `localStorage 'smd_daily'`: `{ date, bestWave }` — 같은 날 재도전 가능하되 기록은 최고치만.
5. "결과 복사" 버튼: `슬라임 머지 디펜스 일일도전 YYYY-MM-DD — 웨이브 N 도달! 🌈` 클립보드 복사 (navigator.clipboard, 실패 시 무시).

## 4-3. 로컬 랭킹 보드

1. `localStorage 'smd_records'`: 최근 런 기록 배열 (최대 10개): `{date, wave, kills, peakTier, daily}`.
2. 게임 오버 시 push (웨이브 내림차순 정렬 유지, 10개 초과 시 절삭).
3. 타이틀 "🏆 기록실" 버튼 → 오버레이: 순위 / 웨이브 / 최고등급 이모지 / 날짜 / (일일 뱃지). 뒤로 버튼.

## 4-4. CI (GitHub Actions)

1. `.github/workflows/ci.yml` 생성:
   - trigger: push(main), pull_request.
   - Ubuntu, Node 20, `npx playwright install chromium --with-deps`.
   - 스모크 테스트 스크립트 `tests/smoke.mjs` 실행.
2. `tests/smoke.mjs` 신규: playwright로 index.html 로드 → 타이틀 → 시작 → 10초 빨리감기(update 직접 호출) → 구매/합성 1회 → pageerror 0건 검증. 실패 시 exit 1.
   - 로컬 개발환경(이 세션)의 chromium 경로와 CI 경로 차이 대응: `PLAYWRIGHT_BROWSERS_PATH`/기본 launch 모두 시도.

## 검증 기준 (리뷰어 체크리스트)

1. sw.js 캐시 전략이 업데이트를 영구 차단하지 않는가 (버전 갱신 시 새 캐시로 교체 + 구 캐시 삭제)
2. rng() 도입이 일반 모드 동작을 바꾸지 않는가 (일반 모드 = Math.random 경로)
3. 일일 모드에서 메타 효과가 실제로 차단되는가, 별조각 절반 지급인가
4. 날짜 시드가 로컬 타임존 기준으로 일관적인가
5. 랭킹 push가 게임 오버 1회당 정확히 1개인가
6. manifest/sw 등록 코드가 file:// 로컬 실행을 깨뜨리지 않는가 (가드)
7. CI yml 문법 유효, 스모크 테스트가 실제 결함 시 실패하는가
8. Phase 1~3 및 기존 기능 파손 없음, JS 오류 0건
