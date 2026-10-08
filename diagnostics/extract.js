// Summarise the raw QCMobile JSON saved under diagnostics/<dot>/ (carrier, authority,
// docket_numbers, oos). Usage: node diagnostics/extract.js [dot ...]
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const dots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((d) => /^\d+$/.test(d));

const read = (dot, f) => JSON.parse(fs.readFileSync(path.join(dir, dot, f + ".json"), "utf8"));
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

const rows = [];
for (const dot of dots) {
  const c = read(dot, "carrier");
  const content = c.body && c.body.content;
  const car = (Array.isArray(content) ? content[0] && content[0].carrier : content && (content.carrier || content)) || {};
  const auth = arr(read(dot, "authority").body && read(dot, "authority").body.content).map((a) => a.carrierAuthority || a);
  const dk = arr(read(dot, "docket_numbers").body && read(dot, "docket_numbers").body.content);
  const oos = arr(read(dot, "oos").body && read(dot, "oos").body.content);
  rows.push({
    dot,
    name: car.legalName,
    statusCode: car.statusCode,
    allowedToOperate: car.allowedToOperate,
    oosDate: car.oosDate ?? null,
    carrier_commonAuthorityStatus: car.commonAuthorityStatus ?? null,
    carrier_contractAuthorityStatus: car.contractAuthorityStatus ?? null,
    carrier_brokerAuthorityStatus: car.brokerAuthorityStatus ?? null,
    carrier_docketNumber: car.docketNumber ?? null,
    bipdInsuranceOnFile: car.bipdInsuranceOnFile ?? null,
    bipdInsuranceRequired: car.bipdInsuranceRequired ?? null,
    authority_rows: auth.map((a) => ({
      docket: `${a.prefix ?? ""}${a.docketNumber ?? ""}`,
      common: a.commonAuthorityStatus,
      contract: a.contractAuthorityStatus,
      broker: a.brokerAuthorityStatus,
      authorizedForProperty: a.authorizedForProperty,
      authorizedForBroker: a.authorizedForBroker,
    })),
    dockets: dk.map((d) => `${d.prefix ?? ""}${d.docketNumber ?? ""}`),
    oos_rows: oos.map((o) => ({ oosDate: o.oosDate, oosReason: o.oosReason ?? o.oosReasonDescription, status: o.oosStatus ?? o.status })),
    fetched_at: c.fetched_at,
  });
}
console.log(JSON.stringify(rows, null, 1));
