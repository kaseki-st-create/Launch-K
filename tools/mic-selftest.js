// ============================================================
// Windowsの実機で、新しいマイク処理が動くかを確かめる自己診断（アプリを入れたPCで、アプリのフォルダから実行）
//
//   node tools/mic-selftest.js              … 録音デバイスの一覧と、いまのミュート状態を表示するだけ（何も変更しません）
//   node tools/mic-selftest.js --props      … 各マイクの設定情報（内蔵・USB・Bluetoothを見分ける手がかり）を、すべて表示し、mic-props-report.txt に保存する（何も変更しません）
//                                              --out 保存先 で、保存先を変えられます
//   node tools/mic-selftest.js --worker     … アプリと同じ「専用スレッド（ワーカー）経由」で、一覧が取れるかを確認する（何も変更しません）
//   node tools/mic-selftest.js --mute-test  … 接続中のマイクを1台ずつ「ミュート→確認→元に戻す」まで試す
//
// --mute-test は、各マイクの元のミュート状態を覚えておき、必ず元に戻します。実行中は、そのマイクが一瞬ミュートされます。
// 配信・通話中は実行しないでください。
// ============================================================
"use strict";
if (process.platform !== "win32") { console.error("このスクリプトはWindows専用です。"); process.exit(2); }
const koffi = require("koffi");
const { createBackend } = require("../mic-backend");
const core = require("../mic-core");
const b = createBackend(koffi, koffi.load("ole32.dll"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateName = (s) => ({ 1: "接続中", 2: "無効", 4: "なし", 8: "未接続" }[s] || String(s));

(async () => {
  const devs = b.list();
  console.log("録音デバイス：" + devs.length + " 台");
  for (const d of devs) {
    const dd = Object.assign({}, d);
    console.log(" - " + (d.name || "(名前なし)") + "\n     種類=" + core.kindLabel(dd) + "（formFactor=" + d.formFactor + "） 状態=" + stateName(d.state) + " ミュート=" + (d.muted === null ? "不明" : d.muted) + (core.isVirtual(dd) ? "  ※仮想/ミキサー扱い" : "") + "\n     接続方式=" + ({ usb: "USB", bluetooth: "Bluetooth", other: "本体・その他" }[d.bus] || "不明") + "　容器ID=" + (d.machine === true ? "本体" : d.machine === false ? "本体ではない" : "不明") + "　アプリの表示名=" + core.displayName(dd) + "\n     id=" + d.id);
  }
  if (process.argv.includes("--props")) {
    // 診断：機器が「内蔵・USB・Bluetooth」のどれなのかを、名前ではなく、Windowsが持っている情報で判定できるかを確かめるための表示
    const props = require("../mic-props");
    const dumped = b.dumpProps();
    const report = props.formatReport(dumped, { date: new Date().toLocaleString("ja-JP") });
    console.log("\n" + report);
    const oi = process.argv.indexOf("--out");
    const outPath = require("path").resolve(oi >= 0 && process.argv[oi + 1] ? process.argv[oi + 1] : "mic-props-report.txt");
    try { require("fs").writeFileSync(outPath, "\uFEFF" + report, "utf8"); console.log("レポートを保存しました：" + outPath + "\n（共有する前に、機器のシリアル番号などが含まれていないか、確認してください）"); } catch (e) { console.error("保存できませんでした：" + (e && e.message)); }
    return;
  }
  if (process.argv.includes("--worker")) {
    // アプリ本体と同じ経路：専用スレッド（mic-worker.js）に依頼して、結果を受け取る
    const { createMicManager, defaultSpawn } = require("../mic-manager");
    const m = createMicManager({ spawn: defaultSpawn(require("path").join(__dirname, "..", "mic-worker.js")) });
    const t0 = Date.now();
    const v = await m.refresh();
    console.log("\n[ワーカー経由] ok=" + v.ok + " 台数=" + v.devices.length + " 所要=" + (Date.now() - t0) + "ms" + (v.ok ? "" : " エラー=" + v.error));
    const direct = devs.filter((d) => d.state === 1).length, viaWorker = v.devices.filter((d) => d.state === 1).length;
    console.log(v.ok && direct === viaWorker ? "OK  ワーカー経由でも、同じ数の接続中マイクが取れました。" : "NG  ワーカー経由では取れていません（koffiがワーカーで動いていない可能性があります）。");
    m.shutdown();
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (!process.argv.includes("--mute-test")) { console.log("\n（変更はしていません。ミュートの動作確認は --mute-test）"); return; }
  let bad = 0;
  for (const d of devs.filter((x) => x.state === 1 && x.muted !== null)) {
    const orig = d.muted;
    const r1 = b.setMany([d.id], !orig)[0];
    await sleep(500);
    const now = b.list().find((x) => x.id === d.id);
    const r2 = b.setMany([d.id], orig)[0];   // 必ず元に戻す
    const back = b.list().find((x) => x.id === d.id);
    const okSet = r1 && r1.muted === !orig && now && now.muted === !orig;
    const okBack = r2 && r2.muted === orig && back && back.muted === orig;
    if (!okSet || !okBack) bad++;
    console.log((okSet && okBack ? "OK  " : "NG  ") + d.name + "  切り替え=" + (okSet ? "効いた" : "効かなかった（" + ((r1 && r1.error) || "値が変わらない") + "）") + "  元に戻す=" + (okBack ? "OK" : "失敗 → Windowsのサウンド設定で手動で確認してください"));
  }
  console.log(bad ? "\n" + bad + " 台で問題がありました。このマイクは、アプリのミュートが効かない可能性があります。" : "\nすべてのマイクで、ミュートの切り替えと元に戻す操作ができました。");
})().catch((e) => { console.error("失敗：", e && e.message || e); process.exit(1); });
