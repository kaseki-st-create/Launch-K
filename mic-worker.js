// ============================================================
// mic-worker.js — マイクのCOM処理を行う専用スレッド（mic-manager.js が起動する）
// ここで固まっても、アプリ本体は止まらない（本体は2秒で諦めて、このスレッドを捨てる）。
// ============================================================
"use strict";
const { parentPort } = require("worker_threads");

let backend = null;
let initError = "";
let handleRequest = null;
try {
  if (process.platform !== "win32") throw new Error("unsupported platform");
  const koffi = require("koffi");
  const mod = require("./mic-backend");
  handleRequest = mod.handleRequest;
  backend = mod.createBackend(koffi, koffi.load("ole32.dll"));
} catch (e) {
  backend = null;
  initError = String((e && e.message) || e).slice(0, 200);
}

parentPort.postMessage({ type: "ready", ok: !!backend, error: initError });
parentPort.on("message", (m) => {
  const id = m && m.id;
  if (!backend) { parentPort.postMessage({ id, ok: false, error: "unavailable" }); return; }
  try {
    parentPort.postMessage(Object.assign({ id, ok: true }, handleRequest(backend, m)));
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
});
