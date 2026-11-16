// ============================================================
// mic-backend.js — 録音デバイス（マイク）を「すべて」列挙し、デバイスごとにミュートを操作する（Windows専用）
//
// koffi で Core Audio（COM）を直接呼ぶ。native-audio.js（既定のスピーカー／マイク1台だけを操作）と同じ作法で、
// 違いは「接続中のすべての録音デバイスを列挙する」「デバイスのIDで1台ずつ操作する」の2点。
//
// このファイルは、専用のワーカースレッド（mic-worker.js）の中でだけ使う。
// COMの呼び出しがデバイスの抜き差しなどで固まっても、アプリ本体（Launch-0のサーバー含む）を巻き込まないため。
//
// 安全設計
//  ・触るのは「録音（eCapture）の一覧にあるデバイス」だけ。一覧に無いIDは操作しない（再生側を誤って触らない）。
//  ・値を書き換えるのは SetMute だけ。書いた直後にもう一度 GetMute で読み、実際の状態を返す。
//  ・COMオブジェクトは使い終わったら必ず Release（finally）。文字列は CoTaskMemFree / PropVariantClear で解放。
//  ・想定外のことは例外にする（呼び出し側は「不明」として扱い、「ミュート中」とは決して表示しない）。
// ============================================================
"use strict";

const CLSCTX_ALL = 23;
const COINIT_MULTITHREADED = 0; // このスレッド専用に初期化する
const E_CAPTURE = 1;
const DEVICE_STATE_ACTIVE = 1;
const DEVICE_STATE_MASK = 1 | 2 | 8; // 接続中・無効・未接続（NOTPRESENT＝過去に接続した記録だけのものは、数が多くなるので含めない）
const STGM_READ = 0;
const MAX_DEVICES = 64;

// vtable上の位置（IUnknownの3つの後ろから数える）
const VT_RELEASE = 2;
const VT_ENUM_ENUMERATE = 3;   // IMMDeviceEnumerator::EnumAudioEndpoints
const VT_COLL_COUNT = 3;       // IMMDeviceCollection::GetCount
const VT_COLL_ITEM = 4;        // IMMDeviceCollection::Item
const VT_DEV_ACTIVATE = 3;     // IMMDevice::Activate
const VT_DEV_OPEN_PROPS = 4;   // IMMDevice::OpenPropertyStore
const VT_DEV_GET_ID = 5;       // IMMDevice::GetId
const VT_DEV_GET_STATE = 6;    // IMMDevice::GetState
const VT_PROP_GET_COUNT = 3;   // IPropertyStore::GetCount（診断と、接続方式の判定で使う）
const VT_PROP_GET_AT = 4;      // IPropertyStore::GetAt（診断と、接続方式の判定で使う）
const VT_PROP_GET_VALUE = 5;   // IPropertyStore::GetValue
const VT_VOL_SET_MUTE = 14;    // IAudioEndpointVolume::SetMute
const VT_VOL_GET_MUTE = 15;    // IAudioEndpointVolume::GetMute

const VT_UI4 = 19;
const VT_LPWSTR = 31;

function parseGuid(text) {
  const m = /^([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})-([0-9A-Fa-f]{12})$/.exec(text);
  if (!m) throw new Error("bad guid " + text);
  const tail = m[4] + m[5] + m[6];
  const d4 = [];
  for (let i = 0; i < 8; i++) d4.push(parseInt(tail.substr(i * 2, 2), 16));
  return { Data1: parseInt(m[1], 16) >>> 0, Data2: parseInt(m[2], 16), Data3: parseInt(m[3], 16), Data4: d4 };
}
function hrText(hr) { return "0x" + (hr >>> 0).toString(16).toUpperCase().padStart(8, "0"); }
function checkHr(hr, what) {
  if (typeof hr !== "number" || hr < 0) throw new Error(what + " failed (" + (typeof hr === "number" ? hrText(hr) : "?") + ")");
}

