// Re-run lookup_carrier's authority logic, old and proposed, over the saved raw QCMobile JSON
// (diagnostics/<dot>/*.json) and the Motus mirror (motus_mirror.json). Pure; makes no network calls.
// Usage: node diagnostics/simulate.js
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const motusAll = JSON.parse(fs.readFileSync(path.join(dir, "motus_mirror.json"), "utf8"));
const read = (dot, f) => JSON.parse(fs.readFileSync(path.join(dir, dot, f + ".json"), "utf8")).body;

const CODE = (v) => {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "A" || s === "I" || s === "N" ? s : null;
};
const RANK = { I: 3, N: 2, A: 1 };
const carrierAuth = ({ common, contract }) =>
  common === null && contract === null ? null : common === "A" || contract === "A" ? "A" : common === "I" || contract === "I" ? "I" : "N";

function oldOutput(car, mcArg) {
  const allowed = car.allowedToOperate;
  return {
    mc: car.docketNumber || mcArg || "Not reported by FMCSA",
    authority: allowed === "Y" ? "Authorized to operate" : allowed === "N" ? "NOT authorized to operate" : "Unknown",
    oos: car.oosDate ? `OUT OF SERVICE (since ${car.oosDate})` : "Not out of service",
  };
}

function newOutput(car, docketsBody, motus) {
  const list = Array.isArray(docketsBody?.content) ? docketsBody.content : [];
  const dockets = list
    .map((d) => {
      const n = String(d.docketNumber ?? "").replace(/\D/g, "");
      return n ? `${String(d.prefix ?? "MC").toUpperCase()}${n}` : "";
    })
    .filter(Boolean);
  const all = dockets; // MC from QCMobile only; Motus is reported on its own line
  const oosDate = car.oosDate || "";
  const oosActive = String(car.allowedToOperate ?? "").toUpperCase() === "N" || oosDate !== "";
  const u = String(car.statusCode ?? "").toUpperCase();
  const usdot = oosActive
    ? `${u === "I" ? "Inactive" : "Active"}; NOT allowed to operate (federal out-of-service order)`
    : u === "A"
      ? "Active; allowed to operate (no out-of-service order)"
      : u === "I"
        ? "Inactive; not allowed to operate"
        : u || "Unknown";
  const qc = { common: CODE(car.commonAuthorityStatus), contract: CODE(car.contractAuthorityStatus), broker: CODE(car.brokerAuthorityStatus) };
  const mo = motus ? { common: CODE(motus.common), contract: CODE(motus.contract), broker: CODE(motus.broker) } : null;
  // Verdict from QCMobile only (platform rule); Motus is shown separately and never changes it.
  const worst = carrierAuth(qc);
  const mc = mo ? carrierAuth(mo) : null;
  const word = (c) => (c === "A" ? "active" : c === "I" ? "inactive" : "none");
  const disagree = worst && mc && worst !== mc ? `QCMobile ${word(worst)} vs Motus ${word(mc)}` : !worst && mc ? `QCMobile none; Motus ${word(mc)}` : "";
  const motusLine = !mo ? "not checked" : mc || mo.broker ? `common ${mo.common ?? "-"}, broker ${mo.broker ?? "-"} (${(motus.dockets || []).join(", ")})` : "no record";
  const brokerOnly = qc.broker === "A" && worst !== "A";
  let auth;
  if (worst === "I") auth = "INACTIVE: revoked or not reinstated. Not authorized for interstate for-hire carriage";
  else if (worst === "N" && brokerOnly) auth = "Broker authority only";
  else if (worst === "N") auth = "None on file (normal for private, exempt or intrastate)";
  else if (worst === "A") auth = oosActive || u === "I" ? "Active on paper, but may not operate (see USDOT)" : "ACTIVE: authorized for interstate for-hire carriage";
  else auth = "Unknown: no authority record from FMCSA";
  return { mc: all.join(", ") || "Not reported by FMCSA", usdot, authority: auth, motus: motusLine, disagree, oos: oosDate ? `OUT OF SERVICE (since ${oosDate})` : "Not out of service" };
}

const out = {};
for (const dot of fs.readdirSync(dir).filter((d) => /^\d+$/.test(d))) {
  const c = read(dot, "carrier").content;
  const car = (Array.isArray(c) ? c[0]?.carrier : c?.carrier ?? c) || {};
  out[dot] = { name: car.legalName, old: oldOutput(car), proposed: newOutput(car, read(dot, "docket_numbers"), motusAll[dot]) };
}
console.log(JSON.stringify(out, null, 1));
