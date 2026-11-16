"use strict";
// バックアップ（JSON）の「入口の検査」。第三者から受け取ったファイルでも安全に取り込めるよう、
// 知っている項目だけを、型・長さ・範囲を確かめたうえで残し、それ以外は捨てる（許可リスト方式）。
//  - 未知の種類のボタン、廃止した種類（OBS・Discord）は捨てる
//  - URLは http / https だけ（javascript: file: data: などは空にする）
//  - 画像は data:image（png/jpeg/gif/webp）かファイルのパスだけ
//  - __proto__ などの危険なキーは、そもそも新しいオブジェクトに写さない
//  - ファイルの大きさ・ボタンの数・入れ子の深さに上限を設ける
//  - アプリ・ファイル・フォルダを起動するボタンは、署名（このPCで書き出したもの）がなければ、初回起動時に確認が必要な印（needsConfirm）を付ける
// このモジュールは main.js から使う（テスト：node tools/backup-selftest.js）。

const crypto = require("crypto");

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 6;
const MAX_TILES_PER_PAGE = 64;
const MAX_SUBS = 15;
const MAX_DEPTH = 8;
const MAX_ARRAY = 400;
const MAX_STR = 4000;
const MAX_TEXT = 200000;
const MAX_DATA_URL = 1500000;

const TILE_TYPES = new Set([
  "link", "app", "sound", "file", "folder", "volume", "power", "mic", "micdev", "clipboard", "window",
  "pageswitch", "brightness", "media", "qr", "zoom", "timer", "shortcutKeys", "screenshotFull", "multi",
]);
// マルチ操作の中に入れられない種類
const SUB_EXCLUDED = new Set(["multi", "qr", "sound"]);
// 押すと、PC上のプログラム・ファイル・フォルダを起動する種類（バックアップ由来のものは、初回に確認する）
const LAUNCH_TYPES = new Set(["app", "file", "folder"]);

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORD_RE = /^[A-Za-z0-9_\-:.]{0,40}$/;
const HOTKEY_RE = /^(Control|Alt|Shift|Meta)(\+(Control|Alt|Shift|Meta))*\+[A-Z0-9]$/;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const BLOCKED_SCHEME_RE = /^(javascript|data|file|vbscript|blob|about|ms-[a-z-]+|search-ms|shell|cmd|powershell|wsl|ftp):/i;

function newId() { return "t" + crypto.randomBytes(8).toString("hex"); }
function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

