// ============================================================
// mic-props.js — 録音デバイスの「設定情報（プロパティ）」を読み取って、文字にする部品と、接続方式（USB・Bluetooth）の判定
//
// ・診断（tools/mic-selftest.js の --props）：どのプロパティに、どんな値が入っているかを、すべて表示する。
// ・アプリ本体：classifyBus で、機器が「USB」「Bluetooth」かを判定し、名前が「マイク配列」でも外付けを「内蔵マイク」と誤って表示しないために使う
//   （mic-core.js の isInternal。判定できないときは、名前だけで判断する）。
//
// ここにあるのは、koffi と メモリの読み取りだけ（COMは呼ばない）。だから、Windows以外でも、メモリ上のデータで動作を確認できる。
// PROPVARIANT（Windowsの「型つきの値」）の配置（64bit）：先頭2バイトが型(vt)、オフセット8から値（文字列は、ポインタ）
// ============================================================
"use strict";

// 本体を表す「容器ID」（Windowsは、PC本体に内蔵された機器に、すべて1の GUID を付ける）
const MACHINE_CONTAINER_ID = "00000000-0000-0000-ffff-ffffffffffff";

// 名前が分かっているプロパティ（診断の表示を読みやすくするための注釈）
const KNOWN_KEYS = {
  "a45c254e-df1c-4efd-8020-67d146a850e0,14": "機器の名前（FriendlyName）",
  "a45c254e-df1c-4efd-8020-67d146a850e0,2": "機器の説明（DeviceDesc）",
  "a45c254e-df1c-4efd-8020-67d146a850e0,24": "列挙子（EnumeratorName）",
  "026e516e-b814-414b-83cd-856d6fef4822,2": "接続先の名前（InterfaceFriendlyName）",
  "1da5d803-d492-4edd-8c23-e0c0ffee7f0e,0": "機器の種類（FormFactor）",
  "8c7ed206-3f8a-4827-b3ab-ae9e1faefc6c,2": "容器ID（ContainerId）",
  "78c34fc8-104a-4aca-9ea4-524d52996e57,256": "機器のインスタンスID（InstanceId）",
  "b3f8fa53-0004-438e-9003-51a46e139bfc,2": "（未確認）オーディオ機器の経路",
  "b3f8fa53-0004-438e-9003-51a46e139bfc,6": "（未確認）オーディオ機器の名前",
};
// GetAt で列挙されない場合に備え、名前を指定して、追加で読みに行くキー
const EXTRA_KEYS = [
  { fmtid: "8c7ed206-3f8a-4827-b3ab-ae9e1faefc6c", pid: 2 },
  { fmtid: "78c34fc8-104a-4aca-9ea4-524d52996e57", pid: 256 },
  { fmtid: "a45c254e-df1c-4efd-8020-67d146a850e0", pid: 24 },
  { fmtid: "b3f8fa53-0004-438e-9003-51a46e139bfc", pid: 2 },
  { fmtid: "b3f8fa53-0004-438e-9003-51a46e139bfc", pid: 6 },
  { fmtid: "026e516e-b814-414b-83cd-856d6fef4822", pid: 2 },
];

function hex(n, width) { return (Number(n) >>> 0).toString(16).padStart(width, "0"); }
function guidToString(g) {
  if (!g) return "";
  const d = Array.from(g.Data4 || []);
  return hex(g.Data1, 8) + "-" + hex(g.Data2, 4) + "-" + hex(g.Data3, 4) + "-" + hex(d[0] || 0, 2) + hex(d[1] || 0, 2) + "-" + d.slice(2, 8).map((b) => hex(b || 0, 2)).join("");
}
function parseGuid(text) {
  const m = /^([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})-([0-9A-Fa-f]{12})$/.exec(text);
  if (!m) throw new Error("bad guid " + text);
  const tail = m[4] + m[5] + m[6];
  const d4 = [];
  for (let i = 0; i < 8; i++) d4.push(parseInt(tail.substr(i * 2, 2), 16));
  return { Data1: parseInt(m[1], 16) >>> 0, Data2: parseInt(m[2], 16), Data3: parseInt(m[3], 16), Data4: d4 };
}
function keyText(fmtidText, pid) { return String(fmtidText).toLowerCase() + "," + pid; }

const VT_NAMES = { 0: "EMPTY", 1: "NULL", 2: "I2", 3: "I4", 4: "R4", 5: "R8", 8: "BSTR", 11: "BOOL", 16: "I1", 17: "UI1", 18: "UI2", 19: "UI4", 20: "I8", 21: "UI8", 30: "LPSTR", 31: "LPWSTR", 64: "FILETIME", 65: "BLOB", 72: "CLSID" };
function vtName(vt) { const base = vt & 0x0fff; return ((vt & 0x1000) ? "VECTOR|" : "") + (VT_NAMES[base] || ("vt" + base)); }

