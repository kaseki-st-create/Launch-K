// ============================================================
// mic-manager.js — マイク操作の「本体側の管理役」（メインプロセス）
//
// やること
//  ・COMの処理は、専用のワーカースレッド（mic-worker.js）に任せる。ここは依頼を送って、結果を待つだけ。
//  ・固まったら、2秒（操作は2.5秒）で諦めて、そのワーカーを捨てる。連続で固まったら、しばらく（30秒）は呼ばない。
//    → 本体（Launch-0のサーバーなど）は、マイクの不調に巻き込まれない。
//  ・2秒ごとに録音デバイスの一覧と状態を読み、最新を持っておく（画面・スマホは、これを見るだけ）。
//  ・依頼は1つずつ順番に処理する（状態の読み取りと書き込みが、途中で混ざらないように）。
//  ・「接続した時に自動でミュート」：登録したマイクが「つながっていない → つながった」に変わった瞬間にだけ、ミュートする。
//
// 安全設計
//  ・読めなかった・古い（7秒以上更新されていない）ときは、「ミュート中」とは言わない（stale / ok=false）。
//  ・書き込みのあとは必ず読み直して、実際の状態で成功・失敗を判断する。
// ============================================================
"use strict";
const core = require("./mic-core");

const POLL_MS = 2000;
const LIST_TIMEOUT_MS = 2000;
const SET_TIMEOUT_MS = 2500;
const READY_TIMEOUT_MS = 10 * 1000; // ワーカーの起動（koffiの読み込み・COMの初期化）を待つ上限。初回が遅い環境（ウイルス対策のスキャンなど）で、起動待ちを「固まった」と誤判定しない
const STALE_MS = 7000;
const FAIL_LIMIT = 3;       // 連続でこの回数、固まったら
const BLOCK_MS = 30 * 1000; // この間は、ワーカーを呼ばない

// 本物のワーカースレッドを起動する関数を作る（テストでは、代わりに偽物を渡す）
function defaultSpawn(workerPath) {
  return function spawn() {
    const { Worker } = require("worker_threads");
    const w = new Worker(workerPath);
    return {
      send: (m) => w.postMessage(m),
      onMessage: (cb) => w.on("message", cb),
      onError: (cb) => { w.on("error", cb); w.on("exit", () => cb(new Error("exit"))); },
      terminate: () => { try { Promise.resolve(w.terminate()).catch(() => {}); } catch (e) { /* 無視 */ } },
    };
  };
}

function normalizeDevices(list) {
  const out = [];
  for (const d of Array.isArray(list) ? list : []) {
    if (!d || !core.isSafeDeviceId(d.id)) continue;
    const dev = {
      id: d.id,
      name: core.cleanName(d.name) || "（名前なし）",
      formFactor: Number.isFinite(d.formFactor) ? d.formFactor : 10,
      state: Number.isFinite(d.state) ? d.state : 0,
      muted: d.muted === true ? true : d.muted === false ? false : null,
      // 接続方式（usb / bluetooth / other）と、容器IDが本体のものか。Windowsの情報で分かったときだけ入る（分からなければ null）
      bus: d.bus === "usb" || d.bus === "bluetooth" || d.bus === "other" ? d.bus : null,
      machine: d.machine === true ? true : d.machine === false ? false : null,
    };
    dev.kind = core.kindLabel(dev);
    dev.micLike = core.isMicLike(dev);
    dev.virtual = core.isVirtual(dev);
    dev.label = core.displayName(dev);
    out.push(dev);
  }
  // 画面に出す名前が重なるとき（内蔵マイクが2つ、同じ機種のマイクを2台、など）は、「（2）」「（3）」を付けて見分ける（デバイスIDの順で固定）
  const groups = new Map();
  for (const d of out) { if (!groups.has(d.label)) groups.set(d.label, []); groups.get(d.label).push(d); }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    list.forEach((d, i) => { if (i > 0) d.label = d.label + "（" + (i + 1) + "）"; });
  }
  return out;
}