function str(v, max = MAX_STR) {
  if (typeof v !== "string") return "";
  // 制御文字（改行・NULなど）は取り除く。長すぎるものは切る
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, max);
}
function text(v) { return typeof v === "string" ? v.replace(/\u0000/g, "").slice(0, MAX_TEXT) : ""; }
function bool(v) { return v === true; }
function intIn(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function numIn(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
function word(v) { return typeof v === "string" && WORD_RE.test(v) ? v : ""; }
function color(v, dflt) { return typeof v === "string" && HEX_COLOR_RE.test(v) ? v : dflt; }
function filePathStr(v) { return str(v, 4000).replace(/[\r\n]/g, ""); }

// URL：http / https だけ。スキームを書かない入力（example.com など）は、そのまま残す（開くときに https:// が付く）
function safeUrl(v) {
  // タブ・改行は、ブラウザが無視する文字（"java\nscript:" のように、スキームを隠すのに使われる）なので、先に取り除く
  const u = str(v, 8000).replace(/[\t\r\n]/g, "").trim();
  if (!u) return "";
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(u)) return /^https?:\/\//i.test(u) ? u : "";
  if (BLOCKED_SCHEME_RE.test(u)) return "";
  return u;
}

// アイコン（kind ごとに、使える値の形が違う）
function iconValue(kind, v) {
  if (kind === "css") return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : "";
  if (kind === "emoji") return typeof v === "string" ? Array.from(v).slice(0, 8).join("").replace(/[\u0000-\u001F\u007F<>&"'`]/g, "") : "";
  if (kind === "image") {
    if (typeof v !== "string") return "";
    if (v.startsWith("data:")) return v.length <= MAX_DATA_URL && DATA_IMAGE_RE.test(v) ? v : "";
    return filePathStr(v);
  }
  return "";
}
function sanitizeIcon(raw, tileType) {
  const dflt = { kind: "default", value: "" };
  if (tileType === "media") return dflt; // メディアのアイコンは既定だけ
  if (!isPlainObject(raw)) return dflt;
  const kind = ["default", "css", "emoji", "image"].includes(raw.kind) ? raw.kind : "default";
  if (kind === "default") return dflt;
  const value = iconValue(kind, raw.value);
  if (!value) return dflt;
  const out = { kind, value };
  if (raw.offValue !== undefined) { const ov = iconValue(kind, raw.offValue); if (ov) out.offValue = ov; }
  if (kind === "css" && raw.filled === true) out.filled = true;
  return out;
}

// ボタン1つ（またはマルチ操作の中の動作1つ）を検査して、新しいオブジェクトで返す。使えないものは null
function sanitizeTile(raw, opts) {
  const o = opts || {};
  if (!isPlainObject(raw)) return null;
  const type = typeof raw.type === "string" ? raw.type : "";
  if (!TILE_TYPES.has(type)) return null;
  if (o.sub && SUB_EXCLUDED.has(type)) return null;
  const t = { type };
  if (!o.sub) {
    t.id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : newId();
    t.pageIndex = intIn(raw.pageIndex, 0, MAX_PAGES - 1, 0);
    t.color = color(raw.color, "#FFB238");
    if (raw.offColor !== undefined && typeof raw.offColor === "string" && HEX_COLOR_RE.test(raw.offColor)) t.offColor = raw.offColor;
    t.icon = sanitizeIcon(raw.icon, type);
    const hk = typeof raw.hotkey === "string" && HOTKEY_RE.test(raw.hotkey) ? raw.hotkey : "";
    t.hotkey = hk;
    t.matchNameColor = bool(raw.matchNameColor);
  }
  t.name = str(raw.name, 200);
  t.action = word(raw.action);
  t.url = safeUrl(raw.url);
  t.filePath = filePathStr(raw.filePath);
  t.text = text(raw.text);
  t.volume = numIn(raw.volume, 0, 100, 100);
  t.repeatCount = intIn(raw.repeatCount, 1, 99, 1);
  if (raw.waitAfter !== undefined) t.waitAfter = numIn(raw.waitAfter, 0, 60, 0);
  if (raw.targetPage !== undefined) t.targetPage = raw.targetPage === null ? null : intIn(raw.targetPage, 0, MAX_PAGES - 1, 0);
  if (raw.browser !== undefined) t.browser = word(raw.browser);
  if (raw.memoMode !== undefined) t.memoMode = word(raw.memoMode);
  if (raw.switchMode !== undefined) t.switchMode = word(raw.switchMode);
  if (raw.autoMute !== undefined) t.autoMute = bool(raw.autoMute);
  if (raw.autoPaste !== undefined) t.autoPaste = bool(raw.autoPaste);
  if (raw.openMaximized !== undefined) t.openMaximized = bool(raw.openMaximized);
  if (raw.keepInExistingWindow !== undefined) t.keepInExistingWindow = bool(raw.keepInExistingWindow);
  if (raw.micDeviceId !== undefined) t.micDeviceId = str(raw.micDeviceId, 300);
  if (raw.micDeviceName !== undefined) t.micDeviceName = str(raw.micDeviceName, 300);
  if (Array.isArray(raw.micExcludeIds)) t.micExcludeIds = raw.micExcludeIds.filter((x) => typeof x === "string").slice(0, 64).map((x) => str(x, 300));
  if (type === "multi" && !o.sub) {
    const subs = Array.isArray(raw.subActions) ? raw.subActions : [];
    t.subActions = subs.slice(0, MAX_SUBS).map((s) => sanitizeTile(s, { sub: true })).filter(Boolean);
  } else if (!o.sub) {
    t.subActions = [];
  }
  return t;
}

// 汎用の入れ子データ（設定・画面ごとの設定）の検査：数・文字列・真偽・配列・オブジェクトだけを、深さ・長さの上限つきで写す。
// 危険なキー（__proto__ など）と、関数・特殊な値は写さない。
function cloneSafe(v, depth) {
  if (depth > MAX_DEPTH) return undefined;
  if (v === null) return null;
  const t = typeof v;
  if (t === "boolean") return v;
  if (t === "number") return Number.isFinite(v) ? v : undefined;
  if (t === "string") return v.replace(/\u0000/g, "").slice(0, v.startsWith("data:image/") ? MAX_DATA_URL : MAX_STR);
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v.slice(0, MAX_ARRAY)) { const c = cloneSafe(x, depth + 1); out.push(c === undefined ? null : c); }
    return out;
  }
  if (isPlainObject(v)) {
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (DANGEROUS_KEYS.has(k) || k.length > 80) continue;
      if (++n > 200) break;
      const c = cloneSafe(v[k], depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}
function sanitizeSettings(raw) {
  if (!isPlainObject(raw)) return undefined;
  const s = cloneSafe(raw, 0) || {};
  if ("pageCount" in s) s.pageCount = intIn(s.pageCount, 1, MAX_PAGES, 1);
  delete s.l0BlockMicUnmute; // 廃止した設定
  return s;
}

// ---- 署名：このPCで書き出したバックアップだけ、「自分のバックアップ」と分かるようにする ----
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (isPlainObject(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
function signTiles(key, tiles) {
  return crypto.createHmac("sha256", key).update(canonical(tiles)).digest("hex");
}
function verifySignature(key, tiles, signature) {
  try {
    if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
    return crypto.timingSafeEqual(Buffer.from(signHex(key, tiles), "hex"), Buffer.from(signature, "hex"));
  } catch (e) { return false; }
}
function signHex(key, tiles) { return signTiles(key, tiles); }

function summarize(tiles) {
  const byType = {};
  let launch = 0, urls = 0;
  const targets = [];
  const walk = (t) => {
    byType[t.type] = (byType[t.type] || 0) + 1;
    if (LAUNCH_TYPES.has(t.type)) { launch++; if (targets.length < 8) targets.push(t.filePath || "(未設定)"); }
    if (t.type === "link" && t.url) urls++;
  };
  tiles.forEach((t) => { walk(t); (t.subActions || []).forEach(walk); });
  return { total: tiles.length, byType, launch, urls, targets };
}

/**
 * バックアップのJSON（parse済み）を検査して、安全な形にして返す。
 * @param {any} raw        JSON.parse の結果
 * @param {object} [opts]  { trusted: boolean }  署名が合っていれば true（起動確認の印を付けない）
 * @returns {{ ok: true, data: object, report: object } | { ok: false, error: string }}
 */
function sanitizeBackup(raw, opts) {
  const trusted = !!(opts && opts.trusted);
  if (!isPlainObject(raw)) return { ok: false, error: "Launch-Kのバックアップファイルではありません（形式が違います）" };
  const isPage = raw.kind === "page";
  const hasTiles = Array.isArray(raw.tiles);
  const hasSettings = isPlainObject(raw.settings);
  if (!hasTiles && !hasSettings) return { ok: false, error: "Launch-Kのバックアップファイルではありません（ボタンも設定も入っていません）" };
  if (isPage && !hasTiles) return { ok: false, error: "画面ごとのバックアップとして読み込めません（ボタンが入っていません）" };

  const data = {};
  const report = { trusted, tilesIn: hasTiles ? raw.tiles.length : 0, tilesOut: 0, dropped: 0, needsConfirm: 0, summary: null };
  let settings;
  if (hasSettings) { settings = sanitizeSettings(raw.settings); if (settings) data.settings = settings; }
  if (isPage) {
    data.kind = "page";
    if (isPlainObject(raw.pageSettings)) data.pageSettings = cloneSafe(raw.pageSettings, 0) || {};
  }
  if (hasTiles) {
    const pageCount = settings && settings.pageCount ? settings.pageCount : MAX_PAGES;
    const seen = new Set();
    const perPage = {};
    const tiles = [];
    for (const rt of raw.tiles.slice(0, MAX_ARRAY * 3)) {
      const t = sanitizeTile(rt, {});
      if (!t) { report.dropped++; continue; }
      if (seen.has(t.id)) t.id = newId();
      seen.add(t.id);
      if (!isPage) {
        if (t.pageIndex >= pageCount) t.pageIndex = pageCount - 1; // 存在しない画面にあるボタンは、最後の画面に入れる
        perPage[t.pageIndex] = (perPage[t.pageIndex] || 0) + 1;
        if (perPage[t.pageIndex] > MAX_TILES_PER_PAGE) { report.dropped++; continue; }
      }
      if ("targetPage" in t && typeof t.targetPage === "number" && !isPage && t.targetPage >= pageCount) t.targetPage = null;
      // 起動するボタンは、署名がなければ、初回に確認する印を付ける
      const launches = LAUNCH_TYPES.has(t.type) || (t.subActions || []).some((s) => LAUNCH_TYPES.has(s.type));
      // 署名が合っていても、すでに「確認がまだ」の印が付いていたボタンは、印を引き継ぐ（書き出して読み込み直しても、確認が済んだことにならないように）
      if (launches && (!trusted || rt.needsConfirm === true)) { t.needsConfirm = true; report.needsConfirm++; }
      tiles.push(t);
    }
    report.dropped += Math.max(0, raw.tiles.length - MAX_ARRAY * 3);
    data.tiles = tiles;
    report.tilesOut = tiles.length;
    report.summary = summarize(tiles);
  }
  return { ok: true, data, report };
}

module.exports = {
  sanitizeBackup, sanitizeTile, sanitizeSettings, cloneSafe, safeUrl, signTiles, verifySignature, canonical, summarize,
  MAX_FILE_BYTES, MAX_TILES_PER_PAGE, MAX_PAGES, LAUNCH_TYPES, TILE_TYPES,
};