// PROPVARIANT（メモリ上の pv）を読んで、{ vt, type, text } にする。読めなかった部分は、例外にせず、文字で知らせる。
// koffi：koffi本体／PROPVARIANT：呼び出し側で定義した構造体の型（{vt,r1,r2,r3,val,val2}）／GUID：{Data1..Data4}の構造体の型
function readVariant(koffi, PROPVARIANT, GUID, pv) {
  let vt = 0;
  try { vt = koffi.decode(pv, PROPVARIANT).vt; } catch (e) { return { vt: -1, type: "?", text: "（読めません：" + e.message + "）" }; }
  const base = vt & 0x0fff;
  const vector = (vt & 0x1000) !== 0;
  const str16 = (p) => { try { return p ? String(koffi.decode(p, "char16_t", -1)) : "(null)"; } catch (e) { return "（文字列を読めません）"; } };
  try {
    if (vector) {
      // 文字列の配列（要素数：オフセット8、配列へのポインタ：オフセット16）
      const count = koffi.decode(pv, 8, "uint32");
      const arr = koffi.decode(pv, 16, "void *");
      if (base !== 31 && base !== 8) return { vt, type: vtName(vt), text: "（配列：" + count + "個。この型は未対応）" };
      const items = [];
      for (let i = 0; i < Math.min(count, 32); i++) items.push(str16(koffi.decode(arr, i * koffi.sizeof("void *"), "void *")));
      return { vt, type: vtName(vt), text: "[" + items.join(" | ") + "]" };
    }
    switch (base) {
      case 0: case 1: return { vt, type: vtName(vt), text: "（空）" };
      case 2: return { vt, type: vtName(vt), text: String(koffi.decode(pv, 8, "int16")) };
      case 18: return { vt, type: vtName(vt), text: String(koffi.decode(pv, 8, "uint16")) };
      case 3: return { vt, type: vtName(vt), text: String(koffi.decode(pv, 8, "int32")) };
      case 19: return { vt, type: vtName(vt), text: String(koffi.decode(pv, 8, "uint32")) };
      case 16: return { vt, type: vtName(vt), text: String(koffi.decode(pv, 8, "int8")) };
      case 17: return { vt, type: vtName(vt), text: String(koffi.decode(pv, 8, "uint8")) };
      case 20: return { vt, type: vtName(vt), text: String(koffi.decode(pv, 8, "int64")) };
      case 21: return { vt, type: vtName(vt), text: String(koffi.decode(pv, 8, "uint64")) };
      case 11: return { vt, type: vtName(vt), text: koffi.decode(pv, 8, "int16") !== 0 ? "true" : "false" };
      case 31: case 8: return { vt, type: vtName(vt), text: str16(koffi.decode(pv, 8, "void *")) };
      case 30: { const p = koffi.decode(pv, 8, "void *"); return { vt, type: vtName(vt), text: p ? String(koffi.decode(p, "char", -1)) : "(null)" }; }
      case 72: { const p = koffi.decode(pv, 8, "void *"); return { vt, type: vtName(vt), text: p ? guidToString(koffi.decode(p, GUID)) : "(null)" }; }
      case 65: {
        // バイト列（大きさ：オフセット8、データへのポインタ：オフセット16）。大きさと、先頭の16バイトだけ表示する
        const cb = koffi.decode(pv, 8, "uint32");
        const p = koffi.decode(pv, 16, "void *");
        let head = "";
        if (p && cb > 0) { const bytes = koffi.decode(p, "uint8_t", Math.min(cb, 16)); head = " 先頭：" + Array.from(bytes).map((b) => hex(b, 2)).join(" "); }
        return { vt, type: vtName(vt), text: "（" + cb + "バイト）" + head };
      }
      default: return { vt, type: vtName(vt), text: "（この型は未対応）" };
    }
  } catch (e) {
    return { vt, type: vtName(vt), text: "（読めません：" + e.message + "）" };
  }
}

