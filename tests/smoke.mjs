#!/usr/bin/env node
// ============================================================
//  슬라임 머지 디펜스 — 스모크 테스트 (Playwright / Chromium)
//
//  검증 흐름
//   1) 로컬 정적 서버(127.0.0.1)로 index.html 로드 → 타이틀 화면
//   2) 캔버스 클릭으로 게임 시작
//   3) update() 를 직접 호출해 10초 빨리감기
//   4) 무기 구매 1회 + 드래그 합성 1회 (실제 마우스 입력)
//   5) Phase 4 회귀: 시드 RNG / 일일 도전(메타 미적용·별조각 절반) / 로컬 랭킹
//   6) file:// 로도 로드해 서비스워커 가드가 로컬 실행을 깨지 않는지 확인
//   7) 위 전 과정에서 pageerror 0건
//
//  실행 환경
//   - CI      : `npx playwright install chromium` 이 깐 기본 경로 사용
//   - 로컬(이 세션) : /opt/pw-browsers 를 PLAYWRIGHT_BROWSERS_PATH 로 사용하고,
//                    실패하면 executablePath 후보들을 차례로 시도
//  실패 시 exit 1
// ============================================================
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- 결과 집계 ----------
let failed = 0;
function ok(name, extra) { console.log("  ✅ " + name + (extra ? "  (" + extra + ")" : "")); }
function bad(name, msg) { failed++; console.log("  ❌ " + name + " → " + msg); }
function assert(name, cond, msg) { if (cond) ok(name); else bad(name, msg || "조건 불만족"); }
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(name, a); else bad(name, `실제 ${a} / 기대 ${e}`);
}

// ============================================================
//  Playwright 모듈 로딩 (로컬 전역 설치 / CI 로컬 설치 모두 대응)
// ============================================================
const BROWSER_DIRS = ["/opt/pw-browsers"];
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const found = BROWSER_DIRS.find((d) => existsSync(d));
  if (found) process.env.PLAYWRIGHT_BROWSERS_PATH = found;   // import 전에 지정해야 반영된다
}

async function loadPlaywright() {
  const names = ["playwright", "playwright-core"];
  const tried = [];
  // 1) 일반 해석 (CI: 프로젝트 node_modules)
  for (const n of names) {
    try { return { mod: await import(n), from: n }; } catch (e) { tried.push(n); }
  }
  // 2) 전역 설치 경로에서 직접 해석 (ESM 은 NODE_PATH 를 보지 않으므로 수동 탐색)
  const roots = [
    process.env.PLAYWRIGHT_NODE_MODULES,
    path.join(ROOT, "node_modules"),
    path.join(path.dirname(path.dirname(process.execPath)), "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ].filter(Boolean);
  const req = createRequire(path.join(ROOT, "__resolve__.cjs"));
  for (const n of names) {
    for (const r of roots) {
      try {
        const entry = req.resolve(n, { paths: [r] });
        return { mod: await import(pathToFileURL(entry).href), from: entry };
      } catch (e) { /* 다음 후보 */ }
    }
  }
  throw new Error("playwright / playwright-core 를 찾지 못했습니다. 시도: " + tried.join(", "));
}

async function launchChromium(chromium) {
  const args = ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio"];
  const candidates = [];
  if (process.env.PW_CHROMIUM_PATH) candidates.push(process.env.PW_CHROMIUM_PATH);
  candidates.push(null);                          // 기본 경로 (CI)
  candidates.push("/opt/pw-browsers/chromium");   // 로컬 세션 심볼릭 링크
  candidates.push("/opt/pw-browsers/chromium/chrome-linux/chrome");
  const errs = [];
  for (const exe of candidates) {
    if (exe && !existsSync(exe)) continue;
    try {
      const b = await chromium.launch(exe ? { headless: true, args, executablePath: exe } : { headless: true, args });
      return { browser: b, exe: exe || "(기본 경로)" };
    } catch (e) { errs.push((exe || "default") + ": " + e.message.split("\n")[0]); }
  }
  throw new Error("Chromium 실행 실패\n" + errs.join("\n"));
}

// ============================================================
//  최소 정적 서버 (외부 의존 없음)
// ============================================================
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
};
function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (p === "/" || p.endsWith("/")) p += "index.html";
        const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
        if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(body);
      } catch (e) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ============================================================
