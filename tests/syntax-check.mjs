#!/usr/bin/env node
// ============================================================
//  문법 검사 — 브라우저를 띄우지 않고 정적으로 확인한다
//   1) index.html 안의 인라인 <script> 를 파싱 (구문 오류 검출)
//   2) sw.js 파싱
//   3) manifest.json 파싱 + 필수 필드 확인
//  실패 시 exit 1
// ============================================================
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];

function check(name, fn) {
  try { fn(); console.log("  ✅ " + name); }
  catch (e) { fails.push(name + " → " + e.message); console.log("  ❌ " + name + " → " + e.message); }
}

console.log("🔎 문법 검사");

// ---------- 1) index.html 인라인 스크립트 ----------
const html = await readFile(path.join(ROOT, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
check("index.html 인라인 <script> 존재", () => {
  if (!scripts.length) throw new Error("인라인 스크립트를 찾지 못함");
});
scripts.forEach((code, i) => {
  check(`index.html <script> #${i + 1} 파싱`, () => { new vm.Script(code, { filename: `index.html:script${i + 1}` }); });
});

// ---------- head 의 PWA 태그 ----------
check("index.html manifest 링크", () => {
  if (!/<link[^>]+rel=["']manifest["'][^>]+href=["']manifest\.json["']/i.test(html)) throw new Error("manifest 링크 없음");
});
check("index.html theme-color 메타", () => {
  if (!/<meta[^>]+name=["']theme-color["'][^>]+content=["']#a8cc3e["']/i.test(html)) throw new Error("theme-color 없음");
});
check("index.html apple-touch-icon", () => {
  if (!/<link[^>]+rel=["']apple-touch-icon["']/i.test(html)) throw new Error("apple-touch-icon 없음");
});
check("서비스워커 등록에 https/localhost 가드", () => {
  if (!/serviceWorker/.test(html)) throw new Error("서비스워커 등록 코드 없음");
  if (!/localhost/.test(html) || !/https:/.test(html)) throw new Error("프로토콜/호스트 가드가 보이지 않음");
});

// ---------- 2) sw.js ----------
const sw = await readFile(path.join(ROOT, "sw.js"), "utf8");
check("sw.js 파싱", () => { new vm.Script(sw, { filename: "sw.js" }); });
check("sw.js 캐시 버전 + 구 캐시 삭제", () => {
  if (!/CACHE_VERSION\s*=\s*["'][^"']+["']/.test(sw)) throw new Error("CACHE_VERSION 없음");
  if (!/caches\.delete/.test(sw)) throw new Error("구 캐시 삭제 로직 없음");
});

// ---------- 3) manifest.json ----------
const manifestRaw = await readFile(path.join(ROOT, "manifest.json"), "utf8");
check("manifest.json 파싱 + 필수 필드", () => {
  const m = JSON.parse(manifestRaw);
  const want = {
    name: "슬라임 머지 디펜스",
    short_name: "슬라임머지",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#a8cc3e",
    background_color: "#2a3d1f",
    start_url: ".",
  };
  for (const [k, v] of Object.entries(want)) {
    if (m[k] !== v) throw new Error(`${k} = ${JSON.stringify(m[k])} (기대: ${JSON.stringify(v)})`);
  }
  if (!Array.isArray(m.icons) || !m.icons.length) throw new Error("icons 비어 있음");
  if (!m.icons.some((i) => i.src === "icon.svg" && i.purpose === "any")) throw new Error("icon.svg / purpose:any 항목 없음");
});

// ---------- icon.svg ----------
const svg = await readFile(path.join(ROOT, "icon.svg"), "utf8");
check("icon.svg 형식", () => {
  if (!/^\s*<svg[\s>]/.test(svg)) throw new Error("<svg> 루트가 아님");
  if (!/viewBox=/.test(svg)) throw new Error("viewBox 없음");
});

if (fails.length) {
  console.error("\n❌ 문법 검사 실패 " + fails.length + "건");
  for (const f of fails) console.error("   - " + f);
  process.exit(1);
}
console.log("\n✅ 문법 검사 통과");