// ---- どのバスにつながっているか（診断の「推定」と、アプリの接続方式の判定で、同じ処理を使う。実機5台で結果を確認済み） ----
const BUS_RE = /(?:^|[^A-Za-z0-9])(HDAUDIO|INTELAUDIO|USB|BTHENUM|BTHHFENUM|BTH|SWD|ACPI|PCI|ROOT|MMDEVAPI)(?=[^A-Za-z0-9]|$)/gi;
// props：[{ key, vt, type, text }]。戻り値：{ containerId, isMachine, buses:[{ token, key }], guess }
function analyzeBus(props) {
  const out = { containerId: "", isMachine: false, buses: [], guess: "不明" };
  const seen = new Set();
  for (const p of Array.isArray(props) ? props : []) {
    if (!p || typeof p.text !== "string") continue;
    if (p.key === "8c7ed206-3f8a-4827-b3ab-ae9e1faefc6c,2") { out.containerId = p.text.toLowerCase(); out.isMachine = out.containerId === MACHINE_CONTAINER_ID; }
    if (p.key === "a45c254e-df1c-4efd-8020-67d146a850e0,24" || p.type === "BSTR" || p.type === "LPWSTR" || p.type === "VECTOR|LPWSTR") {
      let m; BUS_RE.lastIndex = 0;
      while ((m = BUS_RE.exec(p.text)) !== null) {
        const token = m[1].toUpperCase();
        if (token === "MMDEVAPI" || token === "SWD") continue; // どの機器でも付く、仮想の層。判定の材料にならない
        const id = token + "@" + p.key;
        if (!seen.has(id)) { seen.add(id); out.buses.push({ token, key: p.key }); }
      }
    }
  }
  const tokens = new Set(out.buses.map((b) => b.token));
  if (tokens.has("USB")) out.guess = "USB（外付け）";
  else if ([...tokens].some((t) => t.startsWith("BTH"))) out.guess = "Bluetooth（外付け）";
  else if (tokens.has("HDAUDIO") || tokens.has("INTELAUDIO") || tokens.has("ACPI") || tokens.has("PCI")) out.guess = out.isMachine ? "本体のオーディオ（内蔵）" : "本体のオーディオ（容器IDは本体ではない）";
  else if (out.isMachine) out.guess = "本体（容器ID）";
  return out;
}

// 診断のレポート（人が読む文章）。devices：dumpProps() の戻り値
function formatReport(devices, meta) {
  const lines = [];
  const stateName = (st) => ({ 1: "接続中", 2: "Windowsで無効", 4: "なし", 8: "未接続" }[st] || String(st));
  lines.push("# Launch-K マイク診断レポート（接続方式の判定に使う情報）");
  lines.push("作成：" + ((meta && meta.date) || "") + "　台数：" + devices.length);
  lines.push("※ 機器のシリアル番号などが含まれることがあります。共有する前に、内容を確認してください。");
  lines.push("");
  devices.forEach((d, i) => {
    const props = Array.isArray(d.props) ? d.props.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) : [];
    const name = (props.find((p) => p.key === "a45c254e-df1c-4efd-8020-67d146a850e0,14") || {}).text || "(名前なし)";
    const a = analyzeBus(props);
    lines.push("=== " + (i + 1) + "/" + devices.length + "：" + name + " ===");
    lines.push("状態：" + stateName(d.state));
    lines.push("ID：" + d.id);
    lines.push("【推定】" + a.guess);
    lines.push("  容器ID：" + (a.containerId || "(取得できず)") + (a.isMachine ? "　← 本体（内蔵）を表す値" : ""));
    lines.push("  バスの手がかり：" + (a.buses.length ? a.buses.map((b) => b.token + "（" + b.key + "）").join("、") : "なし"));
    lines.push("--- プロパティ（" + props.length + "件）---");
    for (const p of props) {
      const note = KNOWN_KEYS[p.key] ? "  ← " + KNOWN_KEYS[p.key] : "";
      lines.push("  " + p.key + "  [" + p.type + "]" + (p.extra ? "[追加で取得]" : "") + "  " + p.text + note);
    }
    lines.push("");
  });
  return lines.join("\n");
}

// アプリ用の判定：{ bus: "usb" | "bluetooth" | "other", machine: true | false | null }
//   bus＝USB・Bluetoothの手がかりがあるか（どちらも無ければ other）。machine＝容器IDが本体の値か（容器IDを読めなければ null）。
function classifyBus(props) {
  const a = analyzeBus(props);
  const tokens = new Set(a.buses.map((b) => b.token));
  const bus = tokens.has("USB") ? "usb" : [...tokens].some((t) => t.startsWith("BTH")) ? "bluetooth" : "other";
  return { bus, machine: a.containerId ? a.isMachine : null };
}

module.exports = { classifyBus, formatReport, MACHINE_CONTAINER_ID, KNOWN_KEYS, EXTRA_KEYS, guidToString, parseGuid, keyText, vtName, readVariant, analyzeBus };
