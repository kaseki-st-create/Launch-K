// ============================================================================
// launch0.js — Launch-0（スマホ操作）のPC側の画面と処理（レンダラー）
//
// index.html で renderer.js より「前」に読み込む。ここに書いた関数は、実行時に renderer.js の
// グローバル（tiles, settings, handleTileClick, THEME_PRESETS など）を使う。
//
//  ・Launch-0のウィンドウは index.html?mode=launch0 を使う。ボタンを押したときの処理は
//    PC上の左クリックと同じ handleTileClick() をそのまま呼ぶ（スマホからはボタンIDだけが届く）。
//  ・スマホに送るのは、表示用の最小データだけ（名前・色・アイコン・背景の色）。
//    パス・コマンド・ショートカットキーなど、実行内容に関わるものは送らない。
//  ・スマホからは、PCで別の画面を開く種類のボタン（画面切り替え・タイマー・QR）と、
//    電源操作は実行しない。
// ============================================================================

// ---- スマホから実行しない種類（ここを変えれば調整できる） ----
const L0_BLOCKED_TYPES = new Set(["pageswitch", "timer", "qr", "power"]);
const L0_SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let l0Locked = false;           // Launch-0ウィンドウのロック（常に最前面）
let l0ToastSink = null;         // 実行中に出たメッセージを集める（スマホに返すため）
const l0 = {
  phase: "select",              // select | waiting | pending | active
  startPage: null,
  creds: null,                  // { url, otp, otpExpiresAt }
  device: null,                 // { ip, ua }
  pendingDeadline: 0,
  since: 0,
  count: 0,
  last: null,
  log: [],
  paused: false,
  stalled: false,
  phonePage: null,
  warn: null,                   // { kind, until }
  mode: "tailscale",            // 接続方法はTailscaleだけ（同じWi-Fiモードは廃止）
  ts: null,                     // Tailscaleの状態 { ok, reason, ip, selfName, login, tailnet }
  tsLoading: false,
  fw: null,                     // ファイアウォールの許可の状態 { supported, exists, adding }
  sessionMode: "tailscale",     // 実際につながっている方法（常にtailscale）
  peer: null,                   // Tailscaleで確認できた相手 { name, os, login, path }
  route: null,                  // 経路 { kind: direct|relay|peer-relay|unknown, detail }
  showAcct: false,              // アカウント名の表示（最初は隠す）
  execBusy: false,              // スマホから押された操作を、PCで実行中
  closingWait: false,           // 切断は済んだが、実行中の操作の完了を待ってから閉じる
  notice: "",
  busy: false,
  allowed: new Set(),
  pageLabels: {},
  tickTimer: null,
  muteTimer: null,
  exec: 0,                      // いま実行中の操作の数（この画面での実行）
};

function l0OnToast(msg) { if (l0ToastSink) l0ToastSink.push(String(msg)); }

