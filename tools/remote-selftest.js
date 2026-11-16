// remote.js（Launch-0の通信）の自己テスト：node tools/remote-selftest.js
// Tailscaleは模擬、時計は進めて、時間の方針（お知らせ・注意・Launch-pass・切断）を確かめる。ネットワークの外には出ない。
const http = require("http");
const path = require("path");
const R = require("../remote.js");

const realNow = Date.now.bind(Date);
let off = 0;
Date.now = () => realNow() + off;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function advance(ms) { off += ms; await sleep(1250); }
// スマホが生きていて、画面を開いたまま（応答はあるが操作はしない）状態で時間を進める
async function advanceAlive(c, ms) {
  const step = 60 * 1000;
  let left = ms;
  while (left > 0) { const d = Math.min(step, left); off += d; left -= d; await call(c.port, "POST", "/api/ping", { hidden: false }, c.sid); }
  await sleep(1250);
}

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  NG  " + name); } }

const ts = {
  status: async () => ({ ok: true, selfIp: "127.0.0.1", selfName: "pc", login: "a@b", display: "a", tailnet: "t" }),
  statusCached: async () => ({ ok: true }),
  peerFor: async () => ({ ok: true, key: "k1", name: "phone", os: "iOS", login: "a@b", display: "a", path: { kind: "direct", detail: "" } }),
  routeFor: async () => ({ ok: true, key: "k1", path: { kind: "direct", detail: "" } }),
};

function call(port, method, p, body, sid, tab) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) };
    if (sid) headers["x-sid"] = sid;
    if (tab) headers["x-tab"] = tab;
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* html */ } resolve({ status: res.statusCode, json: j, text: t }); });
    });
    req.on("error", reject); req.end(data);
  });
}

async function newConnection(rec, events) {
  const remote = R.createRemote({
    mobileHtmlPath: path.join(__dirname, "..", "mobile.html"), appVersion: "test", tailscale: ts, forceIp: "127.0.0.1",
    remoteFilter: () => true, emit: (e) => events.push(e), getPass: () => rec,
  });
  const st = await remote.start({ snapshot: { pages: [] }, allowedIds: ["t1"], multiIds: [], images: {} });
  const port = st.port;
  const k = new URL(st.url).searchParams.get("k");
  const a = await call(port, "POST", "/api/auth", { k, otp: st.otp });
  remote.approve(true);
  return { remote, port, sid: a.json.sid };
}
// イベントの受信（SSE）を開始して、応答の状態だけ見て切る
function openEvents(port, sid, tab) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: `/api/events?sid=${encodeURIComponent(sid)}&tab=${encodeURIComponent(tab)}` }, (res) => {
      const status = res.statusCode; res.destroy(); resolve(status);
    });
    req.on("error", () => resolve(0)); req.end();
  });
}
const last = (events, type) => events.filter((e) => e.type === type).pop();
const has = (events, type) => events.some((e) => e.type === type);