function createMicManager(opts) {
  const spawn = opts.spawn;
  const now = opts.now || (() => Date.now());
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
  const pollMs = opts.pollMs || POLL_MS;
  const listTimeout = opts.listTimeoutMs || LIST_TIMEOUT_MS;
  const setTimeoutMs = opts.setTimeoutMs || SET_TIMEOUT_MS;
  const blockMs = opts.blockMs || BLOCK_MS;
  const readyTimeout = opts.readyTimeoutMs || READY_TIMEOUT_MS;

  let worker = null;
  let resolveReady = null; // 現在のワーカーの「起動完了」待ちを終わらせる関数
  let readyP = null;       // 現在のワーカーの「起動完了」待ち（true=使える／false=使えない）
  let initFailed = false;  // ワーカーの初期化に失敗した（直後の依頼に、固まった扱いではなく「使えない」と返すため）
  let stuck = false;       // 固まって捨てたワーカーが、まだ残っている可能性（終了を妨げないよう、終了時に確認する）
  let unavailable = false; // この環境ではCOMが使えない（Windows以外・koffiが読めない）
  let seq = 0;
  const pending = new Map();
  let fails = 0;
  let blockedUntil = 0;
  let snap = { ok: false, at: 0, devices: [], error: "starting" };
  let lastSig = "";
  let timer = null;
  let autoIds = new Set();
  let prevActive = null;
  let queue = Promise.resolve();
  let refreshQueued = false;

  function failAll(error) {
    const cbs = Array.from(pending.values());
    pending.clear();
    for (const cb of cbs) { try { cb({ ok: false, error }); } catch (e) { /* 無視 */ } }
  }
  function killWorker() {
    const w = worker;
    worker = null;
    if (resolveReady) { try { resolveReady(false); } catch (e) { /* 無視 */ } }
    resolveReady = null; readyP = null;
    if (w) { try { w.terminate(); } catch (e) { /* 無視 */ } }
  }
  function noteFailure() {
    fails += 1;
    if (fails >= FAIL_LIMIT) { blockedUntil = now() + blockMs; fails = 0; }
  }
  function ensureWorker() {
    if (worker) return worker;
    const w = spawn();
    worker = w;
    readyP = new Promise((res) => { resolveReady = res; });
    w.onMessage((m) => {
      if (worker !== w || !m) return;
      if (m.type === "ready") {
        if (!m.ok) {
          // Windows以外は、ずっと使えない。それ以外（koffiの読み込みの一時的な失敗など）は、しばらく休んでから、やり直す
          if (/unsupported/.test(String(m.error || ""))) unavailable = true;
          else { blockedUntil = now() + blockMs; initFailed = true; }
          failAll("unavailable"); killWorker();
        }
        else if (resolveReady) { resolveReady(true); }
        return;
      }
      const cb = pending.get(m.id);
      if (cb) cb(m);
    });
    if (w.onError) w.onError(() => { if (worker === w) { failAll("worker-error"); killWorker(); } });
    return w;
  }
  // 起動完了を待つ（上限 READY_TIMEOUT_MS）。使えるなら true
  function waitReady(p) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), readyTimeout);
      p.then((v) => { clearTimeout(t); resolve(!!v); }, () => { clearTimeout(t); resolve(false); });
    });
  }
  // ワーカーに1件依頼して、結果（または失敗）を必ず返す。例外は投げない。
  async function call(op, args, timeoutMs) {
    if (unavailable) return { ok: false, error: "unavailable" };
    if (now() < blockedUntil) return { ok: false, error: "busy" };
    let w;
    try { w = ensureWorker(); } catch (e) { return { ok: false, error: "worker-start" }; }
    // 起動の時間は、依頼の時間切れ（2秒）には数えない（起動が遅いだけで「固まった」と判断しない）
    const up = await waitReady(readyP);
    if (unavailable) return { ok: false, error: "unavailable" };
    if (initFailed) { initFailed = false; return { ok: false, error: "unavailable" }; }
    if (!up || worker !== w) {
      if (worker === w) { stuck = true; noteFailure(); killWorker(); }
      return { ok: false, error: "timeout" };
    }
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        stuck = true;
        noteFailure();
        failAll("timeout");
        killWorker(); // 固まったワーカーは捨てる（次の依頼で新しく作る）
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        pending.delete(id);
        if (m && m.ok) fails = 0;
        resolve(m && typeof m === "object" ? m : { ok: false, error: "bad-reply" });
      });
      try { w.send(Object.assign({ id, op }, args || {})); } catch (e) {
        clearTimeout(timer); pending.delete(id); resolve({ ok: false, error: "send" });
      }
    });
  }
  // 依頼を1つずつ順番に処理する。内部で想定外の例外が起きても、呼び出し側には例外を投げず、「失敗」の結果として返す
  function enqueue(fn, fallback) {
    const run = async () => {
      try { return await fn(); } catch (e) { return typeof fallback === "function" ? fallback() : { ok: false, error: "internal" }; }
    };
    const p = queue.then(run, run);
    queue = p.then(() => {}, () => {});
    return p;
  }

  function signature(s) {
    return (s.ok ? "1" : "0") + "|" + s.devices.map((d) => d.id + ":" + d.state + ":" + d.muted).join(",");
  }
  function setSnapshot(next) {
    snap = next;
    const sig = signature(next);
    if (sig !== lastSig) { lastSig = sig; try { onChange(view()); } catch (e) { /* 通知の失敗で止めない */ } }
  }
  // 画面・スマホに見せる形。ok=false または古いときは stale=true（このとき「ミュート中」とは表示しない）
  function view() {
    return { ok: snap.ok, stale: !snap.ok || now() - snap.at > STALE_MS, error: snap.error || "", at: snap.at, devices: snap.devices.map((d) => Object.assign({}, d)) };
  }

  async function listFresh() {
    const r = await call("list", {}, listTimeout);
    if (!r.ok || !Array.isArray(r.devices)) {
      setSnapshot({ ok: false, at: snap.at, devices: snap.devices, error: r.error || "list-failed" });
      return { ok: false, error: r.error || "list-failed" };
    }
    const devices = normalizeDevices(r.devices);
    setSnapshot({ ok: true, at: now(), devices, error: "" });
    return { ok: true, devices };
  }

  async function refreshInner() {
    const l = await listFresh();
    if (!l.ok) return view();
    // 「接続した時に自動でミュート」：つながっていない → つながった、に変わったものだけ（起動直後・再読み込み直後は基準にするだけで、触らない）
    const active = new Set(l.devices.filter(core.isActive).map((d) => d.id));
    if (prevActive) {
      const fresh = Array.from(active).filter((id) => !prevActive.has(id) && autoIds.has(id));
      if (fresh.length) {
        await call("set", { ids: fresh, mute: true }, setTimeoutMs);
        await listFresh();
      }
    }
    prevActive = active;
    return view();
  }

  // ids を mute(true)／解除(false) にして、読み直した実際の状態で成功・失敗を判断する
  async function applyMute(ids, mute) {
    const w = await call("set", { ids, mute }, setTimeoutMs);
    const l = await listFresh();
    if (!l.ok) return { ok: false, error: l.error, failed: ids.slice(), mute };
    const byId = new Map(l.devices.map((d) => [d.id, d]));
    const failed = ids.filter((id) => { const d = byId.get(id); return !d || d.muted !== mute; });
    if (!w.ok && !failed.length) return { ok: true, failed: [], mute, devices: l.devices };
    return { ok: failed.length === 0, error: failed.length ? (w.error || "not-applied") : "", failed, mute, devices: l.devices };
  }

  const api = {
    configure(cfg) {
      const needed = !!(cfg && cfg.needed);
      autoIds = new Set((cfg && Array.isArray(cfg.autoMuteIds) ? cfg.autoMuteIds : []).filter((x) => core.isSafeDeviceId(x)));
      if (needed && !timer) {
        timer = setInterval(() => { api.refresh(); }, pollMs);
        if (timer.unref) timer.unref();
        api.refresh();
      } else if (!needed && timer) {
        api.shutdown();
      }
    },
    // 最新の状態を読み直す（待っている間に重複して積まない）
    refresh() {
      if (refreshQueued) return Promise.resolve(view());
      refreshQueued = true;
      return enqueue(refreshInner, view).finally(() => { refreshQueued = false; });
    },
    snapshot: view,
    // 固まって捨てたワーカーが残っている可能性があるか（アプリ終了時に、終了を妨げないための確認に使う）
    hasStuck() { return stuck; },
    // 「全マイクまとめて」：1台でもミュートと確認できていなければミュート、全部ミュート済みなら全部解除
    toggleAll(excludeIds) {
      return enqueue(async () => {
        const l = await listFresh();
        if (!l.ok) return { ok: false, error: l.error };
        const targets = core.allMicTargets(l.devices, Array.isArray(excludeIds) ? excludeIds.filter((x) => core.isSafeDeviceId(x)) : []);
        const plan = core.planToggle(targets);
        if (!plan) return { ok: false, error: "no-device" };
        return applyMute(targets.map((d) => d.id), plan === "mute");
      });
    },
    // 「1台だけ」：接続中のそのデバイスだけを切り替える
    toggleDevice(deviceId) {
      return enqueue(async () => {
        if (!core.isSafeDeviceId(deviceId)) return { ok: false, error: "bad-id" };
        const l = await listFresh();
        if (!l.ok) return { ok: false, error: l.error };
        const d = l.devices.find((x) => x.id === deviceId);
        if (!d || !core.isActive(d)) return { ok: false, error: "not-connected" };
        return applyMute([d.id], d.muted !== true);
      });
    },
    // 非常口：接続中の録音デバイスのうち、ミュートされているもの（または不明のもの）を、すべて解除する
    unmuteEverything() {
      return enqueue(async () => {
        const l = await listFresh();
        if (!l.ok) return { ok: false, error: l.error };
        const ids = l.devices.filter((d) => core.isActive(d) && d.muted !== false).map((d) => d.id);
        if (!ids.length) return { ok: true, failed: [], mute: false, devices: l.devices };
        return applyMute(ids, false);
      });
    },
    shutdown() {
      if (timer) { clearInterval(timer); timer = null; }
      prevActive = null;
      failAll("shutdown");
      killWorker();
    },
  };
  return api;
}

module.exports = { createMicManager, defaultSpawn, normalizeDevices, POLL_MS, STALE_MS };