// ---------- 判定 ----------
function l0IsBlocked(t) {
  if (!t || typeof t.id !== "string" || !L0_SAFE_ID_RE.test(t.id)) return true;
  if (L0_BLOCKED_TYPES.has(t.type)) return true;
  if (t.type === "multi" && Array.isArray(t.subActions)) {
    return t.subActions.some((s) => s && L0_BLOCKED_TYPES.has(s.type));
  }
  return false;
}
function l0PagesWithTiles() {
  const count = Math.max(1, Math.min(MAX_PAGE_COUNT, Number(settings.pageCount) || 1));
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = tiles.filter((t) => (t.pageIndex || 0) === i).length;
    if (n > 0) out.push({ index: i, count: n });
  }
  return out;
}
// 接続してきた端末の表示名。iPhone以外は「動作未確認」として知らせる（端末の種類は偽装できるので、安全の判断には使わない）
function l0DeviceLabel(ua) {
  const t = String(ua || "");
  let name = "スマートフォン";
  let verified = false;
  if (/iPhone/.test(t)) { name = "iPhone"; verified = true; }
  else if (/iPad/.test(t)) name = "iPad";
  else if (/Android/.test(t)) name = /Mobile/.test(t) ? "Androidスマホ" : "Androidタブレット";
  else if (/Windows/.test(t)) name = "Windows PC";
  else if (/Macintosh/.test(t)) name = "Mac または iPad";
  else if (/Linux|X11/.test(t)) name = "Linux PC";
  let browser = "";
  if (/Edg\//.test(t)) browser = "Edge";
  else if (/Firefox|FxiOS/.test(t)) browser = "Firefox";
  else if (/CriOS|Chrome\//.test(t)) browser = "Chrome";
  else if (/Safari\//.test(t)) browser = "Safari";
  return { name, browser, verified };
}
function l0DeviceName(ua) { return l0DeviceLabel(ua).name; }
function l0RouteText(r) {
  if (!r || r.kind === "unknown") return "確認中…";
  if (r.kind === "direct") return "direct（直接つながっています）";
  if (r.kind === "peer-relay") return "relay（別の端末を経由）";
  return "relay（中継サーバー経由" + (r.detail ? "・" + r.detail : "") + "）";
}
const L0_REASONS = {
  "user-pc": "PCで切断しました",
  "user-phone": "スマホから切断されました",
  timeout: "通信が途切れたため切断しました",
  idle: "しばらく操作がなかったため切断しました",
  maxtime: "最大の接続時間に達したため切断しました",
  "phone-hidden": "スマホの画面が長時間閉じていたため切断しました",
  "pc-sleep": "PCがスリープしたため切断しました",
  "pc-lock": "PCの画面がロックされたため切断しました",
  network: "ネットワークが変わったため切断しました",
  closed: "Launch-0を閉じました",
  "wait-timeout": "",
  identity: "接続してきた端末を、同じアカウントの端末と確認できなくなったため切断しました",
  "tailscale-down": "Tailscaleが止まったため切断しました",
  error: "Launch-0に問題が起きたため閉じました",
  "app-quit": "アプリの終了により切断しました",
  abuse: "操作が多すぎたため切断しました",
  cancel: "",
};
function l0EndMessage(reason) {
  if (reason === "wait-timeout") return "90秒間、スマホからの接続がなかったため、Launch-0を閉じました。画面1に戻しました";
  const t = L0_REASONS[reason];
  if (t === "") return "";
  return "スマホとの接続を終了しました（" + (t || "接続が終了しました") + "）。画面1に戻しました";
}

// ---------- スマホに渡す表示用データ ----------
function l0ThemeFor(pt) {
  const mode = pt && pt.themeMode;
  // 画像背景は引き継がない：暗い単色（黒テーマ）にする
  const preset = mode === "custom" ? deriveThemeFromColor((pt && pt.customColor) || "#3A3F4B")
    : (mode === "image" ? THEME_PRESETS.black : (THEME_PRESETS[mode] || THEME_PRESETS.black));
  const alpha = pt && typeof pt.panelOpacity === "number" ? pt.panelOpacity : PANEL_OPACITY_DEFAULT;
  return {
    bg1: preset.bg1, bg2: preset.bg2, text: preset.text, border: preset.border,
    panel: colorWithAlpha(preset.panel, alpha), panelAlt: colorWithAlpha(preset.panelAlt, alpha),
    panelSolid: colorWithAlpha(preset.panel, 0.76),
    dark: luminanceOfAny(preset.bg1) < 0.5,
  };
}

async function l0IconFor(t, icons, images) {
  const ic = t.icon || {};
  // 「オン/オフ」の状態を持つボタンが、スマホで使う状態の名前：マイク／スピーカー／サウンドはボタンごと（"snd:" + ID）
  const toggle = tileHasToggle(t) ? (t.type === "mic" ? "mic" : "speaker") : (t.type === "sound" ? "snd:" + String(t.id) : null);
  if (ic.kind === "image" && ic.value) {
    let data = "";
    try {
      data = String(ic.value).startsWith("data:image/") ? String(ic.value) : await window.api.l0IconData(t.id);
    } catch (e) { data = ""; }
    if (data && /^data:image\/(png|jpeg|gif|webp);base64,/.test(data) && data.length < 700000) {
      images[t.id] = data;
      return { kind: "image", img: true, toggle: null };
    }
    // 読めなかった画像は、そのボタンの種類に合った標準のアイコンで代用する
  }
  if (ic.kind === "emoji" && ic.value) return { kind: "emoji", emoji: Array.from(String(ic.value)).slice(0, 8).join(""), toggle };
  const key = CSS_ICONS[resolveCssIconKey(t)] ? resolveCssIconKey(t) : "circleMark";
  const def = CSS_ICONS[key];
  // サウンドは、止まっているとき用の斜線入りの図柄を、オフ用の図柄を持たないアイコンにも自動で用意する
  icons[key] = { svg: def.svg, offSvg: def.offSvg || (t.type === "sound" ? svgWithSlash(def.svg) : "") };
  let offKey = null;
  if (ic.kind === "css" && toggle && ic.offValue && CSS_ICONS[ic.offValue]) {
    offKey = ic.offValue;
    icons[offKey] = { svg: CSS_ICONS[offKey].svg, offSvg: CSS_ICONS[offKey].offSvg || "" };
  }
  const color = safeColor(t.color);
  return {
    kind: "css", key, offKey, toggle,
    filled: ic.kind === "css" && !!ic.filled,
    fgFilled: luminance(color) < 0.5 ? "#FFFFFF" : "#14161B",
  };
}

// スマホに渡す「いまの状態」：スピーカー・マイクのミュートと、サウンドボタンごとの「止まっているか」（true=オフ＝止まっている）
function l0States() {
  const s = { speaker: audioMuteState.speaker, mic: audioMuteState.mic };
  for (const t of tiles) {
    if (t && t.type === "sound" && L0_SAFE_ID_RE.test(String(t.id))) s["snd:" + String(t.id)] = !isSoundPlaying(t);
  }
  return s;
}
async function l0BuildSnapshot(startPage) {
  const icons = {};
  const images = {};
  const allowedIds = [];
  const multiIds = [];
  const pages = [];
  for (const p of l0PagesWithTiles()) {
    const pt = (settings.pageThemes && settings.pageThemes[p.index]) || {};
    const list = [];
    for (const t of tiles.filter((x) => (x.pageIndex || 0) === p.index)) {
      const blocked = l0IsBlocked(t);
      const icon = L0_SAFE_ID_RE.test(String(t.id)) ? await l0IconFor(t, icons, images) : { kind: "css", key: "circleMark", toggle: null };
      if (!icons.circleMark && icon.key === "circleMark" && CSS_ICONS.circleMark) icons.circleMark = { svg: CSS_ICONS.circleMark.svg, offSvg: "" };
      list.push({ id: String(t.id), name: String(t.name || "").slice(0, 60), blocked, color: safeColor(t.color), icon, multi: t.type === "multi" });
      if (!blocked) { allowedIds.push(String(t.id)); if (t.type === "multi") multiIds.push(String(t.id)); }
    }
    pages.push({ index: p.index, label: "画面" + (p.index + 1), theme: l0ThemeFor(pt), tiles: list });
  }
  const snapshot = {
    v: 1, startPage, icons, pages,
    states: l0States(),
  };
  return { snapshot, allowedIds, multiIds, images };
}

// ---------- スマホからの操作を実行（PCでの左クリックと同じ処理を呼ぶ） ----------
async function l0RunTap(e) {
  const tile = tiles.find((t) => t.id === e.tileId);
  if (!tile || !l0.allowed.has(tile.id) || l0IsBlocked(tile)) {
    window.api.l0TapResult(e.seq, false, "このボタンは実行できません");
    return;
  }
  const sink = [];
  l0ToastSink = sink;
  let ok = true;
  // マルチ操作・画面分割は「いま前面にあるウィンドウ」に作用する。実行の間だけLaunch-0を前面から外す（main.js側で最小化）
  const needsFront = tile.type === "multi" || tile.type === "window";
  l0.exec += 1; l0UpdateLive();
  try {
    if (needsFront) { try { await window.api.l0ExecMode(true); } catch (err) { /* 続行 */ } }
    await handleTileClick(tile);
  } catch (err) {
    ok = false;
    sink.push("実行に失敗しました");
  } finally {
    if (needsFront) { try { await window.api.l0ExecMode(false); } catch (err) { /* 無視 */ } }
    l0.exec = Math.max(0, l0.exec - 1);
  }
  l0ToastSink = null;
  // 「ほかのマルチ操作の実行中です」などで実行されなかったときは、成功扱いにしない
  const last = sink.length ? sink[sink.length - 1] : "";
  if (/実行中/.test(last)) ok = false;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0");
  if (ok) {
    l0.count += 1;
    l0.last = { name: tile.name || "（名前なし）", page: (tile.pageIndex || 0) + 1, at: hh };
    l0.log.unshift(l0.last);
    if (l0.log.length > 5) l0.log.length = 5;
  }
  l0UpdateLive();
  window.api.l0TapResult(e.seq, ok, last);
}

// ---------- 画面の描画 ----------
function l0Root() { return document.getElementById("l0Root"); }
function l0Fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}
// ---- 接続方法のパネル（Tailscale） ----
const L0_TS_MESSAGES = {
  "not-installed": "Tailscaleが入っていません。入れて、ログインすると使えます。",
  stopped: "Tailscaleが停止しています。タスクトレイのTailscaleをオンにしてください。",
  "needs-login": "Tailscaleにログインしてください。",
  starting: "Tailscaleを起動しています。少し待ってから「再確認」を押してください。",
  "no-ip": "Tailscaleの番号（IPアドレス）が見つかりません。Tailscaleの状態を確認してください。",
  "not-running": "Tailscaleが動いていないようです。Tailscaleを起動してください。",
};
function l0ModePanelHtml() {
  const ts = l0.ts;
  if (l0.tsLoading || !ts) return `<div class="l0-sub">Tailscaleを確認しています…</div>`;
  if (!ts.ok) {
    const msg = L0_TS_MESSAGES[ts.reason] || "Tailscaleの状態を確認できませんでした。";
    return `<div class="l0-notice">⚠ ${escapeHtml(msg)}</div>
      <div class="l0-row"><button class="btn default" id="l0TsRecheck">再確認</button>${ts.reason === "not-installed" ? '<button class="btn default" id="l0TsDownload">ダウンロードページを開く</button>' : ""}</div>`;
  }
  let fw = "";
  if (l0.fw && l0.fw.supported) {
    fw = l0.fw.exists
      ? `<div class="l0-sub">✅ Windowsファイアウォール：許可済み</div>`
      : `<div class="l0-notice">⚠ Windowsファイアウォールの許可がありません。スマホから届かない場合は追加してください（Tailscaleの番号帯からだけ許可します）。</div>
         <div class="l0-row"><button class="btn default" id="l0FwAdd"${l0.fw.adding ? " disabled" : ""}>${l0.fw.adding ? "追加しています…" : "許可を追加（管理者の確認が出ます）"}</button></div>`;
  }
  return `<div class="l0-ok-note">✅ Tailscale：使えます（暗号化・同じアカウントの端末だけ接続できます）</div>
    <div class="l0-sub">ac：${l0Acct(ts.login || ts.display || "")}　このPC：<b>${escapeHtml(ts.selfName || "")}</b></div>
    <div class="l0-sub">iPhoneでも、同じアカウントでTailscaleをオンにしてください。</div>
    ${fw}
    <div class="l0-row"><button class="btn default" id="l0TsRecheck">再確認</button></div>`;
}
function l0StatusText() {
  if (l0.stalled) return "通信が途切れています…";
  if (l0.paused) return "一時停止中";
  if (l0.execBusy || l0.exec > 0) return "動作を実行中…";
  return "接続中";
}
function l0DotClass() { return l0.stalled ? " stalled" : l0.paused ? " paused" : ""; }

// アカウント名（メールアドレスなど）は、最初は伏せ字にして、押すたびに表示・非表示を切り替える。
// 伏せ字（●●●●●●●●）または名前と、顔が、
// ひとつのボタン。●や名前の部分を押しても切り替わる。顔：表示中は (o_o)（目が開いている）、隠れ中は (- -)（目を閉じている）。
function l0Acct(text) {
  const t = String(text || "");
  if (!t) return "<b>-</b>";
  const on = l0.showAcct === true;
  const label = on ? "アカウント名を隠す" : "アカウント名を表示";
  return `<button type="button" class="l0-acct l0-eye" aria-pressed="${on}" aria-label="${label}" title="${label}">${on ? `<b>${escapeHtml(t)}</b>` : `<b class="l0-dots">●●●●●●●●</b>`}<span class="l0-face" aria-hidden="true">${on ? "(o_o)" : "(- -)"}</span></button>`;
}
function l0Render() {
  const root = l0Root();
  if (!root) return;
  const notice = l0.notice ? `<div class="l0-notice">${escapeHtml(l0.notice)}</div>` : "";
  const closing = l0.closingWait ? `<div class="l0-warn">動作の完了を待っています。終わったら、自動でLaunch-0を閉じます。</div>` : "";
  const modeLabel = "🔒 Tailscale（暗号化・同じアカウントの端末だけ）";
  let body = "";
  if (l0.phase === "select") {
    const pages = l0PagesWithTiles();
    if (l0.startPage === null || !pages.some((p) => p.index === l0.startPage)) l0.startPage = pages.length ? pages[0].index : null;
    const canStart = pages.length && !l0.busy && !!(l0.ts && l0.ts.ok);
    body = `
      ${l0ModePanelHtml()}
      <div class="l0-sub" style="margin-top:6px;">スマホで最初に表示する画面を選んでください。</div>
      <div class="l0-list">${pages.map((p) => `<button class="l0-pick${p.index === l0.startPage ? " sel" : ""}" data-page="${p.index}">画面${p.index + 1}<span>ボタン ${p.count}個</span></button>`).join("") || '<div class="l0-sub">ボタンがある画面がありません</div>'}</div>
      ${notice}
      <div class="modal-actions">
        <button class="btn default" id="l0Quit">やめる</button>
        <button class="btn primary" id="l0QrBtn" ${canStart ? "" : "disabled"} title="Enterキーでも進めます">QRを表示</button>
      </div>`;
  } else if (l0.phase === "waiting" && l0.creds) {
    let qrImg = "";
    try {
      const qr = qrcode(0, "M");
      qr.addData(l0.creds.url);
      qr.make();
      qrImg = qr.createDataURL(3, 2);
    } catch (err) { qrImg = ""; }
    body = `
      <div class="l0-wait">
        <div class="l0-qrbox">${qrImg ? `<img src="${qrImg}" alt="QR" />` : "<div class=\"l0-sub\">QRを作れませんでした</div>"}</div>
        <div class="l0-side">
          <div class="l0-otp" id="l0Otp">${escapeHtml(l0.creds.otp)}</div>
          <div class="l0-sub">残り <b id="l0OtpLeft">--:--</b>（自動で新しくなります）</div>
          <div class="l0-sub">つながらないまま <b id="l0WaitLeft">--:--</b> たつと、Launch-0を自動で閉じます</div>
          <div class="l0-sub" style="word-break:break-all;">${escapeHtml(l0.creds.url.replace(/\?k=.*/, ""))}</div>
          <div class="l0-sub">${escapeHtml(modeLabel)}</div>
        </div>
      </div>
      ${notice}
      <div class="modal-actions">
        <button class="btn default" id="l0Back">戻る</button>
        <button class="btn default" id="l0Quit">やめる</button>
      </div>`;
  } else if (l0.phase === "pending") {
    const dev = l0DeviceLabel(l0.device && l0.device.ua);
    const devText = dev.name + (dev.browser ? "（" + dev.browser + "）" : "");
    let detail;
    if (l0.peer) {
      detail = `<div class="l0-ok-note">✅ Tailscaleで確認済み（このPCと同じアカウントの端末です）</div>
        <div class="l0-sub">端末名：<b>${escapeHtml(l0.peer.name || "")}</b>${l0.peer.os ? "（" + escapeHtml(l0.peer.os) + "）" : ""}　ac：${l0Acct(l0.peer.login || "")}</div>
        <div class="l0-sub">経路：${escapeHtml(l0RouteText(l0.route))}</div>`;
    } else {
      detail = `<div class="l0-notice">⚠ Tailscaleで端末を確認できませんでした。心当たりがなければ「拒否」を押してください。<br>IPアドレス：${escapeHtml(l0.device ? l0.device.ip : "")}</div>`;
    }
    body = `
      <div class="l0-card">
        <div class="l0-big">${escapeHtml(devText)}が接続を求めています</div>
        ${detail}
        ${dev.verified ? "" : `<div class="l0-notice">この種類の端末は、動作の確認をしていません。</div>`}
        <div class="l0-sub">（あと <b id="l0ApprLeft">--</b> 秒）許可すると、その端末からボタンを押せるようになります。心当たりがなければ「拒否」を押してください。</div>
      </div>
      <div class="modal-actions">
        <button class="btn default" id="l0Deny">拒否</button>
        <button class="btn primary dialog-default" id="l0Allow" title="Enterキーでも許可できます">許可</button>
      </div>`;
  } else if (l0.phase === "active") {
    const warn = l0.warn ? `<div class="l0-warn">まもなく自動で切断します。 <button class="btn primary" id="l0Extend">このまま続ける</button></div>` : "";
    const whoHtml = l0.peer
      ? `${escapeHtml(l0.peer.name || "")}（${l0Acct(l0.peer.login || "")}）`
      : escapeHtml(`${l0DeviceName(l0.device && l0.device.ua)}（${l0.device ? l0.device.ip : ""}）`);
    const routeCell = l0RouteText(l0.route);
    const cannotDisc = l0.execBusy || l0.exec > 0 || l0.closingWait;
    body = `
      <div class="l0-status"><span class="l0-dot${l0DotClass()}" id="l0Dot"></span><b id="l0StatusText">${escapeHtml(l0StatusText())}</b>
        <span class="l0-sub" style="margin-left:8px;">${whoHtml}</span></div>
      ${warn}${closing}
      <div class="l0-grid">
        <div><span>接続時間</span><b id="l0Elapsed">00:00</b></div>
        <div><span>操作回数</span><b id="l0Count">${l0.count}</b></div>
        <div><span>スマホの表示</span><b id="l0PhonePage">${l0.phonePage === null ? "-" : "画面" + (l0.phonePage + 1)}</b></div>
        <div style="flex-basis:100%;"><span>接続方法・経路</span><b id="l0Route" style="font-size:13px;">${escapeHtml("🔒 Tailscale　" + routeCell)}</b></div>
      </div>
      <div class="l0-sub">最後の操作：<b id="l0Last">${l0.last ? escapeHtml("画面" + l0.last.page + "「" + l0.last.name + "」 " + l0.last.at) : "まだありません"}</b></div>
      ${notice}
      <div class="modal-actions">
        <button class="btn default" id="l0Pause"${l0.closingWait ? " disabled" : ""}>${l0.paused ? "再開" : "一時停止"}</button>
        <button class="btn danger" id="l0Disconnect"${cannotDisc ? " disabled" : ""}>切断</button>
      </div>`;
  } else if (l0.closingWait) {
    body = closing;
  }
  root.innerHTML = `<div class="l0-title">📱 Launch-0 <span>スマホ操作</span></div>${body}`;
  l0Bind();
  l0UpdateLive();
}
function l0Bind() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  document.querySelectorAll(".l0-pick").forEach((b) => b.addEventListener("click", () => { l0.startPage = Number(b.dataset.page); l0Render(); }));
  document.querySelectorAll(".l0-eye").forEach((b) => b.addEventListener("click", () => {
    const root = l0Root(); const top = root ? root.scrollTop : 0;
    l0.showAcct = !l0.showAcct; l0Render();
    const r2 = l0Root(); if (r2) r2.scrollTop = top;
  }));
  on("l0Quit", async () => {
    const r = await window.api.l0Close("cancel");
    if (r === false) { l0.notice = "動作を実行中のため、完了するまで閉じられません。"; l0Render(); }
  });
  on("l0QrBtn", l0Begin);
  on("l0TsRecheck", () => l0LoadTs());
  on("l0TsDownload", () => { try { window.api.openExternal("https://tailscale.com/download"); } catch (e) { /* 無視 */ } });
  on("l0FwAdd", l0FwAdd);
  on("l0Back", async () => { await window.api.l0Stop(); l0.phase = "select"; l0.creds = null; l0.notice = ""; l0Render(); });
  on("l0Allow", () => window.api.l0Approve(true));
  on("l0Deny", () => window.api.l0Approve(false));
  on("l0Extend", () => { l0.warn = null; window.api.l0Extend(); l0Render(); });
  on("l0Pause", () => { l0.paused = !l0.paused; window.api.l0Pause(l0.paused); l0Render(); });
  on("l0Disconnect", async () => {
    const r = await window.api.l0Disconnect();
    if (r === false) { l0.notice = "動作を実行中のため、完了するまで切断できません。"; l0Render(); }
  });
  // 許可の画面は、Enterキーで「許可」（押しっぱなしは無視）。見た目の強調とフォーカスも「許可」に置く
  const allow = document.getElementById("l0Allow");
  if (allow) allow.focus();
}
// 1秒ごとに更新する小さな表示（再描画せずに文字だけ書き換える）
function l0UpdateLive() {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  if (l0.phase === "waiting" && l0.creds) {
    set("l0OtpLeft", l0Fmt(l0.creds.otpExpiresAt - Date.now()));
    set("l0WaitLeft", l0Fmt((l0.creds.waitDeadline || 0) - Date.now()));
  }
  if (l0.phase === "pending") set("l0ApprLeft", String(Math.max(0, Math.round((l0.pendingDeadline - Date.now()) / 1000))));
  if (l0.phase === "active") {
    set("l0Elapsed", l0Fmt(Date.now() - l0.since));
    set("l0Count", String(l0.count));
    set("l0PhonePage", l0.phonePage === null ? "-" : "画面" + (l0.phonePage + 1));
    set("l0Last", l0.last ? "画面" + l0.last.page + "「" + l0.last.name + "」 " + l0.last.at : "まだありません");
    set("l0StatusText", l0StatusText());
    const dot = document.getElementById("l0Dot");
    if (dot) dot.className = "l0-dot" + l0DotClass();
    set("l0Route", "🔒 Tailscale　" + l0RouteText(l0.route));
    const d = document.getElementById("l0Disconnect");
    if (d) d.disabled = !!(l0.execBusy || l0.exec > 0 || l0.closingWait);
  }
}

// ---------- Tailscale ----------
async function l0LoadTs() {
  l0.tsLoading = true;
  if (l0.phase === "select") l0Render();
  try {
    l0.ts = await window.api.l0TsStatus();
    l0.fw = await window.api.l0FwCheck();
  } catch (e) {
    l0.ts = { ok: false, reason: "error" };
  }
  l0.tsLoading = false;
  if (l0.phase === "select") l0Render();
}
async function l0FwAdd() {
  if (l0.fw) l0.fw.adding = true;
  l0Render();
  let r = null;
  try { r = await window.api.l0FwAdd(); } catch (e) { r = null; }
  l0.fw = Object.assign({}, l0.fw || { supported: true }, { adding: false, exists: !!(r && r.ok) });
  l0.notice = r && r.ok ? "" : "ファイアウォールの許可を追加できませんでした（管理者の確認で「いいえ」を選ぶと追加されません）。";
  l0Render();
}
const L0_START_ERRORS = {
  "tailscale-unavailable": "Tailscaleの機能を使えませんでした。",
  "ts-not-installed": "Tailscaleが入っていません。",
  "ts-stopped": "Tailscaleが停止しています。Tailscaleをオンにしてからやり直してください。",
  "ts-needs-login": "Tailscaleにログインしてからやり直してください。",
  "ts-starting": "Tailscaleの起動を待っています。少し待ってからやり直してください。",
  "ts-no-ip": "Tailscaleの番号（IPアドレス）が見つかりません。",
  "ts-not-running": "Tailscaleが動いていないようです。",
  "ts-error": "Tailscaleの状態を確認できませんでした。",
};

// ---------- 開始・イベント ----------
async function l0Begin() {
  if (l0.busy) return;
  l0.busy = true; l0.notice = "準備しています…"; l0Render();
  try {
    await l0RefreshMute();
    const built = await l0BuildSnapshot(l0.startPage);
    l0.allowed = new Set(built.allowedIds);
    const res = await window.api.l0Start({ mode: l0.mode, snapshot: built.snapshot, allowedIds: built.allowedIds, multiIds: built.multiIds, images: built.images });
    if (!res || res.error) {
      l0.notice = (res && L0_START_ERRORS[res.error]) || "開始できませんでした。もう一度お試しください。";
      l0.phase = "select";
    } else {
      l0.creds = { url: res.url, otp: res.otp, otpExpiresAt: res.otpExpiresAt, waitDeadline: res.waitDeadline };
      l0.sessionMode = "tailscale";
      l0.notice = "";
      l0.phase = "waiting";
    }
  } catch (err) {
    l0.notice = "開始できませんでした：" + (err && err.message ? err.message : "不明なエラー");
    l0.phase = "select";
  }
  l0.busy = false;
  l0Render();
}

const L0_REJECT_REASONS = {
  "other-user": "別のアカウントの端末",
  tagged: "タグ付きの端末",
  shared: "共有された端末",
  "unknown-peer": "不明な端末",
  "not-tailnet": "Tailscale以外のアドレス",
  "tailscale-down": "Tailscaleの状態を確認できない状態",
};
function l0OnEvent(e) {
  switch (e.type) {
    case "credentials":
      l0.creds = { url: e.url, otp: e.otp, otpExpiresAt: e.otpExpiresAt, waitDeadline: e.waitDeadline };
      if (e.reason === "locked") l0.notice = "パスワードを3回間違えたため、QRとパスワードを作り直しました。";
      if (l0.phase === "waiting") l0Render();
      break;
    case "wait-activity":
      if (l0.creds) l0.creds.waitDeadline = e.waitDeadline;
      l0UpdateLive();
      break;
    case "auth-fail":
      l0.notice = "パスワードの入力が違いました（" + e.count + "/" + e.max + "回）。";
      if (l0.phase === "waiting") l0Render();
      break;
    case "busy-attempt":
      l0.notice = "別の端末が接続しようとしましたが、接続は1台までなので断りました。";
      l0Render();
      break;
    case "peer-rejected":
      l0.notice = "Tailscaleで確認できない端末からの接続を断りました（" + (L0_REJECT_REASONS[e.reason] || "確認できない端末") + "）。";
      if (l0.phase === "waiting") l0Render();
      break;
    case "pending":
      l0.phase = "pending"; l0.device = { ip: e.ip, ua: e.ua }; l0.pendingDeadline = e.deadline; l0.notice = "";
      l0.sessionMode = e.mode || l0.sessionMode; l0.peer = e.peer || null; l0.route = e.peer && e.peer.path ? e.peer.path : null;
      l0Render();
      break;
    case "pending-ended":
      l0.phase = "waiting";
      l0.notice = e.reason === "denied" ? "接続を拒否しました。" : e.reason === "approval-timeout" ? "許可がされず、時間切れになりました。" : "スマホ側で取りやめられました。";
      l0Render();
      break;
    case "connected":
      l0.phase = "active"; l0.since = e.since || Date.now(); l0.count = 0; l0.last = null; l0.log = [];
      l0.paused = false; l0.stalled = false; l0.phonePage = l0.startPage; l0.warn = null; l0.notice = "";
      l0.sessionMode = e.mode || l0.sessionMode; l0.peer = e.peer || l0.peer; l0.route = e.route || (l0.peer && l0.peer.path) || null;
      l0.execBusy = false; l0.closingWait = false;
      l0StartMutePush();
      l0Render();
      break;
    case "route": l0.route = { kind: e.kind, detail: e.detail || "" }; l0UpdateLive(); break;
    case "exec": l0.execBusy = !!e.busy; l0UpdateLive(); break;
    case "disconnect-refused":
      l0.notice = e.from === "phone" ? "スマホから切断の操作がありましたが、動作を実行中のため断りました（完了するまで切断できません）。" : "動作を実行中のため、完了するまで切断できません。";
      if (l0.phase === "active") l0Render();
      break;
    case "closing-wait": l0.closingWait = true; l0Render(); break;
    case "stalled": l0.stalled = true; if (l0.phase === "active") l0Render(); break;
    case "resumed": l0.stalled = false; if (l0.phase === "active") l0Render(); break;
    case "phone-page": l0.phonePage = e.page; l0UpdateLive(); break;
    case "warn": l0.warn = { kind: e.kind }; if (l0.phase === "active") l0Render(); break;
    case "extended": l0.warn = null; if (l0.phase === "active") l0Render(); break;
    case "tap": l0RunTap(e); break;
    default: break;
  }
}

// ---------- ミュートなどの状態をスマホに反映 ----------
async function l0RefreshMute() {
  try { if (typeof refreshMuteStates === "function") await refreshMuteStates(); } catch (e) { /* 無視 */ }
}
function l0PushState() {
  if (l0.phase !== "active") return;
  window.api.l0PushState(l0States());
}
function l0StartMutePush() {
  if (l0.muteTimer) clearInterval(l0.muteTimer);
  // 2秒ごと（koffiで直接読むので軽い）。PowerShell方式に戻っているときだけ、5秒ごとに間引く（renderer.js の muteSlow）
  l0.muteTimer = setInterval(() => {
    if (typeof muteSlow !== "undefined" && muteSlow && Date.now() - (typeof lastMuteReadAt !== "undefined" ? lastMuteReadAt : 0) < 5000) return;
    l0RefreshMute().then(l0PushState);
  }, 2000);
}
// renderer.js の renderGrid() から呼ばれる（Launch-0ではグリッドは描画しない）
function l0OnGridRender() { l0PushState(); }

// ---------- ロック（メインと同じ：常に最前面） ----------
async function l0ToggleLock() {
  l0Locked = !!(await window.api.l0SetLock(!l0Locked));
  l0UpdateLockBtn();
}
function l0UpdateLockBtn() {
  const b = document.getElementById("lockBtn");
  if (!b) return;
  b.textContent = l0Locked ? "🔒" : "🔓";
  b.classList.toggle("active", l0Locked);
  b.title = l0Locked ? "ロック中（常に最前面）。クリックで解除" : "常に最前面に表示";
}

// ---------- Launch-0ウィンドウの初期化（renderer.js の init() から呼ばれる） ----------
async function initLaunch0() {
  document.body.classList.add("launch0-mode");
  applyTheme();
  // 画像背景のテーマでも、Launch-0は読みやすい単色にする
  const pt0 = settings.pageThemes && settings.pageThemes[0];
  if (pt0 && pt0.themeMode === "image") {
    const r = document.documentElement.style;
    const p = THEME_PRESETS.black;
    r.setProperty("--bg1", p.bg1); r.setProperty("--bg2", p.bg2); r.setProperty("--text", p.text); r.setProperty("--text-muted", p.textMuted);
    r.setProperty("--border", p.border);
    r.setProperty("--panel-solid", colorWithAlpha(p.panel, 0.76)); r.setProperty("--panel-alt-solid", colorWithAlpha(p.panelAlt, 0.76));
  }
  const init = await window.api.l0Init();
  l0Locked = !!(init && init.locked);
  l0UpdateLockBtn();
  window.api.onRemoteEvent(l0OnEvent);
  l0.tickTimer = setInterval(l0UpdateLive, 1000);
  l0InstallEnterKey();
  l0Render();
  l0LoadTs();
}

// ---------- Launch-0を開く（ハンバーガーメニューから）。確認の画面は挟まず、すぐ開く ----------
// 開いた直後は「接続方法・画面の選択」の画面で、「やめる」を押せば何も起きずに画面1へ戻る。
// スマホからの操作は、QRの読み取り・パスワード・PCでの許可がそろわない限り始まらない。
async function openLaunch0Confirm() {
  if (typeof IS_LAUNCH0 !== "undefined" && IS_LAUNCH0) return;
  if (!l0PagesWithTiles().length) { showToast("ボタンがある画面がないため、Launch-0は使えません"); return; }
  if (l0OpeningNow) return; // 連打・押しっぱなしで何度も開かない
  l0OpeningNow = true;
  try { await window.api.openLaunch0(); } catch (e) { showToast("Launch-0を開けませんでした"); }
  setTimeout(() => { l0OpeningNow = false; }, 1500);
}
let l0OpeningNow = false;

// ---------- Enterキー：接続の準備の画面は「QRを表示」、許可の画面は「許可」 ----------
function l0InstallEnterKey() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.repeat) return;     // 日本語入力の確定のEnter・押しっぱなしは無視
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (l0.phase === "pending") {
      const allow = document.getElementById("l0Allow");
      if (!allow || allow.disabled) return;
      e.preventDefault(); e.stopPropagation();                       // どのボタンにフォーカスがあっても、Enterは「許可」
      allow.click();
      return;
    }
    if (l0.phase !== "select" || l0.busy) return;
    const btn = document.getElementById("l0QrBtn");
    if (!btn || btn.disabled) return;                                // Tailscaleが使えない・ボタンがない画面では何もしない
    e.preventDefault(); e.stopPropagation();                         // 「やめる」などにフォーカスがあっても、そのボタンは押さない
    l0Begin();
  }, true);
}