(async () => {
  console.log("[Launch-pass の保存と照合]");
  const rec = R.makePassRecord("4826");
  ok(!JSON.stringify(rec).includes("4826"), "平文では保存しない");
  ok(R.checkPass(rec, "4826") && !R.checkPass(rec, "4827") && !R.checkPass(rec, "12") && !R.checkPass(null, "4826"), "正しい4桁だけ通る");
  let threw = false; try { R.makePassRecord("12a4"); } catch (e) { threw = true; }
  ok(threw, "4桁の数字以外は作れない");

  console.log("[Launch-pass 未設定では開始できない]");
  {
    const r = R.createRemote({ mobileHtmlPath: "x", appVersion: "t", tailscale: ts, forceIp: "127.0.0.1", remoteFilter: () => true, getPass: () => null });
    let msg = ""; try { await r.start({}); } catch (e) { msg = e.message; }
    ok(msg === "no-pass", "未設定なら no-pass で断る");
  }

  console.log("[無操作：15分で注意 → 30分でロック → 60分で切断]");
  {
    R.resetPassState(); const ev = [];
    const c = await newConnection(rec, ev);
    let seqN = 0;
    const tap = () => call(c.port, "POST", "/api/tap", { tile: "t1", seq: ++seqN }, c.sid);
    await advanceAlive(c, 16 * 60 * 1000);
    ok(last(ev, "idle-caution") && last(ev, "idle-caution").phase === "pass", "15分超：注意（Launch-passが必要になる前）が出る");
    await advanceAlive(c, 15 * 60 * 1000); // 合計31分
    ok(has(ev, "locked") && last(ev, "locked").why === "idle", "30分超：ロックされる");
    ok(last(ev, "idle-caution").phase === "cut", "30分超：注意が「自動切断まで」に変わる");
    let r = await tap(); ok(r.status === 409 && r.json.error === "locked", "ロック中はボタンを受け付けない");
    r = await call(c.port, "POST", "/api/extend", {}, c.sid); ok(r.status === 403, "ロック中は、スマホからの「続ける」も受け付けない");
    r = await call(c.port, "POST", "/api/unlock", { pass: "0000" }, c.sid); ok(r.status === 403 && r.json.left === 2, "間違い1回目：残り2回");
    r = await call(c.port, "POST", "/api/unlock", { pass: "4826" }, c.sid); ok(r.status === 200 && r.json.ok, "正しいLaunch-passで解除");
    ok(has(ev, "unlocked"), "解除がPCにも伝わる");
    r = await tap(); ok(r.status === 200 && r.json.ok, "解除後はボタンが使える");
    await advanceAlive(c, 61 * 60 * 1000);
    ok(has(ev, "ended") && last(ev, "ended").reason === "idle", "操作がないまま60分で自動切断");
    c.remote.shutdown("closed");
  }

  console.log("[Launch-pass 3回連続の間違い → 切断・5分間は受け付けない・回数は引き継ぐ]");
  {
    R.resetPassState(); const ev = [];
    let c = await newConnection(rec, ev);
    await advanceAlive(c, 31 * 60 * 1000);
    await call(c.port, "POST", "/api/unlock", { pass: "1111" }, c.sid);
    let r = await call(c.port, "POST", "/api/unlock", { pass: "2222" }, c.sid);
    ok(r.json.left === 1, "2回目：残り1回");
    r = await call(c.port, "POST", "/api/unlock", { pass: "3333" }, c.sid);
    ok(r.status === 403 && r.json.ended === true, "3回目：切断");
    await sleep(100);
    ok(has(ev, "ended") && last(ev, "ended").reason === "pass-fails", "理由は pass-fails");
    c.remote.shutdown("closed");
    // 入り直しても、5分間は受け付けない
    const ev2 = []; c = await newConnection(rec, ev2);
    r = await call(c.port, "POST", "/api/unlock", { pass: "4826" }, c.sid);
    ok(r.status === 429 && r.json.error === "cooldown", "切断後すぐは、正しいLaunch-passでも受け付けない（5分間）");
    await advanceAlive(c, 5 * 60 * 1000);
    r = await call(c.port, "POST", "/api/unlock", { pass: "4826" }, c.sid);
    ok(r.status === 200, "5分たてば受け付ける");
    c.remote.shutdown("closed");
  }

  console.log("[スマホが裏に回っている：3分お知らせ → 5分注意 → 15分でロック → 30分で切断]");
  {
    R.resetPassState(); const ev = [];
    const c = await newConnection(rec, ev);
    await call(c.port, "POST", "/api/ping", { hidden: true }, c.sid);
    await advance(3.5 * 60 * 1000);
    ok(has(ev, "hidden"), "3分：お知らせ");
    ok(!has(ev, "caution"), "3分の時点では、まだ注意は出ない");
    await advance(2 * 60 * 1000);
    ok(has(ev, "caution") && last(ev, "caution").kind === "hidden", "5分：注意（カウントダウン付き）");
    ok(Math.abs((last(ev, "caution").dropAt - Date.now()) - 25 * 60 * 1000) < 40 * 1000, "切断までの残りは、約25分");
    await advance(11 * 60 * 1000);
    ok(has(ev, "locked"), "15分超：ロック（戻ったときにLaunch-pass）");
    const p = await call(c.port, "POST", "/api/ping", { hidden: false }, c.sid);
    ok(p.json.locked === true, "戻ったスマホには、ロック中と伝わる");
    c.remote.shutdown("closed");
    // 画面が裏に回ったまま30分（戻らない）
    const ev3 = []; const c3 = await newConnection(rec, ev3);
    await call(c3.port, "POST", "/api/ping", { hidden: true }, c3.sid);
    await advance(31 * 60 * 1000);
    ok(has(ev3, "ended") && ["phone-hidden", "timeout"].includes(last(ev3, "ended").reason), "戻らないまま30分で自動切断");
    c3.remote.shutdown("closed");
  }

  console.log("[通信が途切れている：3分お知らせ → 5分注意 → 30分で切断]");
  {
    R.resetPassState(); const ev = [];
    const c = await newConnection(rec, ev);
    await advance(3.5 * 60 * 1000); ok(has(ev, "stalled"), "3分：お知らせ（stalled）");
    await advance(2 * 60 * 1000); ok(has(ev, "caution") && last(ev, "caution").kind === "stalled", "5分：注意");
    const t = await call(c.port, "POST", "/api/tap", { tile: "t1", seq: 5 }, c.sid);
    ok(t.status === 409, "途切れ中は操作を受け付けない");
    await advance(26 * 60 * 1000);
    ok(has(ev, "ended") && last(ev, "ended").reason === "timeout", "30分で自動切断");
    c.remote.shutdown("closed");
  }

  console.log("[PCのスリープ・ロック]");
  {
    R.resetPassState(); let ev = [];
    let c = await newConnection(rec, ev);
    ok(c.remote.pcAway("sleep") === true, "スリープに入っても切断しない");
    const t = await call(c.port, "POST", "/api/tap", { tile: "t1", seq: 7 }, c.sid);
    ok(t.status === 409 && t.json.error === "pcaway", "スリープ中は操作を受け付けない");
    off += 5 * 60 * 1000;
    c.remote.pcBack();
    ok(last(ev, "pcback") && last(ev, "pcback").locked === false, "5分で復帰：自動で復帰（Launch-pass不要）");
    const t2 = await call(c.port, "POST", "/api/tap", { tile: "t1", seq: 8 }, c.sid);
    ok(t2.status === 200, "復帰後は操作できる");
    c.remote.pcAway("sleep"); off += 20 * 60 * 1000; c.remote.pcBack();
    ok(last(ev, "pcback").locked === true, "20分で復帰：Launch-passが必要");
    const t3 = await call(c.port, "POST", "/api/tap", { tile: "t1", seq: 9 }, c.sid);
    ok(t3.status === 409 && t3.json.error === "locked", "ロック中は操作できない");
    c.remote.pcAway("lock"); off += 31 * 60 * 1000; c.remote.pcBack();
    ok(has(ev, "ended") && last(ev, "ended").reason === "pc-lock", "30分を超えたら切断");
    c.remote.shutdown("closed");
  }
  console.log("[スマホの複数タブ：いちばん新しいタブだけ有効]");
  {
    R.resetPassState(); const ev = [];
    const c = await newConnection(rec, ev);
    const T1 = `${realNow() + off}-aaaa1111`, T2 = `${realNow() + off + 5000}-bbbb2222`, T0 = `${realNow() + off - 5000}-cccc0000`;
    ok((await openEvents(c.port, c.sid, T1)) === 200, "最初のタブは受信を始められる");
    let r = await call(c.port, "POST", "/api/ping", { hidden: false }, c.sid, T1);
    ok(r.status === 200 && r.json.ok, "最初のタブの通信は通る");
    ok((await openEvents(c.port, c.sid, T2)) === 200, "新しく開いたタブが、受信を引き継げる");
    r = await call(c.port, "POST", "/api/ping", { hidden: false }, c.sid, T1);
    ok(r.status === 409 && r.json.error === "othertab", "古いタブの通信は断られる（接続は切れない）");
    r = await call(c.port, "POST", "/api/ping", { hidden: false }, c.sid, T2);
    ok(r.status === 200 && r.json.ok, "新しいタブの通信は通る");
    ok((await openEvents(c.port, c.sid, T1)) === 409, "古いタブは、受信をやり直しても、引き継げない（行き来しない）");
    ok((await openEvents(c.port, c.sid, T0)) === 409, "さらに古いタブも、引き継げない");
    for (const [path, body] of [["/api/tap", { tile: "t1", seq: 1 }], ["/api/page", { page: 0 }], ["/api/extend", {}], ["/api/unlock", { pass: "4826" }], ["/api/bye", {}]]) {
      r = await call(c.port, "POST", path, body, c.sid, T1);
      ok(r.status === 409 && r.json.error === "othertab", `古いタブからの ${path} は断られる`);
    }
    ok(!has(ev, "ended"), "古いタブの操作で、接続は切れない");
    // 古いタブ（裏に回った状態）の通信が、新しいタブの状態を上書きしない
    await call(c.port, "POST", "/api/ping", { hidden: true }, c.sid, T1);
    const step = 60 * 1000;
    for (let i = 0; i < 20; i++) { off += step; await call(c.port, "POST", "/api/ping", { hidden: false }, c.sid, T2); }
    await sleep(1250);
    ok(!has(ev, "hidden") && !has(ev, "caution") && !has(ev, "locked") && !has(ev, "ended"), "古いタブが「裏に回った」と言っても、新しいタブが使われている間は、途切れ・ロックにならない");
    // 引き継ぎのやり直し（「このタブで使う」）：さらに新しいタブになる
    const T3 = `${realNow() + off + 9000}-dddd3333`;
    ok((await openEvents(c.port, c.sid, T3)) === 200, "「このタブで使う」で、また引き継げる");
    r = await call(c.port, "POST", "/api/ping", { hidden: false }, c.sid, T2);
    ok(r.status === 409, "引き継がれたあとの、前のタブは断られる");
    r = await call(c.port, "POST", "/api/ping", { hidden: false }, c.sid, "bad tab!");
    ok(r.status === 409, "形式の合わないタブ識別子は、有効なタブにならない");
    c.remote.shutdown("closed");
  }
  console.log(`\n${pass} 件成功 / ${fail} 件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