// koffi と ole32 を受け取って、操作の関数を作る
function createBackend(koffi, lib) {
  const GUID = koffi.struct("MicGUID", { Data1: "uint32", Data2: "uint16", Data3: "uint16", Data4: koffi.array("uint8", 8) });
  const PROPKEY = koffi.struct("MicPropKey", { fmtid: GUID, pid: "uint32" });
  // PROPVARIANT（64bitで24バイト）：vt と、値の入る共用体（文字列ポインタ／32bit整数）
  const PROPVARIANT = koffi.struct("MicPropVariant", { vt: "uint16", r1: "uint16", r2: "uint16", r3: "uint16", val: "void *", val2: "void *" });

  const CLSID_MMDeviceEnumerator = parseGuid("BCDE0395-E52F-467C-8E3D-C4579291692E");
  const IID_IMMDeviceEnumerator = parseGuid("A95664D2-9614-4F35-A746-DE8DB63617E6");
  const IID_IAudioEndpointVolume = parseGuid("5CDF2C82-841E-4546-9722-0CF74078229A");
  const KEY_FRIENDLY_NAME = { fmtid: parseGuid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), pid: 14 };   // PKEY_Device_FriendlyName
  const KEY_FORM_FACTOR = { fmtid: parseGuid("1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E"), pid: 0 };      // PKEY_AudioEndpoint_FormFactor

  const CoInitializeEx = lib.func("int32 __stdcall CoInitializeEx(void *reserved, uint32 coInit)");
  const CoCreateInstance = lib.func("int32 __stdcall CoCreateInstance(MicGUID *rclsid, void *outer, uint32 clsCtx, MicGUID *riid, _Out_ void **ppv)");
  const CoTaskMemAlloc = lib.func("void *__stdcall CoTaskMemAlloc(size_t size)");
  const CoTaskMemFree = lib.func("void __stdcall CoTaskMemFree(void *p)");
  const PropVariantClear = lib.func("int32 __stdcall PropVariantClear(void *pv)");

  const P_Enumerate = koffi.proto("int32 __stdcall MicEnumerate(void *self, int32 flow, uint32 mask, _Out_ void **coll)");
  const P_CollCount = koffi.proto("int32 __stdcall MicCollCount(void *self, _Out_ uint32 *n)");
  const P_CollItem = koffi.proto("int32 __stdcall MicCollItem(void *self, uint32 i, _Out_ void **dev)");
  const P_DevGetId = koffi.proto("int32 __stdcall MicDevGetId(void *self, _Out_ void **id)");
  const P_DevGetState = koffi.proto("int32 __stdcall MicDevGetState(void *self, _Out_ uint32 *state)");
  const P_DevOpenProps = koffi.proto("int32 __stdcall MicDevOpenProps(void *self, uint32 access, _Out_ void **store)");
  const P_PropGetValue = koffi.proto("int32 __stdcall MicPropGetValue(void *self, MicPropKey *key, void *pv)");
  const P_Activate = koffi.proto("int32 __stdcall MicActivate(void *self, MicGUID *iid, uint32 clsCtx, void *params, _Out_ void **out)");
  const P_GetMute = koffi.proto("int32 __stdcall MicGetMute(void *self, _Out_ int32 *mute)");
  const P_SetMute = koffi.proto("int32 __stdcall MicSetMute(void *self, int32 mute, void *eventContext)");
  const P_Release = koffi.proto("uint32 __stdcall MicRelease(void *self)");

  const PTR = koffi.sizeof("void *");
  let diagProtos = null; // プロパティを1件ずつ列挙する呼び出しの定義。最初に使うときに作る（診断と、接続方式の判定で使う）

  function method(obj, index) {
    const table = koffi.decode(obj, "void *");
    if (!table) throw new Error("null vtable");
    const fnPtr = koffi.decode(table, index * PTR, "void *");
    if (!fnPtr) throw new Error("null method " + index);
    return fnPtr;
  }
  function release(obj) {
    if (!obj) return;
    try { koffi.call(method(obj, VT_RELEASE), P_Release, obj); } catch (e) { /* 解放の失敗は無視（本来の結果を隠さない） */ }
  }
  let comReady = false;
  function ensureCom() {
    if (comReady) return;
    // このワーカースレッドで初期化する。すでに初期化済み（S_FALSE）でも、モードが違って失敗（RPC_E_CHANGED_MODE）しても、続行してよい。
    // 本当に初期化できていなければ、次の CoCreateInstance が失敗して例外になる。
    try { CoInitializeEx(null, COINIT_MULTITHREADED); } catch (e) { /* 無視 */ }
    comReady = true;
  }

  function withEnumerator(fn) {
    ensureCom();
    const eo = [null];
    checkHr(CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, eo), "CoCreateInstance");
    const enumerator = eo[0];
    if (!enumerator) throw new Error("no enumerator");
    try { return fn(enumerator); } finally { release(enumerator); }
  }

  // 録音デバイスを1台ずつ処理する（fn(device, id)）。一覧にあるものだけを渡す。
  function forEachCapture(fn) {
    return withEnumerator((enumerator) => {
      const co = [null];
      checkHr(koffi.call(method(enumerator, VT_ENUM_ENUMERATE), P_Enumerate, enumerator, E_CAPTURE, DEVICE_STATE_MASK, co), "EnumAudioEndpoints");
      const coll = co[0];
      if (!coll) throw new Error("no collection");
      try {
        const n = [0];
        checkHr(koffi.call(method(coll, VT_COLL_COUNT), P_CollCount, coll, n), "GetCount");
        const count = Math.min(n[0] >>> 0, MAX_DEVICES);
        for (let i = 0; i < count; i++) {
          const dout = [null];
          checkHr(koffi.call(method(coll, VT_COLL_ITEM), P_CollItem, coll, i, dout), "Item");
          const device = dout[0];
          if (!device) continue;
          try { fn(device); } finally { release(device); }
        }
      } finally { release(coll); }
    });
  }

  function deviceId(device) {
    const po = [null];
    checkHr(koffi.call(method(device, VT_DEV_GET_ID), P_DevGetId, device, po), "GetId");
    const p = po[0];
    if (!p) throw new Error("no id");
    try { return String(koffi.decode(p, "char16_t", -1) || ""); } finally { try { CoTaskMemFree(p); } catch (e) { /* 無視 */ } }
  }
  function deviceState(device) {
    const so = [0];
    checkHr(koffi.call(method(device, VT_DEV_GET_STATE), P_DevGetState, device, so), "GetState");
    return so[0] >>> 0;
  }
  // プロパティ1つを読む。読めなければ null（名前や種類が取れなくても、一覧から外さない）
  function readProp(store, key) {
    const pv = CoTaskMemAlloc(24);
    if (!pv) return null;
    try {
      koffi.encode(pv, PROPVARIANT, { vt: 0, r1: 0, r2: 0, r3: 0, val: null, val2: null });
      const hr = koffi.call(method(store, VT_PROP_GET_VALUE), P_PropGetValue, store, key, pv);
      if (typeof hr !== "number" || hr < 0) return null;
      const v = koffi.decode(pv, PROPVARIANT);
      let out = null;
      if (v.vt === VT_LPWSTR && v.val) out = String(koffi.decode(v.val, "char16_t", -1) || "");
      else if (v.vt === VT_UI4) out = v.val ? Number(BigInt.asUintN(32, koffi.address(v.val))) : 0;
      try { PropVariantClear(pv); } catch (e) { /* 無視 */ }
      return out;
    } catch (e) {
      return null;
    } finally {
      try { CoTaskMemFree(pv); } catch (e) { /* 無視 */ }
    }
  }
  // プロパティ1つを、型も含めて、文字で読む（診断と、接続方式の判定で使う）（読めなければ、例外にせず、理由を文字で返す）
  function readAny(store, keyObj) {
    const pv = CoTaskMemAlloc(24);
    if (!pv) return { vt: -1, type: "?", text: "（メモリを確保できません）" };
    try {
      koffi.encode(pv, PROPVARIANT, { vt: 0, r1: 0, r2: 0, r3: 0, val: null, val2: null });
      const hr = koffi.call(method(store, VT_PROP_GET_VALUE), P_PropGetValue, store, keyObj, pv);
      if (typeof hr !== "number" || hr < 0) return { vt: -1, type: "?", text: "（取得に失敗：" + (typeof hr === "number" ? hrText(hr) : "?") + "）" };
      const r = require("./mic-props").readVariant(koffi, PROPVARIANT, GUID, pv);
      try { PropVariantClear(pv); } catch (e) { /* 無視 */ }
      return r;
    } catch (e) {
      return { vt: -1, type: "?", text: "（読めません：" + String((e && e.message) || e).slice(0, 80) + "）" };
    } finally {
      try { CoTaskMemFree(pv); } catch (e) { /* 無視 */ }
    }
  }
  // 開いたプロパティストアから、プロパティをすべて読む（診断レポートと、接続方式の判定で、同じ処理を使う）。
  // 1件読めなくても、その1件を飛ばして続ける。メモリは必ず解放する。
  function scanStoreProps(store) {
    if (!diagProtos) {
      diagProtos = {
        getCount: koffi.proto("int32 __stdcall MicPropGetCount(void *self, _Out_ uint32 *n)"),
        getAt: koffi.proto("int32 __stdcall MicPropGetAt(void *self, uint32 i, void *key)"),
      };
    }
    const mp = require("./mic-props");
    const P_PropGetCount = diagProtos.getCount, P_PropGetAt = diagProtos.getAt;
    const props = [];
    const seen = new Set();
    const no = [0];
    const hrc = koffi.call(method(store, VT_PROP_GET_COUNT), P_PropGetCount, store, no);
    const count = typeof hrc === "number" && hrc >= 0 ? Math.min(no[0] >>> 0, 300) : 0;
    for (let i = 0; i < count; i++) {
      const km = CoTaskMemAlloc(20); // PROPERTYKEY（GUID16バイト＋番号4バイト）
      if (!km) break;
      try {
        koffi.encode(km, "uint8_t", new Array(20).fill(0), 20);
        const hr2 = koffi.call(method(store, VT_PROP_GET_AT), P_PropGetAt, store, i, km);
        if (typeof hr2 !== "number" || hr2 < 0) continue;
        const k = koffi.decode(km, PROPKEY);
        const keyObj = { fmtid: { Data1: k.fmtid.Data1, Data2: k.fmtid.Data2, Data3: k.fmtid.Data3, Data4: Array.from(k.fmtid.Data4) }, pid: k.pid };
        const key = mp.keyText(mp.guidToString(keyObj.fmtid), keyObj.pid);
        seen.add(key);
        props.push(Object.assign({ key }, readAny(store, keyObj)));
      } catch (e) { /* この1件は飛ばす */ } finally { try { CoTaskMemFree(km); } catch (e) { /* 無視 */ } }
    }
    // 列挙に出てこなくても、名前を指定すれば読めるものを、追加で読む
    for (const x of mp.EXTRA_KEYS) {
      const key = mp.keyText(x.fmtid, x.pid);
      if (seen.has(key)) continue;
      const r = readAny(store, { fmtid: mp.parseGuid(x.fmtid), pid: x.pid });
      if (r.vt !== 0 && r.vt !== -1) props.push(Object.assign({ key, extra: true }, r));
    }
    return props;
  }
  // 接続方式（USB・Bluetooth・その他）と、容器IDが本体のものかを調べる。1台につき1回だけ読んで、覚えておく（毎回の一覧では読まない）。
  // 状態が変わった（接続された・無効になった、など）ときは、読み直す。読めなかったときは、最大3回まで再挑戦し、それでも読めなければ null（＝分からない）。
  // null のときは、名前だけで判断する今までの動きに戻る（失敗しても、一覧や、ミュート操作には、影響しない）。
  const busCache = new Map(); // id → { state, tries, info }
  function busInfoFor(id, state, store) {
    const c = busCache.get(id);
    const sameState = !!c && c.state === state;
    if (sameState && c.info) return c.info;
    const tries = sameState ? c.tries : 0;
    if (sameState && tries >= 3) return null;
    let info = null;
    try {
      const props = scanStoreProps(store);
      if (props.length > 0) info = require("./mic-props").classifyBus(props);
    } catch (e) { info = null; }
    busCache.set(id, { state, tries: tries + 1, info });
    return info;
  }
  function withVolume(device, fn) {
    const vo = [null];
    checkHr(koffi.call(method(device, VT_DEV_ACTIVATE), P_Activate, device, IID_IAudioEndpointVolume, CLSCTX_ALL, null, vo), "Activate");
    const vol = vo[0];
    if (!vol) throw new Error("no endpoint volume");
    try { return fn(vol); } finally { release(vol); }
  }
  function getMute(vol) {
    const out = [0];
    checkHr(koffi.call(method(vol, VT_VOL_GET_MUTE), P_GetMute, vol, out), "GetMute");
    return out[0] !== 0;
  }
  function setMute(vol, on) {
    checkHr(koffi.call(method(vol, VT_VOL_SET_MUTE), P_SetMute, vol, on ? 1 : 0, null), "SetMute");
  }

  return {
    // 録音デバイスの一覧：[{ id, name, formFactor, state, muted, bus, machine }]。muted は接続中のものだけ（読めなければ null）。
    // bus＝接続方式（usb / bluetooth / other。分からなければ null）、machine＝容器IDが本体のものか（true / false。分からなければ null）
    list() {
      const devices = [];
      forEachCapture((device) => {
        let id = "";
        try { id = deviceId(device); } catch (e) { return; }
        if (!id) return;
        let state = 0;
        try { state = deviceState(device); } catch (e) { return; }
        let name = "", formFactor = 10;
        let bus = null, machine = null; // 接続方式（usb / bluetooth / other）と、容器IDが本体のものか。分からなければ null
        const po = [null];
        let hr = -1;
        try { hr = koffi.call(method(device, VT_DEV_OPEN_PROPS), P_DevOpenProps, device, STGM_READ, po); } catch (e) { hr = -1; }
        if (typeof hr === "number" && hr >= 0 && po[0]) {
          try {
            const n = readProp(po[0], KEY_FRIENDLY_NAME);
            if (typeof n === "string") name = n;
            const ff = readProp(po[0], KEY_FORM_FACTOR);
            if (typeof ff === "number") formFactor = ff;
            try { const bi = busInfoFor(id, state, po[0]); if (bi) { bus = bi.bus; machine = bi.machine; } } catch (e) { /* 分からないまま */ }
          } finally { release(po[0]); }
        }
        let muted = null;
        if (state === DEVICE_STATE_ACTIVE) {
          try { muted = withVolume(device, getMute); } catch (e) { muted = null; }
        }
        devices.push({ id, name, formFactor, state, muted, bus, machine });
      });
      return devices;
    },
    // 【診断用】録音デバイスごとに、設定情報（プロパティ）をすべて読む。
    // 機器が「内蔵・USB・Bluetooth」のどれなのかを、名前ではなく、Windowsが持っている情報で判定できるかを、実機の値で確かめるため。
    // 戻り値：[{ id, state, props:[{ key:"GUID,番号", vt, type, text, extra? }] }]
    dumpProps() {
      const out = [];
      forEachCapture((device) => {
        let id = "";
        try { id = deviceId(device); } catch (e) { return; }
        let state = 0;
        try { state = deviceState(device); } catch (e) { /* 無視 */ }
        const entry = { id, state, props: [] };
        const po = [null];
        let hr = -1;
        try { hr = koffi.call(method(device, VT_DEV_OPEN_PROPS), P_DevOpenProps, device, STGM_READ, po); } catch (e) { hr = -1; }
        if (typeof hr === "number" && hr >= 0 && po[0]) {
          try { entry.props = scanStoreProps(po[0]); } finally { release(po[0]); }
        }
        out.push(entry);
      });
      return out;
    },
    // 指定したIDの録音デバイスを、ミュート(true)／解除(false)にする。一覧にあるIDだけが対象。
    // 戻り値：[{ id, muted, error? }]（muted は書き込み後にもう一度読んだ実際の状態。分からなければ null）
    setMany(ids, mute) {
      const want = new Set(Array.isArray(ids) ? ids.map(String) : []);
      const results = new Map();
      if (!want.size) return [];
      forEachCapture((device) => {
        let id = "";
        try { id = deviceId(device); } catch (e) { return; }
        if (!want.has(id)) return;
        try {
          if (deviceState(device) !== DEVICE_STATE_ACTIVE) { results.set(id, { id, muted: null, error: "not-active" }); return; }
          const actual = withVolume(device, (vol) => { setMute(vol, !!mute); return getMute(vol); });
          results.set(id, { id, muted: actual });
        } catch (e) {
          results.set(id, { id, muted: null, error: String((e && e.message) || e).slice(0, 120) });
        }
      });
      // 一覧に無かったID（抜かれた直後など）も、結果として返す
      for (const id of want) if (!results.has(id)) results.set(id, { id, muted: null, error: "not-found" });
      return Array.from(results.values());
    },
  };
}

// ワーカーに届いた依頼を実行する（テストで、COMの代わりの偽物を差し込めるよう、ここに分けてある）
function handleRequest(backend, m) {
  const core = require("./mic-core");
  switch (m && m.op) {
    case "list": return { devices: backend.list() };
    case "set": {
      const ids = (Array.isArray(m.ids) ? m.ids : []).filter((x) => core.isSafeDeviceId(x)).slice(0, 64);
      return { results: backend.setMany(ids, m.mute === true) };
    }
    default: throw new Error("bad op");
  }
}

module.exports = { createBackend, handleRequest };
