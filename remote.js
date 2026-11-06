"use strict";
// ============================================================================
// remote.js — Launch-0（スマホ操作）用の通信モジュール（メインプロセス）
//
// 方針
//  ・追加のnpmパッケージは使わない（Node標準の http だけ。スマホへの通知は SSE、スマホからの操作は POST）。
//  ・Tailscale専用。PCのTailscale用IPアドレス（100.64.0.0/10）だけで待ち受け（同じWi-Fiには窓口を開かない）、
//    接続してきた端末が「このPCと同じアカウントの端末」かをTailscaleに確かめてから、先へ進める。
//  ・スマホから届くのは「ボタンのID」と連番だけ。パス・コマンド・キー内容は一切受け取らない／送らない。
//    IDは接続開始時にPCが作った一覧（実行してよいボタンだけ）に載っているものだけを通す。
//  ・接続は最大1台。QR（トークン）＋6桁パスワード＋PC側の許可、の3つがそろって初めて操作できる。
//  ・Launch-0を開いている間だけサーバーが動く。切断・終了でサーバーごと止めて、セッションを破棄する。
// ============================================================================
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---- 調整できる値 ----
// パスワードは6文字：前半4文字が英小文字、後半2文字が数字。紛らわしい文字（l/o と 0/1）は除く。
const OTP_LETTERS = "abcdefghijkmnpqrstuvwxyz"; // 24文字（l・o を除く）
const OTP_DIGITS = "23456789";                   // 8文字（0・1 を除く）
const OTP_LETTER_COUNT = 4;
const OTP_DIGIT_COUNT = 2;
const OTP_LENGTH = OTP_LETTER_COUNT + OTP_DIGIT_COUNT;
const OTP_RE = /^[a-z]{4}[0-9]{2}$/;
const OTP_TTL_MS = 45 * 1000;           // QRとパスワードを作り直す間隔（待ち時間90秒の間に、最初と45秒後の2回表示される）
const OTP_GRACE_MS = 30 * 1000;         // 作り直した直後は、1つ前のものも、この時間だけ有効（入力の最中に切り替わっても困らないように）
const TICKET_TTL_MS = 3 * 60 * 1000;    // QRを読み取ってページを開いたあと、パスワードを入力できる時間
const WAIT_IDLE_MS = 90 * 1000;         // QRを出してから、誰も接続しに来ないまま、この時間たつとLaunch-0を閉じる
const OTP_MAX_FAILS = 3;                // 間違えてよい回数（QRを出している間の合計。超えたらQRとパスワードを作り直す）
const APPROVAL_TIMEOUT_MS = 20 * 1000;  // PCの許可待ちの最大時間
const STALE_AFTER_MS = 120 * 1000;      // これだけ応答が無いと「通信が途切れている」扱い（警告）。スマホ側（mobile.html の STALE_MS）と同じ値にする
const DROP_AFTER_MS = 360 * 1000;       // これだけ応答が無いと切断（スマホ側の LOST_MS と同じ値）
const IDLE_LIMIT_MS = 30 * 60 * 1000;   // 無操作で自動切断
const MAX_SESSION_MS = 3 * 60 * 60 * 1000; // 最大接続時間
const WARN_BEFORE_MS = 60 * 1000;       // 自動切断の何ミリ秒前に警告するか
const HIDDEN_LIMIT_MS = 5 * 60 * 1000;  // スマホの画面が裏に回ったまま、これを超えたら切断
const TAP_MIN_GAP_MS = 100;             // 全ボタン共通の最短間隔
const TAP_SAME_TILE_GAP_MS = 220;       // 同じボタンの最短間隔
const TAP_BURST_COUNT = 30;             // 受け付けたタップがこの回数を
const TAP_BURST_WINDOW_MS = 4000;       // この時間内に超えたら「速すぎる」
const TAP_ATTEMPT_LIMIT = 60;           // 断った分も含めた送信回数がこの時間内にこれを超えたら「速すぎる」
const TAP_ABUSE_LIMIT = 10;             // 「速すぎる」がこの回数に達したら切断
const MAX_INFLIGHT = 3;                 // PCが処理中のタップの最大数
const EXEC_MAX_MS = 120 * 1000;         // 1つの操作（マルチ操作など）の実行を待つ最大時間。これを過ぎたら、固まったものとして扱う
const PEER_RECHECK_MS = 5 * 1000;       // Tailscaleモード：接続相手の確認・経路の確認の間隔
const MAX_CONN_PER_IP = 12;             // 同じ相手からの同時接続の上限（ブラウザは1つのページで数本つなぐ）
const MAX_CONN_TOTAL = 64;              // 全体の同時接続の上限
const REQ_PER_MIN_PER_IP = 600;         // 同じ相手からのリクエストの上限（1分あたり。通常の使用は100未満）
const IMAGES_TOTAL_MAX = 24 * 1024 * 1024; // スマホ用アイコン画像の合計の上限
const AUTH_RATE_LIMIT = 12;             // 認証リクエストの回数/分（IPごと）
const MAX_BODY_BYTES = 4096;
const TICK_MS = 1000;
const IP_CHECK_MS = 10 * 1000;

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function randHex(bytes) { return crypto.randomBytes(bytes).toString("hex"); }
// 偏りが出ないよう、range の約数で割り切れない範囲の乱数は捨てて引き直す（拒否サンプリング）
function randIndex(range) {
  const limit = 256 - (256 % range);
  for (;;) {
    const buf = crypto.randomBytes(16);
    for (let i = 0; i < buf.length; i++) if (buf[i] < limit) return buf[i] % range;
  }
}
function makeOtp() {
  let s = "";
  for (let i = 0; i < OTP_LETTER_COUNT; i++) s += OTP_LETTERS[randIndex(OTP_LETTERS.length)];
  for (let i = 0; i < OTP_DIGIT_COUNT; i++) s += OTP_DIGITS[randIndex(OTP_DIGITS.length)];
  return s;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function normAddr(a) { return String(a || "").replace(/^::ffff:/i, ""); }
function isTailnetAddr(raw) {
  const m = normAddr(raw).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127; // 100.64.0.0/10
}

function createRemote(opts) {
  const rawEmit = typeof opts.emit === "function" ? opts.emit : () => {};
  const emit = (evt) => { try { rawEmit(evt); } catch (e) { /* PC側の処理の失敗で通信を止めない */ } };
  const mobileHtmlPath = opts.mobileHtmlPath;
  const appVersion = String(opts.appVersion || "");
  const ts = opts.tailscale || null; // tailscale.js のクライアント（Tailscaleモードで使う）
  const mode = "tailscale";          // 接続方法はTailscaleだけ（同じWi-Fiモードは廃止）

  let server = null;
  let tick = null;
  let port = 0;
  let ip = "";
  let pcName = ""; // このPCのTailscale上の名前（スマホの「接続の安全」表示用）
  let phase = "idle"; // idle | waiting | pending | active
  let qrToken = "";
  let otp = "";
  let otpExpiresAt = 0;
  let otpFails = 0;
  let prevToken = "", prevOtp = "", prevUntil = 0; // 1つ前のQR・パスワード（切り替え直後だけ有効）
  let waitDeadline = 0;                              // これを過ぎても誰も来なければLaunch-0を閉じる
  const tickets = new Map();                         // ページを開いたスマホに渡す入力用の許可証
  let snapshotJson = "";
  let allowedIds = new Set();
  let multiIds = new Set(); // allowedIdsのうち、マルチ操作のボタン
  let imageMap = new Map(); // tileId -> { mime, buf }
  let session = null;
  let lastEnded = null; // 直前に終わった接続の理由（スマホが戻ってきたとき、本当の理由を返すため。10分だけ覚える）
  let lastIpCheck = 0;
  let lastInfoAt = 0;
  const authLog = new Map(); // ip -> [timestamps]
  const rejectedLog = new Map(); // ip -> 最後に「断った」と通知した時刻
  const reqLog = new Map();      // ip -> [timestamps]（全リクエストの量の制限用）
  const connByIp = new Map();    // ip -> 同時接続数
  let totalConns = 0;
  // 実行中の操作（seq -> { at, multi }）。接続が終わっても、PCでの実行が終わるまでは残す（Launch-0を閉じる判断に使う）
  const exec = new Map();
  let lastExecSig = "";
  let peerChecking = false, lastPeerCheck = 0;

  function now() { return Date.now(); }

  // ---------- 送信 ----------
  function sseWrite(res, obj) {
    try { res.write("event: msg\ndata: " + JSON.stringify(obj) + "\n\n"); return true; } catch (e) { return false; }
  }
  function toPhone(obj) {
    if (session && session.sse) {
      if (!sseWrite(session.sse, obj)) session.sse = null;
    }
  }
  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
  function text(res, code, body, type) {
    res.writeHead(code, {
      "Content-Type": type || "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  }

  // ---------- 認証まわり ----------
  // 45秒ごとの自動更新。QRもパスワードも新しくし、1つ前のものは30秒だけ残す。
  // 間違えた回数は更新しても戻さない（QRを出している間の合計で数える）。
  function rotateCredentials(reason) {
    prevToken = qrToken; prevOtp = otp; prevUntil = now() + OTP_GRACE_MS;
    qrToken = randHex(16);
    otp = makeOtp();
    otpExpiresAt = now() + OTP_TTL_MS;
    emit({ type: "credentials", url: buildUrl(), otp, otpExpiresAt, waitDeadline, reason: reason || "refresh" });
  }
  // 最初・ロック・やり直し：1つ前の分は残さず、間違えた回数もリセットする。
  function renewAll(reason) {
    prevToken = ""; prevOtp = ""; prevUntil = 0; otpFails = 0;
    tickets.clear();
    qrToken = randHex(16);
    otp = makeOtp();
    otpExpiresAt = now() + OTP_TTL_MS;
    waitDeadline = now() + WAIT_IDLE_MS;
    emit({ type: "credentials", url: buildUrl(), otp, otpExpiresAt, waitDeadline, reason: reason || "" });
  }
  function tokenOk(k) {
    if (typeof k !== "string" || !k) return false;
    if (qrToken && safeEq(k, qrToken)) return true;
    return !!prevToken && now() <= prevUntil && safeEq(k, prevToken);
  }
  function otpOk(v) {
    if (otp && safeEq(v, otp)) return true;
    return !!prevOtp && now() <= prevUntil && safeEq(v, prevOtp);
  }
  function ticketOk(k, addr) {
    if (typeof k !== "string" || !k) return false;
    const e = tickets.get(k);
    return !!e && e.ip === addr && now() <= e.until;
  }
  function issueTicket(addr) {
    const t = now();
    for (const [key, e] of tickets) if (t > e.until) tickets.delete(key);
    while (tickets.size >= 20) tickets.delete(tickets.keys().next().value);
    const ticket = randHex(16);
    tickets.set(ticket, { ip: addr, until: t + TICKET_TTL_MS });
    return ticket;
  }
  // QRを出している間に、QRの正しいトークンを持った要求（ページを開く・パスワードを送る）が来たら、待ち時間を延ばす。
  // 無効な要求（でたらめなURLなど）は延長しない。
  function touchWait() {
    if (phase !== "waiting") return;
    waitDeadline = now() + WAIT_IDLE_MS;
    emit({ type: "wait-activity", waitDeadline });
  }
  // ---------- 実行中の操作 ----------
  function pruneExec() {
    const t = now();
    for (const [k, e] of exec) if (t - e.at > EXEC_MAX_MS) exec.delete(k);
  }
  function isBusy() { pruneExec(); return exec.size > 0; }
  function multiRunning() { for (const e of exec.values()) if (e.multi) return true; return false; }
  // 実行中かどうかが変わったら、PCとスマホに知らせる
  function execSig() { return (exec.size > 0) + ":" + multiRunning() + ":" + exec.size; }
  function broadcastExec() {
    pruneExec();
    const busy = exec.size > 0, multi = multiRunning();
    const sig = execSig();
    if (sig === lastExecSig) return;
    lastExecSig = sig;
    toPhone({ type: "exec", busy, multi });
    emit({ type: "exec", busy, multi, count: exec.size });
  }

  // ---------- Tailscaleモード：接続相手の確認 ----------
  function remoteAllowed(addr) {
    if (typeof opts.remoteFilter === "function") return !!opts.remoteFilter(addr, mode); // テスト専用
    return isTailnetAddr(addr); // Tailscaleの番号帯（100.64.0.0/10）以外からは受け付けない
  }
  function reportRejected(addr, reason) {
    const t = now();
    if (t - (rejectedLog.get(addr) || 0) < 30000) return;
    rejectedLog.set(addr, t);
    if (rejectedLog.size > 200) rejectedLog.delete(rejectedLog.keys().next().value);
    emit({ type: "peer-rejected", ip: addr, reason });
  }
  function peerInfo(r) {
    return r && r.ok ? { name: r.name, os: r.os, login: r.login, display: r.display, path: r.path, key: r.key || "" } : null;
  }
  // 画面やスマホに渡す情報からは、内部の識別（key）を除く
  function publicPeer(p) {
    return p ? { name: p.name, os: p.os, login: p.login, display: p.display, path: p.path } : null;
  }
  // 接続中の相手が、まだ同じアカウントの端末か／経路が変わっていないかを、定期的に確かめる
  function checkPeer() {
    if (!ts || peerChecking) return;
    if (now() - lastPeerCheck < PEER_RECHECK_MS) return;
    lastPeerCheck = now();
    const s = session;
    peerChecking = true;
    if (!s) {
      // 待機中は、Tailscale自体が止まっていないかだけを確認する
      ts.status().then((st) => { peerChecking = false; if (!session && phase === "waiting" && !st.ok) finish("tailscale-down"); }, () => { peerChecking = false; });
      return;
    }
    ts.routeFor(s.ip).then((r) => {
      peerChecking = false;
      if (session !== s) return;
      if (!r.ok) { finish(r.reason === "tailscale-down" ? "tailscale-down" : "identity"); return; }
      if (s.peerKey && r.key && r.key !== s.peerKey) { finish("identity"); return; } // 同じIPアドレスの端末が入れ替わった
      const path = r.path || { kind: "unknown", detail: "" };
      if (!s.route || s.route.kind !== path.kind || s.route.detail !== path.detail) {
        s.route = path;
        emit({ type: "route", kind: path.kind, detail: path.detail });
      }
    }, () => { peerChecking = false; });
  }

  function buildUrl() { return "http://" + ip + ":" + port + "/?k=" + qrToken; }

  function rateLimited(addr) {
    const t = now();
    const list = (authLog.get(addr) || []).filter((x) => t - x < 60000);
    list.push(t);
    authLog.set(addr, list);
    if (authLog.size > 200) for (const [k, v] of authLog) if (!v.length || t - v[v.length - 1] > 60000) authLog.delete(k);
    return list.length > AUTH_RATE_LIMIT;
  }
  // 認証以外も含めた、全リクエストの量の制限（大量に送られても、アプリが重くならないように）
  function tooManyRequests(addr) {
    const t = now();
    const list = (reqLog.get(addr) || []).filter((x) => t - x < 60000);
    list.push(t);
    reqLog.set(addr, list);
    if (reqLog.size > 200) for (const [k, v] of reqLog) if (!v.length || t - v[v.length - 1] > 60000) reqLog.delete(k);
    return list.length > REQ_PER_MIN_PER_IP;
  }

  // ---------- セッション ----------
  function newSession(addr, ua, peer) {
    const t = now();
    return {
      sid: randHex(24), ip: addr, ua: String(ua || "").slice(0, 200), peer: peer || null, peerKey: peer && peer.key ? peer.key : "", route: peer && peer.path ? peer.path : null,
      state: "pending", sse: null,
      createdAt: t, lastSeen: t, lastActivity: t, approvalDeadline: t + APPROVAL_TIMEOUT_MS,
      hiddenSince: 0, paused: false, stalled: false,
      seqLast: 0, lastTapAt: 0, tileLast: new Map(), tapTimes: [], attempts: [], abuse: 0,
      page: 0, warned: { idle: false, max: false }, maxDeadline: 0,
    };
  }
  // スマホの「接続の安全」表示に渡す情報（PC名・経路の種類・自動切断までの残り秒）。アカウント名やIPアドレスは含めない。
  function infoPayload(s) {
    const t = now();
    return {
      pc: pcName,
      route: s && s.route && typeof s.route.kind === "string" ? s.route.kind : "unknown",
      idleLeft: s ? Math.max(0, Math.round((IDLE_LIMIT_MS - (t - s.lastActivity)) / 1000)) : 0,
      maxLeft: s && s.maxDeadline ? Math.max(0, Math.round((s.maxDeadline - t) / 1000)) : 0,
    };
  }
  // 接続中（またはPC側の都合）の終了。サーバーはそのままだが、このあとLaunch-0側が全体を閉じる。
  function finish(reason, notifyPhone) {
    const s = session;
    if (s && notifyPhone !== false && s.sse) {
      sseWrite(s.sse, { type: "bye", reason });
      try { s.sse.end(); } catch (e) { /* 無視 */ }
    }
    if (s) lastEnded = { sid: s.sid, ip: s.ip, reason, at: now() };
    session = null;
    phase = "idle";
    emit({ type: "ended", reason });
  }
  // 許可待ち中の失敗（拒否・時間切れ・スマホ側の取りやめ）。Launch-0は閉じず、QRとパスワードを作り直して待機に戻る。
  function dropPending(reason, notifyPhone) {
    const s = session;
    if (s && notifyPhone !== false && s.sse) {
      sseWrite(s.sse, { type: "bye", reason });
      try { s.sse.end(); } catch (e) { /* 無視 */ }
    }
    session = null;
    phase = "waiting";
    renewAll("retry");
    emit({ type: "pending-ended", reason });
  }
  function stopServer() {
    if (tick) { clearInterval(tick); tick = null; }
    if (server) {
      try { server.close(); } catch (e) { /* 無視 */ }
      try { if (typeof server.closeAllConnections === "function") server.closeAllConnections(); } catch (e) { /* 無視 */ }
      server = null;
    }
    qrToken = ""; otp = ""; prevToken = ""; prevOtp = ""; prevUntil = 0; waitDeadline = 0; tickets.clear();
    snapshotJson = ""; allowedIds = new Set(); multiIds = new Set(); imageMap = new Map();
    phase = "idle";
  }

  function getSession(req, res, sidFrom) {
    const sid = sidFrom;
    if (!session || typeof sid !== "string" || !safeEq(sid, session.sid)) {
      const body = { ok: false, error: "session" };
      if (lastEnded && typeof sid === "string" && safeEq(sid, lastEnded.sid) && normAddr(req.socket.remoteAddress) === lastEnded.ip && now() - lastEnded.at < 10 * 60 * 1000) body.reason = lastEnded.reason;
      json(res, 401, body);
      return null;
    }
    if (normAddr(req.socket.remoteAddress) !== session.ip) { json(res, 403, { ok: false, error: "ip" }); return null; }
    return session;
  }

  function readBody(req, res, cb) {
    const ct = String(req.headers["content-type"] || "");
    if (!/^application\/json/i.test(ct)) { json(res, 415, { ok: false, error: "type" }); return; }
    let size = 0; const chunks = [];
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { aborted = true; json(res, 413, { ok: false, error: "size" }); try { req.destroy(); } catch (e) { /* 無視 */ } return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      let obj = null;
      try { obj = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { obj = null; }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) { json(res, 400, { ok: false, error: "json" }); return; }
      try { cb(obj); } catch (e) { try { if (!res.headersSent) json(res, 400, { ok: false, error: "bad" }); } catch (e2) { /* 無視 */ } }
    });
    req.on("error", () => {});
  }

  // ---------- HTTP ----------
  function handle(req, res) {
    // どんな不正なリクエストが来ても、例外でアプリ本体を落とさない
    try {
      const addr = normAddr(req.socket.remoteAddress);
      if (!remoteAllowed(addr)) { res.writeHead(403); res.end(); return; }
      if (tooManyRequests(addr)) { res.writeHead(429, { "Retry-After": "30" }); res.end(); return; }
      // Tailscaleモード：このPCと同じアカウントの端末だけを通す（確認できなければ断る＝安全側）
      if (!ts) { res.writeHead(403); res.end(); return; }
      ts.peerFor(addr).then((r) => {
        try {
          if (!r.ok) { reportRejected(addr, r.reason); res.writeHead(403); res.end(); return; }
          handleInner(req, res, r);
        } catch (e) {
          try { if (!res.headersSent) res.writeHead(400); res.end(); } catch (e2) { /* 無視 */ }
        }
      }, () => { try { res.writeHead(403); res.end(); } catch (e) { /* 無視 */ } });
    } catch (e) {
      try { if (!res.headersSent) res.writeHead(400); res.end(); } catch (e2) { /* 無視 */ }
    }
  }
  function handleInner(req, res, peer) {
    const remote = normAddr(req.socket.remoteAddress);
    // Tailscaleモード：接続中のIPアドレスに、別の端末がすり替わっていたら、切断して断る
    if (peer && session && remote === session.ip && session.peerKey && peer.key && peer.key !== session.peerKey) {
      res.writeHead(403); res.end();
      finish("identity");
      return;
    }
    // Hostヘッダーは自分のIP:ポート（またはlocalhost）だけ許可（なりすまし・DNSリバインディング対策）
    const host = String(req.headers.host || "");
    if (host !== ip + ":" + port && host !== "localhost:" + port && host !== "127.0.0.1:" + port) { res.writeHead(400); res.end(); return; }
    // ブラウザの別サイトからの呼び出しは拒否（Originが付くのは自分のページ以外から来たとき）
    const origin = req.headers.origin;
    if (origin && origin !== "http://" + host) { res.writeHead(403); res.end(); return; }

    let u;
    try { u = new URL(req.url, "http://" + host); } catch (e) { res.writeHead(400); res.end(); return; }
    const p = u.pathname;

    if (req.method === "GET" && p === "/") {
      const k = u.searchParams.get("k") || "";
      const sidParam = u.searchParams.get("sid") || "";
      // QRのトークン、または（再読み込み用に）接続中の自分のセッションIDがあれば、ページを返す
      const okByToken = tokenOk(k);
      const okBySid = !!session && !!sidParam && safeEq(sidParam, session.sid) && remote === session.ip;
      if (!okByToken && !okBySid) {
        return text(res, 403, "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><body style='font-family:sans-serif;padding:24px'><h3>このURLは無効です</h3><p>PCのQRコードは45秒ごとに新しくなります。PCのLaunch-0に表示されたQRコードを、もう一度読み取ってください。</p></body>", "text/html; charset=utf-8");
      }
      // QRで開いたときだけ、パスワード入力用の許可証（3分間有効・このスマホだけ）をページに埋め込む
      let ticket = "";
      if (okByToken) { touchWait(); ticket = issueTicket(remote); }
      let html = "";
      try { html = fs.readFileSync(mobileHtmlPath, "utf8"); } catch (e) { return text(res, 500, "mobile page not found"); }
      html = html.split("__LAUNCHK_VERSION__").join(appVersion).split("__LAUNCHK_TICKET__").join(ticket).split("__LAUNCHK_MODE__").join(mode);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return res.end(html);
    }

    if (req.method === "GET" && p === "/api/events") {
      const s = getSession(req, res, u.searchParams.get("sid"));
      if (!s) return;
      if (s.sse) { try { s.sse.end(); } catch (e) { /* 無視 */ } }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 2000\n\n");
      s.sse = res;
      if (!s.stalled) s.lastSeen = now(); // 途切れ中は、再接続だけでは「生きている」とみなさない（/api/ping が届いてから再開する）
      req.on("close", () => { if (session === s && s.sse === res) s.sse = null; });
      if (s.state === "pending") sseWrite(res, { type: "pending" });
      else sseWrite(res, { type: "ready", snapshot: JSON.parse(snapshotJson), paused: s.paused, page: s.page, seq: s.seqLast, mode, info: infoPayload(s), exec: { busy: exec.size > 0, multi: multiRunning() } });
      return;
    }

    if (req.method === "GET" && p.indexOf("/api/img/") === 0) {
      const s = getSession(req, res, u.searchParams.get("sid"));
      if (!s) return;
      let id = ""; try { id = decodeURIComponent(p.slice("/api/img/".length)); } catch (e) { id = ""; }
      const im = SAFE_ID_RE.test(id) ? imageMap.get(id) : null;
      if (!im) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": im.mime, "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff", "Content-Length": im.buf.length });
      return res.end(im.buf);
    }

    if (req.method !== "POST") { res.writeHead(404); return res.end(); }

    if (p === "/api/auth") {
      return readBody(req, res, (b) => {
        if (rateLimited(remote)) return json(res, 429, { ok: false, error: "rate" });
        if (phase !== "waiting") {
          if (session) emit({ type: "busy-attempt", ip: remote });
          return json(res, 409, { ok: false, error: "busy" });
        }
        const k = typeof b.k === "string" ? b.k : "";
        const given = typeof b.otp === "string" ? b.otp.trim().toLowerCase() : "";
        // QRのトークン（または、QRで開いたページに埋め込まれた許可証）が有効でなければ、パスワードの確認まで進まない
        if (!(tokenOk(k) || ticketOk(k, remote))) return json(res, 403, { ok: false, error: "token" });
        touchWait();
        if (!OTP_RE.test(given) || !otpOk(given)) {
          otpFails += 1;
          emit({ type: "auth-fail", count: otpFails, max: OTP_MAX_FAILS, ip: remote });
          if (otpFails >= OTP_MAX_FAILS) {
            renewAll("locked");
            return json(res, 403, { ok: false, error: "locked" });
          }
          return json(res, 403, { ok: false, error: "otp", left: OTP_MAX_FAILS - otpFails });
        }
        // パスワードは一度きり。ここで失効させ、PCの許可待ちへ。
        otp = ""; otpExpiresAt = 0; qrToken = ""; prevToken = ""; prevOtp = ""; prevUntil = 0; waitDeadline = 0; tickets.clear();
        session = newSession(remote, req.headers["user-agent"], peerInfo(peer));
        phase = "pending";
        emit({ type: "pending", ip: remote, ua: session.ua, deadline: session.approvalDeadline, mode, peer: publicPeer(session.peer) });
        return json(res, 200, { ok: true, sid: session.sid });
      });
    }

    // パスワード入力画面を開いているスマホが、「PCがまだ待っているか」を確かめるための窓口。
    // 待機時間は延ばさない（延ばすと、スマホを開いたままPCが閉じなくなる）。パスワードの試行にも数えない。
    if (p === "/api/probe") {
      return readBody(req, res, (b) => {
        const k = typeof b.k === "string" ? b.k : "";
        if (phase !== "waiting") return json(res, 409, { ok: false, error: session ? "busy" : "closed" });
        if (!(tokenOk(k) || ticketOk(k, remote))) return json(res, 403, { ok: false, error: "token" });
        return json(res, 200, { ok: true });
      });
    }

    if (p === "/api/tap") {
      return readBody(req, res, (b) => {
        const s = getSession(req, res, req.headers["x-sid"]);
        if (!s) return;
        // 通信が途切れている間（stalled）は、操作を受け付けない。/api/ping が届いて、つながりが戻ってから再開する。
        // （途切れ中に、セッションIDだけを使って操作されることを防ぐ。lastSeen も更新しない）
        if (s.stalled) return json(res, 409, { ok: false, error: "stalled" });
        s.lastSeen = now();
        if (s.state !== "active") return json(res, 409, { ok: false, error: "state" });
        const tile = typeof b.tile === "string" ? b.tile : "";
        // 連番は正の整数で、前回からの増え方が常識的な範囲のものだけ受け付ける（極端な値で、以後の操作が全部断られるのを防ぐ）
        const seq = Number.isSafeInteger(b.seq) && b.seq > 0 && b.seq <= s.seqLast + 10000 ? b.seq : -1;
        if (!SAFE_ID_RE.test(tile) || seq <= s.seqLast) return json(res, 400, { ok: false, error: "bad" });
        s.seqLast = seq;
        // 断られた分も含めて、送信が多すぎる場合は「速すぎる」。続くようなら切断する。
        const tNow = now();
        s.attempts = s.attempts.filter((x) => tNow - x < TAP_BURST_WINDOW_MS);
        s.attempts.push(tNow);
        if (s.attempts.length > TAP_ATTEMPT_LIMIT) {
          s.abuse += 1;
          if (s.abuse >= TAP_ABUSE_LIMIT) { json(res, 200, { ok: false, error: "abuse", seq }); return finish("abuse"); }
          return json(res, 200, { ok: false, error: "fast", seq });
        }
        if (s.paused) return json(res, 200, { ok: false, error: "paused", seq });
        if (!allowedIds.has(tile)) return json(res, 200, { ok: false, error: "blocked", seq });
        // マルチ操作の実行中は、そのマルチ操作がすべて終わるまで、ほかのボタンは受け付けない。
        // また、ほかの操作が実行中のあいだは、マルチ操作も始めない（途中で割り込まれて混ざらないように）。
        pruneExec();
        const isMulti = multiIds.has(tile);
        if (multiRunning()) return json(res, 200, { ok: false, error: "multibusy", seq });
        if (isMulti && exec.size > 0) return json(res, 200, { ok: false, error: "busy", seq });
        const t = now();
        s.tapTimes = s.tapTimes.filter((x) => t - x < TAP_BURST_WINDOW_MS);
        if (s.tapTimes.length >= TAP_BURST_COUNT) {
          s.abuse += 1;
          if (s.abuse >= TAP_ABUSE_LIMIT) { json(res, 200, { ok: false, error: "abuse", seq }); return finish("abuse"); }
          return json(res, 200, { ok: false, error: "fast", seq });
        }
        if (t - s.lastTapAt < TAP_MIN_GAP_MS || t - (s.tileLast.get(tile) || 0) < TAP_SAME_TILE_GAP_MS) return json(res, 200, { ok: false, error: "fast", seq });
        if (exec.size >= MAX_INFLIGHT) return json(res, 200, { ok: false, error: "busy", seq });
        s.tapTimes.push(t); s.lastTapAt = t; s.tileLast.set(tile, t);
        s.lastActivity = t; s.warned.idle = false;
        exec.set(seq, { at: t, multi: isMulti });
        emit({ type: "tap", tileId: tile, seq });
        broadcastExec();
        return json(res, 200, { ok: true, seq });
      });
    }

    if (p === "/api/ping") {
      return readBody(req, res, (b) => {
        const s = getSession(req, res, req.headers["x-sid"]);
        if (!s) return;
        s.lastSeen = now();
        if (s.stalled) { s.stalled = false; emit({ type: "resumed" }); }
        const hidden = b.hidden === true;
        if (hidden && !s.hiddenSince) s.hiddenSince = now();
        if (!hidden) s.hiddenSince = 0;
        return json(res, 200, { ok: true, paused: s.paused, state: s.state });
      });
    }

    if (p === "/api/page") {
      return readBody(req, res, (b) => {
        const s = getSession(req, res, req.headers["x-sid"]);
        if (!s) return;
        if (s.stalled) return json(res, 409, { ok: false, error: "stalled" }); // 途切れ中は、画面の切り替えも受け付けない（lastSeen も更新しない）
        s.lastSeen = now();
        if (s.state !== "active") return json(res, 409, { ok: false });
        const n = Number.isInteger(b.page) ? b.page : -1;
        if (n < 0 || n > 20) return json(res, 400, { ok: false });
        s.page = n; s.lastActivity = now(); s.warned.idle = false;
        emit({ type: "phone-page", page: n });
        return json(res, 200, { ok: true });
      });
    }

    if (p === "/api/extend") {
      return readBody(req, res, () => {
        const s = getSession(req, res, req.headers["x-sid"]);
        if (!s) return;
        extend();
        return json(res, 200, { ok: true });
      });
    }

    if (p === "/api/bye") {
      return readBody(req, res, () => {
        const s = getSession(req, res, req.headers["x-sid"]);
        if (!s) return;
        // 操作の実行中は、それが終わるまで切断できない（PCで途中まで実行された状態で止まらないように）
        if (s.state === "active" && isBusy()) { emit({ type: "disconnect-refused", from: "phone" }); return json(res, 200, { ok: false, error: "busy" }); }
        json(res, 200, { ok: true });
        if (s.state === "pending") dropPending("user-phone", false);
        else finish("user-phone", false);
      });
    }

    res.writeHead(404); res.end();
  }

  // ---------- 定期チェック ----------
  function onTick() {
    const t = now();
    if (phase === "waiting") {
      if (otpExpiresAt && t > otpExpiresAt) rotateCredentials("refresh");
      // QRを出してから90秒、誰も（有効な要求を）送って来なければ、Launch-0ごと閉じる
      if (waitDeadline && t > waitDeadline) return finish("wait-timeout");
    }
    if (t - lastIpCheck > IP_CHECK_MS) {
      lastIpCheck = t;
      // Tailscaleの状態・接続相手は、下の checkPeer() が定期的に確認する
    }
    broadcastExec();
    checkPeer();
    if (!session) return;
    const s = session;
    if (s.state === "pending") {
      if (t > s.approvalDeadline) dropPending("approval-timeout");
      return;
    }
    // 通信状態
    const silent = t - s.lastSeen;
    if (silent > DROP_AFTER_MS) return finish("timeout", false);
    if (silent > STALE_AFTER_MS && !s.stalled) { s.stalled = true; emit({ type: "stalled" }); }
    if (s.hiddenSince && t - s.hiddenSince > HIDDEN_LIMIT_MS) return finish("phone-hidden");
    // 無操作・最大時間
    const idleLeft = IDLE_LIMIT_MS - (t - s.lastActivity);
    const maxLeft = s.maxDeadline - t;
    if (idleLeft <= 0) return finish("idle");
    if (maxLeft <= 0) return finish("maxtime");
    if (idleLeft <= WARN_BEFORE_MS && !s.warned.idle) { s.warned.idle = true; const secs = Math.ceil(idleLeft / 1000); emit({ type: "warn", kind: "idle", secs }); toPhone({ type: "warn", kind: "idle", secs }); }
    if (maxLeft <= WARN_BEFORE_MS && !s.warned.max) { s.warned.max = true; const secs = Math.ceil(maxLeft / 1000); emit({ type: "warn", kind: "max", secs }); toPhone({ type: "warn", kind: "max", secs }); }
    // スマホの「接続の安全」表示の更新（5秒ごと）
    if (t - lastInfoAt >= 5000) { lastInfoAt = t; toPhone({ type: "info", info: infoPayload(s) }); }
    // SSEの生存確認（コメント行。iOSやルーターに切られにくくする）
    if (s.sse) { try { s.sse.write(": ping\n\n"); } catch (e) { s.sse = null; } }
  }

  // ---------- 外から呼ぶ操作 ----------
  async function start(args) {
    if (server) throw new Error("already running");
    let bindAddr;
    let tsInfo = null;
    if (!ts) throw new Error("tailscale-unavailable");
    const st = await ts.status();
    if (!st.ok) throw new Error("ts-" + (st.reason || "error"));
    ip = opts.forceIp || st.selfIp;
    if (!opts.forceIp && !isTailnetAddr(ip)) throw new Error("ts-no-ip"); // Tailscaleの番号帯でなければ開始しない（安全側）
    bindAddr = ip; // 同じWi-Fiの窓口は開かず、Tailscale用のIPアドレスだけで待ち受ける
    tsInfo = { selfName: st.selfName, login: st.login, display: st.display, tailnet: st.tailnet };
    pcName = String(st.selfName || "").slice(0, 60);
    lastEnded = null;
    exec.clear(); lastExecSig = "false:false:0"; lastPeerCheck = 0; reqLog.clear();
    snapshotJson = JSON.stringify(args.snapshot || {});
    allowedIds = new Set(Array.isArray(args.allowedIds) ? args.allowedIds.filter((x) => SAFE_ID_RE.test(String(x))).map(String) : []);
    multiIds = new Set((Array.isArray(args.multiIds) ? args.multiIds : []).map(String).filter((x) => allowedIds.has(x)));
    imageMap = new Map();
    let imgTotal = 0;
    if (args.images && typeof args.images === "object") {
      for (const id of Object.keys(args.images)) {
        if (!SAFE_ID_RE.test(id)) continue;
        const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(args.images[id] || ""));
        if (!m) continue;
        const buf = Buffer.from(m[2], "base64");
        if (buf.length > 600 * 1024) continue;
        if (imgTotal + buf.length > IMAGES_TOTAL_MAX) continue; // 合計の上限を超える分は送らない（標準のアイコンで表示される）
        imgTotal += buf.length;
        imageMap.set(id, { mime: m[1], buf });
      }
    }
    server = http.createServer({ connectionsCheckingInterval: 3000 }, handle); // タイムアウトの点検を3秒ごとに行う（既定は30秒）
    server.on("clientError", (err, socket) => { try { socket.destroy(); } catch (e) { /* 無視 */ } });
    // 同時接続の数を制限する（1台の相手が接続を使い切って、本物のスマホが入れなくなるのを防ぐ）
    connByIp.clear(); totalConns = 0;
    server.on("connection", (sock) => {
      const a = normAddr(sock.remoteAddress);
      const n = (connByIp.get(a) || 0) + 1;
      if (n > MAX_CONN_PER_IP || totalConns >= MAX_CONN_TOTAL) { try { sock.destroy(); } catch (e) { /* 無視 */ } return; }
      connByIp.set(a, n); totalConns += 1;
      sock.on("close", () => {
        totalConns = Math.max(0, totalConns - 1);
        const c = (connByIp.get(a) || 1) - 1;
        if (c <= 0) connByIp.delete(a); else connByIp.set(a, c);
      });
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 15000; // 「リクエストを受け取り終えるまで」の上限。SSE（応答を流し続ける）には影響しない。途中で止まった相手につながりっぱなしにされない
    // 待ち受け開始後に起きたサーバーのエラーで、アプリが落ちないようにする（起きたら、安全のため接続を終了する）
    server.on("error", () => { try { finish("error"); } catch (e) { /* 無視 */ } });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, bindAddr, () => resolve());
    });
    port = server.address().port;
    phase = "waiting";
    session = null;
    lastIpCheck = now();
    renewAll("start");
    tick = setInterval(onTick, TICK_MS);
    return { url: buildUrl(), otp, otpExpiresAt, waitDeadline, ip, port, mode, tailscale: tsInfo, candidates: [ip] };
  }
  function approve(ok) {
    if (!session || session.state !== "pending") return false;
    if (!ok) { dropPending("denied"); return true; }
    const t = now();
    session.state = "active";
    session.lastSeen = t; session.lastActivity = t; session.maxDeadline = t + MAX_SESSION_MS;
    phase = "active";
    toPhone({ type: "ready", snapshot: JSON.parse(snapshotJson), paused: false, page: session.page, seq: session.seqLast, mode, info: infoPayload(session), exec: { busy: exec.size > 0, multi: multiRunning() } });
    lastExecSig = execSig(); // "ready" にすでに実行状態を含めたので、同じ内容を重ねて送らない
    emit({ type: "connected", ip: session.ip, ua: session.ua, since: t, mode, peer: publicPeer(session.peer), route: session.route });
    return true;
  }
  function pause(flag) {
    if (!session || session.state !== "active") return;
    session.paused = !!flag;
    toPhone({ type: "paused", paused: session.paused });
  }
  function extend() {
    if (!session || session.state !== "active") return;
    const t = now();
    session.lastActivity = t; session.warned.idle = false;
    if (session.maxDeadline - t < MAX_SESSION_MS) { session.maxDeadline = t + MAX_SESSION_MS; session.warned.max = false; }
    toPhone({ type: "extended" });
    emit({ type: "extended" });
  }
  function tapResult(seq, ok, msg) {
    // 接続がすでに終わっていても、PCでの実行が終わったことは記録する（Launch-0を閉じてよいかの判断に使う）
    exec.delete(seq);
    if (session) toPhone({ type: "tapres", seq, ok: !!ok, msg: typeof msg === "string" ? msg.slice(0, 120) : "" });
    broadcastExec();
  }
  function pushState(state) {
    if (!session || session.state !== "active") return;
    toPhone({ type: "state", state });
  }
  // 自分の操作による切断（PCの「切断」ボタン）は、操作の実行中は受け付けない（完了してから切る）。
  // 通信の途切れ・スリープなど、こちらで止められない理由での切断は、そのまま実行する。
  function disconnect(reason) {
    if (!server) return false;
    const r = reason || "user-pc";
    if (r === "user-pc" && session && session.state === "active" && isBusy()) { emit({ type: "disconnect-refused", from: "pc" }); return false; }
    finish(r);
    return true;
  }
  function shutdown(reason) {
    // サーバーごと止める（Launch-0を閉じる・アプリ終了）。接続中ならスマホへお知らせしてから切る。
    if (session && session.sse) { sseWrite(session.sse, { type: "bye", reason: reason || "closed" }); try { session.sse.end(); } catch (e) { /* 無視 */ } }
    session = null;
    stopServer();
  }
  function status() {
    return {
      running: !!server, phase, ip, port, mode, busy: isBusy(),
      session: session ? { state: session.state, ip: session.ip, paused: session.paused, page: session.page, stalled: session.stalled } : null,
    };
  }

  return { start, approve, pause, extend, tapResult, pushState, disconnect, shutdown, status, isBusy, refreshCredentials: () => { if (phase === "waiting") renewAll("manual"); } };
}

module.exports = { createRemote, isTailnetAddr, OTP_TTL_MS, OTP_GRACE_MS, WAIT_IDLE_MS, APPROVAL_TIMEOUT_MS, OTP_MAX_FAILS };