//  브라우저 헬퍼
// ============================================================
// 게임 좌표(480x840) → 페이지 좌표
async function toPage(page, gx, gy) {
  const m = await page.evaluate(() => {
    const b = document.getElementById("game").getBoundingClientRect();
    return { left: b.left, top: b.top, w: b.width, h: b.height, W: W, H: H };
  });
  return { x: m.left + gx * m.w / m.W, y: m.top + gy * m.h / m.H };
}
async function tapGame(page, gx, gy) {
  const p = await toPage(page, gx, gy);
  await page.mouse.click(p.x, p.y);
}
async function dragGame(page, from, to) {
  const a = await toPage(page, from[0], from[1]);
  const b = await toPage(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

// ============================================================
//  본 테스트
// ============================================================
const { mod: pw, from } = await loadPlaywright();
// CJS 패키지를 ESM 으로 import 하면 named export 가 안 잡힐 수 있어 default 도 살펴본다
const chromiumApi = pw.chromium || (pw.default && pw.default.chromium);
if (!chromiumApi) throw new Error("playwright 모듈에서 chromium 을 찾지 못했습니다: " + from);
console.log("🎭 playwright: " + from);
console.log("🌐 PLAYWRIGHT_BROWSERS_PATH: " + (process.env.PLAYWRIGHT_BROWSERS_PATH || "(기본값)"));

const server = await startServer();
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/`;
console.log("🗂  static server: " + BASE);

const { browser, exe } = await launchChromium(chromiumApi);
console.log("🧭 chromium: " + exe + "\n");

const pageErrors = [];
const consoleErrors = [];

try {
  const context = await browser.newContext({ viewport: { width: 520, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push("[http] " + e.message));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push("[http] " + m.text()); });

  // ---------- 1) 로드 & 타이틀 ----------
  console.log("① 로드 & 타이틀");
  await page.goto(BASE + "index.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof update === "function" && typeof draw === "function", null, { timeout: 15000 });
  assertEq("타이틀 화면 진입", await page.evaluate(() => state), "title");
  assertEq("문서 타이틀", await page.title(), "슬라임 머지 디펜스");
  assert("캔버스 렌더링됨", await page.evaluate(() => canvas.width > 0 && canvas.height > 0));
  assert("manifest 링크 존재", await page.evaluate(() => !!document.querySelector('link[rel="manifest"]')));
  assert("Phase 4 API 노출", await page.evaluate(
    () => ["rng", "mulberry32", "startDailyRun", "pushRecord", "todaySeed"].every((n) => typeof window[n] === "function")));

  // ---------- 2) 캔버스 클릭으로 시작 ----------
  console.log("② 게임 시작");
  await tapGame(page, 240, 430);                 // 버튼이 없는 빈 영역 = 새 게임
  assertEq("play 상태 진입", await page.evaluate(() => state), "play");
  assertEq("초기 배치 무기 2개", await page.evaluate(() => grid.filter(Boolean).length), 2);

  // ---------- 3) 10초 빨리감기 ----------
  console.log("③ 10초 빨리감기 (update 직접 호출)");
  const ff = await page.evaluate(() => {
    for (let i = 0; i < 600; i++) update(1 / 60);   // 60fps × 10초
    return { state, wave, enemies: enemies.length, lives, kills };
  });
  assert("빨리감기 후에도 진행 중", ff.state === "play" || ff.state === "card", "state=" + ff.state);
  assert("웨이브가 시작됨", ff.wave >= 1, "wave=" + ff.wave);
  ok("빨리감기 결과", `wave=${ff.wave} enemies=${ff.enemies} lives=${ff.lives} kills=${ff.kills}`);
  await page.evaluate(() => { if (state === "card" && cardPick) { pickCard(0); applyCardPick(); } });

  // ---------- 4) 구매 1회 ----------
  console.log("④ 무기 구매 1회");
  const before = await page.evaluate(() => {
    // 빈 칸을 확보하고 골드를 넉넉히 채운 뒤 실제 버튼을 누른다
    for (let i = 2; i < grid.length; i++) grid[i] = null;
    gold = 1000000;
    return { units: grid.filter(Boolean).length, buyCount, gold };
  });
  const buyPt = await page.evaluate(() => ({ x: BTN.buy.x + BTN.buy.w / 2, y: BTN.buy.y + BTN.buy.h / 2 }));
  await tapGame(page, buyPt.x, buyPt.y);
  const after = await page.evaluate(() => ({ units: grid.filter(Boolean).length, buyCount, gold }));
  assertEq("구매 횟수 +1", after.buyCount - before.buyCount, 1);
  assertEq("무기 1개 추가", after.units - before.units, 1);
  assert("골드 차감됨", after.gold < before.gold, `${before.gold} → ${after.gold}`);

  // ---------- 5) 합성 1회 (드래그) ----------
  console.log("⑤ 드래그 합성 1회");
  await page.evaluate(() => {
    for (let i = 0; i < grid.length; i++) grid[i] = null;
    grid[0] = { tier: 3, cd: 9, pop: 0, recoil: 0 };
    grid[1] = { tier: 3, cd: 9, pop: 0, recoil: 0 };
  });
  const c0 = await page.evaluate(() => cellCenter(0));
  const c1 = await page.evaluate(() => cellCenter(1));
  await dragGame(page, [c0.x, c0.y], [c1.x, c1.y]);
  const merged = await page.evaluate(() => ({ a: grid[0], b: grid[1] ? grid[1].tier : null }));
  assertEq("원래 칸이 비워짐", merged.a, null);
  assert("등급이 올라감 (4 또는 대박 5)", merged.b === 4 || merged.b === 5, "tier=" + merged.b);

  // ---------- 6) Phase 4: 시드 RNG ----------
  console.log("⑥ 시드 RNG (mulberry32)");
  const seedCheck = await page.evaluate(() => {
    const a = [], b = [];
    let f = mulberry32(20260801); for (let i = 0; i < 24; i++) a.push(f());
    f = mulberry32(20260801);     for (let i = 0; i < 24; i++) b.push(f());
    const c = []; f = mulberry32(20260802); for (let i = 0; i < 24; i++) c.push(f());
    const inRange = a.every((v) => v >= 0 && v < 1);
    // 일반 모드(rngState=null)에서는 rng() 가 Math.random 을 그대로 위임해야 한다
    const savedState = rngState, savedRandom = Math.random;
    rngState = null;
    Math.random = () => 0.4242;
    const delegated = rng();
    Math.random = savedRandom;
    rngState = savedState;
    return { same: JSON.stringify(a) === JSON.stringify(b), diff: JSON.stringify(a) !== JSON.stringify(c), inRange, delegated };
  });
  assert("같은 시드 → 같은 난수열", seedCheck.same);
  assert("다른 시드 → 다른 난수열", seedCheck.diff);
  assert("난수 범위 [0,1)", seedCheck.inRange);
  assertEq("일반 모드 rng() 는 Math.random 위임", seedCheck.delegated, 0.4242);

  // ---------- 7) Phase 4: 일일 도전 ----------
  console.log("⑦ 일일 도전 (시드 고정 / 메타 미적용 / 별조각 절반)");
  const daily = await page.evaluate(() => {
    // 메타를 최대치로 올려두고도 일일 모드에서는 효과가 없어야 한다
    meta = { gold: 10, tier: 5, lives: 5, cdr: 8, luck: 10 };
    const snap = () => ({ gold, lives, tiers: grid.map((u) => (u ? u.tier : 0)) });
    startDailyRun(); const r1 = snap();
    startDailyRun(); const r2 = snap();
    const seed = dailySeed, dateStr = dailyDate;
    // 메타 차단 확인
    const metaBlocked = gold === 150 && lives === 10 && grid.filter(Boolean).every((u) => u.tier === 1);
    const cdDaily = skillCd("meteor");
    // 별조각 절반 확인
    wave = 20; kills = 100;
    overSettled = false; dailyRun = true;  settleShards(); const dailyShards = earnedShards;
    overSettled = false; dailyRun = false; settleShards(); const normalShards = earnedShards;
    const cdNormal = skillCd("meteor");
    dailyRun = false; rngState = null;
    return { r1, r2, seed, dateStr, metaBlocked, dailyShards, normalShards, cdDaily, cdNormal };
  });
  assert("같은 날 시드 → 동일한 초기 배치", JSON.stringify(daily.r1) === JSON.stringify(daily.r2),
    JSON.stringify(daily.r1) + " vs " + JSON.stringify(daily.r2));
  const expectSeed = (() => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
  assertEq("시드 = 로컬 날짜 YYYYMMDD", daily.seed, expectSeed);
  assertEq("날짜 문자열 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(daily.dateStr), true);
  assert("메타 효과 미적용 (골드/생명/시작등급)", daily.metaBlocked, JSON.stringify(daily.r1));
  assert("메타 스킬 단련도 미적용", daily.cdDaily === 30 && daily.cdNormal < 30, `daily=${daily.cdDaily} normal=${daily.cdNormal}`);
  assertEq("별조각 절반 지급", daily.dailyShards, Math.floor(daily.normalShards / 2));

  // ---------- 8) Phase 4: 로컬 랭킹 보드 ----------
  console.log("⑧ 로컬 랭킹 보드");
  const rec = await page.evaluate(() => {
    localStorage.removeItem("smd_records");
    records = [];
    // 게임 오버 1회 → 기록 1개
    state = "play"; overSettled = false; dailyRun = false;
    wave = 7; kills = 42; peakTier = 9;
    gameOver();
    const afterOne = records.length;
    gameOver();                       // 중복 호출은 무시되어야 한다
    const afterTwice = records.length;
    // 11개 초과 시 상위 10개만 유지 + 웨이브 내림차순
    for (let i = 1; i <= 14; i++) { state = "play"; overSettled = false; wave = i; kills = i; peakTier = 3; gameOver(); }
    const sorted = records.every((r, i) => i === 0 || records[i - 1].wave >= r.wave);
    const persisted = JSON.parse(localStorage.getItem("smd_records") || "[]");
    const shape = records[0] && ["date", "wave", "kills", "peakTier", "daily"].every((k) => k in records[0]);
    return { afterOne, afterTwice, len: records.length, sorted, persistedLen: persisted.length, shape };
  });
  assertEq("게임 오버 1회 → 기록 1개", rec.afterOne, 1);
  assertEq("중복 gameOver() 는 추가 push 없음", rec.afterTwice, 1);
  assertEq("최대 10개로 절삭", rec.len, 10);
  assert("웨이브 내림차순 정렬", rec.sorted);
  assertEq("localStorage 반영", rec.persistedLen, 10);
  assert("레코드 스키마 {date,wave,kills,peakTier,daily}", rec.shape);

  // ---------- 9) 일일 기록 저장 ----------
  console.log("⑨ 일일 기록 (smd_daily)");
  const dRec = await page.evaluate(() => {
    localStorage.removeItem("smd_daily");
    dailyRec = { date: "", bestWave: 0 };   // 페이지 전역 변수
    startDailyRun();
    state = "play"; overSettled = false; wave = 12; kills = 5; gameOver();
    const first = JSON.parse(localStorage.getItem("smd_daily") || "{}");
    // 같은 날 더 낮은 기록으로 재도전 → 최고치는 유지되어야 한다
    startDailyRun();
    state = "play"; overSettled = false; wave = 3; kills = 1; gameOver();
    const second = JSON.parse(localStorage.getItem("smd_daily") || "{}");
    dailyRun = false; rngState = null;
    return { first, second };
  });
  assertEq("최초 기록 저장", dRec.first.bestWave, 12);
  assertEq("낮은 재도전은 기록 미갱신", dRec.second.bestWave, 12);
  assertEq("날짜 저장 형식", /^\d{4}-\d{2}-\d{2}$/.test(dRec.second.date || ""), true);

  // ---------- 10) 화면 전환 (기록실 / 도감 / 영구 강화 / 결과) ----------
  console.log("⑩ 메뉴 화면 전환");
  const screens = await page.evaluate(() => {
    const out = {};
    // 각 화면이 예외 없이 그려지는지 (Phase 4 신규 화면 포함)
    for (const s of ["records", "dex", "meta", "title", "pause"]) { state = s; draw(); out[s] = true; }
    // 결과 화면: 일반 / 일일(📋 복사 버튼 포함) 두 갈래 모두
    state = "over"; dailyRun = false; draw(); out.over = true;
    dailyRun = true; dailyDate = todayStr(); draw(); out.overDaily = true;
    dailyRun = false; rngState = null; state = "title";
    return out;
  });
  assert("기록실/도감/강화/일시정지 렌더 OK", screens.records && screens.dex && screens.meta && screens.pause);
  assert("결과 화면(일반/일일) 렌더 OK", screens.over && screens.overDaily);

  // 실제 버튼 클릭으로 기록실 진입/복귀
  await page.evaluate(() => { state = "title"; });
  const recsBtn = await page.evaluate(() => ({ x: TITLE_BTN.recs.x + TITLE_BTN.recs.w / 2, y: TITLE_BTN.recs.y + TITLE_BTN.recs.h / 2 }));
  await tapGame(page, recsBtn.x, recsBtn.y);
  assertEq("🏆 기록실 버튼 → records", await page.evaluate(() => state), "records");
  const backBtn = await page.evaluate(() => ({ x: BACK_BTN.x + BACK_BTN.w / 2, y: BACK_BTN.y + BACK_BTN.h / 2 }));
  await tapGame(page, backBtn.x, backBtn.y);
  assertEq("◀ 뒤로 → title", await page.evaluate(() => state), "title");

  const dailyBtn = await page.evaluate(() => ({ x: TITLE_BTN.daily.x + TITLE_BTN.daily.w / 2, y: TITLE_BTN.daily.y + TITLE_BTN.daily.h / 2 }));
  await tapGame(page, dailyBtn.x, dailyBtn.y);
  const dstate = await page.evaluate(() => ({ state, dailyRun, seeded: !!rngState }));
  assertEq("📅 일일 도전 버튼 → play", dstate.state, "play");
  assert("일일 모드 플래그 + 시드 RNG 활성", dstate.dailyRun && dstate.seeded);

  // ---------- 11) 서비스워커 (https/localhost 에서는 등록) ----------
  console.log("⑪ PWA 서비스워커");
  const swReg = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    for (let i = 0; i < 50; i++) {                       // 등록은 load 이후 비동기라 잠깐 폴링
      const rs = await navigator.serviceWorker.getRegistrations();
      if (rs.length) return "registered";
      await new Promise((r) => setTimeout(r, 100));
    }
    return "none";
  });
  assert("localhost 에서 서비스워커 등록됨", swReg === "registered" || swReg === "unsupported", "결과=" + swReg);

  // ---------- 12) file:// 로컬 실행 가드 ----------
  console.log("⑫ file:// 로컬 실행 (서비스워커 가드)");
  const filePage = await context.newPage();
  const fileErrors = [];
  const fileConsoleErrors = [];
  filePage.on("pageerror", (e) => fileErrors.push("[file] " + e.message));
  filePage.on("console", (m) => { if (m.type() === "error") fileConsoleErrors.push("[file] " + m.text()); });
  // register() 호출 자체를 계수해 "가드가 실제로 막았는지"를 본다 (-1 = 이 환경엔 API 없음)
  await filePage.addInitScript(() => {
    window.__swCalls = 0;
    try {
      const c = navigator.serviceWorker;
      if (c && typeof c.register === "function") {
        const orig = c.register.bind(c);
        c.register = function () { window.__swCalls++; return orig.apply(null, arguments); };
      } else { window.__swCalls = -1; }
    } catch (e) { window.__swCalls = -1; }
  });
  await filePage.goto(pathToFileURL(path.join(ROOT, "index.html")).href, { waitUntil: "load" });
  await filePage.waitForFunction(() => typeof update === "function", null, { timeout: 15000 });
  const fileState = await filePage.evaluate(() => {
    for (let i = 0; i < 120; i++) update(1 / 60);
    draw();
    return { state, proto: location.protocol };
  });
  assertEq("file:// 프로토콜", fileState.proto, "file:");
  assertEq("file:// 에서도 타이틀 정상", fileState.state, "title");
  const fileSw = await filePage.evaluate(() => window.__swCalls);
  assert("file:// 에서 register() 호출 자체가 없음", fileSw <= 0, "register 호출 " + fileSw + "회");
  assertEq("file:// pageerror 0건", fileErrors, []);
  assertEq("file:// console.error 0건", fileConsoleErrors, []);
  await filePage.close();

  // ---------- 13) JS 오류 0건 ----------
  console.log("⑬ 오류 집계");
  assertEq("pageerror 0건", pageErrors, []);
  if (consoleErrors.length) console.log("  ℹ️  console.error " + consoleErrors.length + "건: " + consoleErrors.slice(0, 5).join(" | "));
  else ok("console.error 0건");

  await context.close();
} catch (e) {
  failed++;
  console.error("\n💥 예외 발생: " + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
  server.close();
}

if (pageErrors.length) {
  console.error("\n페이지 오류:");
  for (const e of pageErrors) console.error("   - " + e);
}

if (failed) {
  console.error(`\n❌ 스모크 테스트 실패 — ${failed}건`);
  process.exit(1);
}
console.log("\n✅ 스모크 테스트 전부 통과");
process.exit(0);
