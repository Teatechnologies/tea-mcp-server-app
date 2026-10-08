# Why lookup_carrier calls revoked carriers "authorized"

Diagnosed 2026-10-08. The fix is now in PR fix/lookup-carrier-authority (this folder ships with it). Rob ran proposed_mcp_motus_authority.sql the same day.

## Answer in brief

DOT 3043555 (Diamond Group Logistics) shows "Authorized to operate" for one reason. `lookup_carrier` answers a different question from the one its label asks.

- **What the tool reads.** It takes QCMobile's `allowedToOperate`. That field is "Y" when the USDOT number is active and there is no out-of-service order, and nothing more.
- **What the label claims.** It prints that value under "Authority Status".
- **What it never reads.** The for-hire (MC) operating authority. That status sits in the same QCMobile record as `commonAuthorityStatus`, `contractAuthorityStatus` and `brokerAuthorityStatus`.

For 3043555 those fields say `common = I` (inactive), which matches SAFER's "NOT AUTHORIZED".

As Rob pointed out, a carrier keeps an active USDOT number after its authority is revoked, and it may still run as a private, exempt or intrastate carrier. So "allowed to operate" isn't false about the USDOT number. It is the wrong answer under the label "Authority Status", and the MC authority is missing entirely.

**QCMobile isn't stale.** Its authority fields matched SAFER for every legacy carrier tested.

**The MC number gap has a separate cause.** `lookup_carrier` reads `carrier.docketNumber`, a field the base record does not have, so it prints "Not reported by FMCSA" for every carrier. The tool never calls `/docket-numbers`, which returns MC45980 for this carrier. There is no padding problem.

**About 106,000 carriers on the hub are affected today.** They have an active USDOT number, no active OOS order and inactive MC authority, and `lookup_carrier` labels each one "Authorized to operate". Another 19,900 broker-only firms get the same label.

## 1. Field map: lookup_carrier today (tea-mcp-server-app, src/index.ts, origin/main 2e59830)

| Output line | Source call | JSON path | Problem |
|---|---|---|---|
| Carrier | QCMobile `GET /carriers/{dot}` | `content.carrier.legalName`, else `dbaName` | none |
| DOT Number | same | `content.carrier.dotNumber`, else the input | none |
| MC Number | same | `content.carrier.docketNumber`, else the `mc_number` argument, else "Not reported by FMCSA" | **The field doesn't exist on the base record.** Dockets live at `/carriers/{dot}/docket-numbers`, which this tool never calls. |
| Authority Status | same | `content.carrier.allowedToOperate`: "Y" prints "Authorized to operate", "N" prints "NOT authorized to operate" | **Wrong field for the label.** `allowedToOperate` reflects USDOT status and OOS orders only. |
| Out-of-Service Status | same | `content.carrier.oosDate`, else `outOfServiceDate` | correct |
| TEA Risk Score, Risk Tier | edge function `carrier_score` | `tea_score`, `risk_tier` | none (`carrier_score` reads the `carriers` census view) |
| *(fallback)* | gateway RPC `mcp_lookup_carrier_cached` | the census row plus `carrier_scores_v2`, with `authority_status: null` | Used only when QCMobile is non-200 or times out after 8 s. It states that authority needs the live API, but dumps the census row, whose `status_code` "A" can be misread as authority. |

**Platform rule check.** The rule is that authority and OOS come from QCMobile, never from Supabase.

- **lookup_carrier follows it.** Authority and OOS come only from live QCMobile. The Supabase fallback deliberately returns `authority_status: null`.
- **No caching.** There is no KV, Cache API or memoised QCMobile response anywhere in the Worker. The only KV cache (`CORP_REGISTRY_CACHE`) is used solely by `corporate_registry_search`.
- **Same code path elsewhere.** `generate_investigation_report` calls `fetchQcMobileIdentity()`, which has the same `allowedToOperate` logic. That helper does call `/docket-numbers`, so its MC number is correct.

## 2. Hypotheses

| # | Hypothesis | Result | Evidence |
|---|---|---|---|
| 1 | Wrong QCMobile field | **Confirmed. This is the failure.** | `diagnostics/3043555/carrier.json`: `allowedToOperate: "Y"`, `statusCode: "A"`, `commonAuthorityStatus: "I"`, `contractAuthorityStatus: "N"`, `brokerAuthorityStatus: "N"`, `bipdInsuranceOnFile: "0"` (required "Y"). The handler reads only `allowedToOperate` and never calls `/authority`. |
| 2 | Docket parsing | **Partly. The endpoint is never called; nothing fails to parse.** | `docket_numbers.json` returns `{prefix: "MC", docketNumber: 45980}`. `lookup_carrier` reads `carrier.docketNumber`, which the base record lacks. A missing docket does not short-circuit the authority check; the two are independent. Short dockets (Pineda MC134362) and 7-digit dockets parse fine wherever `/docket-numbers` is read. |
| 3 | Motus migration divergence | **Not the cause of this case, but real for post-migration carriers.** | 3043555 has no Motus record, and QCMobile, SAFER and the hub's L&I tables all agree it is revoked. For DOT 7320887 (Orange Creek, MC49822294 granted in Motus 2026-09-24), QCMobile and SAFER show no authority and no MC. More generally, Motus conflicts heavily with the legacy data (it showed Werner as revoked in June). |
| 4 | Caching | **Ruled out.** | No cache in the QCMobile path. Each call is fetched live with an 8 s timeout. |

**Raw evidence for 3043555** is in `diagnostics/3043555/`: `carrier.json`, `authority.json` (empty content), `docket_numbers.json` and `oos.json` (empty content). It was fetched 2026-10-08 09:43 UTC through a temporary read-only function that was deleted right after. The files contain no keys.

What else the evidence shows for 3043555:

- **SAFER (as of 10/06/2026):** USDOT ACTIVE, Operating Authority NOT AUTHORIZED, MC-45980, no OOS. This matches QCMobile field for field.
- **Hub `authority_history` (dot `03043555`):** MC045980 GRANTED 10/03/2017, then REVOKED 03/23/2026. Earlier involuntary-revocation notices in 2019 and 2023 were discontinued.
- **Hub `revocations`:** INVOLUNTARY REVOCATION, order effective 03/23/2026.
- **Hub `fmcsa_authority_current`:** common I, contract N, broker N, BIPD on file 00000 (fetched 2026-06-13).
- **Hub census (`fmcsa_census_current`):** `status_code` "A" and `docket1_status_code` "A". **Both read "A" for every carrier tested, revoked ones included, so neither can be used for authority.**
- **Motus mirror (`motus.operating_authority` / `authority_event`):** no rows for this DOT.

## 3. Control set: source by source

Key: A = active, I = inactive, N = never granted, "-" = no data. ✗ marks today's tool output when it contradicts SAFER.

| DOT | Carrier | Group | QCMobile `allowedToOperate` / `statusCode` | QCMobile common / contract / broker | QCMobile `/docket-numbers` | SAFER 10/06/2026 | Hub `authority_history` latest | Hub L&I current | Motus mirror | **Tool today** | Proposed output |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 3043555 | Diamond Group Logistics | failing case | Y / A | **I** / N / N | MC45980 | ACTIVE, **NOT AUTHORIZED**, MC-45980 | REVOKED 03/23/2026 | I/N/N | - | ✗ "Authorized to operate", MC "Not reported" | USDOT active, allowed; **MC authority INACTIVE**; MC45980 |
| 80806 | J.B. Hunt | clean | Y / A | A / A / A | MC135797, FF51075 | ACTIVE, AUTHORIZED | FF dismissed 2021 | A/A/A | broker A only (incomplete) | "Authorized", MC ✗ "Not reported" | MC authority ACTIVE; MC135797, FF51075 |
| 53467 | Werner | clean | Y / A | A / A / A | MC138328 | ACTIVE, AUTHORIZED | discont. rev. 2016 | A/A/A | A now (showed Inactive 06/09–06/16) | "Authorized", MC ✗ "Not reported" | MC authority ACTIVE; MC138328 |
| 1947018 | Quality Freight | clean | Y / A | A / N / N | MC692744 | ACTIVE, AUTHORIZED | discont. rev. 2015 | A/N/N | - | "Authorized", MC ✗ "Not reported" | MC authority ACTIVE; MC692744 |
| 4167210 | PBX Trucking | revoked 2026 (ins. cancel 02/20) | Y / A | **I** / N / N | MC1602190 | ACTIVE, **NOT AUTHORIZED** | REVOKED 03/02/2026 | I/N/N | I | ✗ "Authorized to operate" | MC authority INACTIVE; MC1602190 |
| 3911275 | Blue Razor Logistics | revoked 2026 (ins. cancel 02/20) | Y / A | **I** / N / N | MC1443893 | ACTIVE, **NOT AUTHORIZED** | REVOKED 03/02/2026 | I/N/N | - | ✗ "Authorized to operate" | MC authority INACTIVE; MC1443893 |
| 3118945 | Pineda Transport | revoked 2026 (ins. cancel 02/20) | Y / A | N / **I** / N | MC134362 | ACTIVE, **NOT AUTHORIZED** | REVOKED 03/02/2026 | N/I/N | - | ✗ "Authorized to operate" | MC authority INACTIVE (contract); MC134362 |
| 4572941 | Green Valley Trucking | active OOS (10/05/2026) | **N** / A | A / N / N | MC1819232 | **OUT-OF-SERVICE** 10/05/2026 | GRANTED 05/15/2026 | A/N/N | - | "NOT authorized" + OOS ✓, MC ✗ "Not reported" | USDOT: NOT allowed (OOS since 2026-10-05); MC authority "active on paper, but may not operate" |
| 4572169 | MN Trucking | active OOS (10/05/2026) | **N** / A | A / N / N | MC1818815 | **OUT-OF-SERVICE** 10/05/2026 | GRANTED 05/15/2026 | A/N/N | - | same as above | same as above |
| 7320887 | Orange Creek | granted in last 60 days (Motus) | Y / A | - / - / - | (none) | ACTIVE, NOT AUTHORIZED, no MC | - | - | **A**, MC49822294 (granted 09/24/2026) | "Authorized to operate" (by accident), MC "Not reported" | MC authority **Unknown** (QCMobile has no record); Motus line: active MC49822294, with a note that the sources differ |

Sources for every row:

- **QCMobile:** raw JSON in `diagnostics/<dot>/`.
- **SAFER:** `diagnostics/safer_snapshots.txt`.
- **Motus:** `diagnostics/motus_mirror.json`.
- **Old and proposed outputs:** generated from that raw data by `diagnostics/simulate.js`, written to `diagnostics/simulation_output.json`.

**What the control set shows**

- **Every carrier revoked for insurance in 2026 fails the same way.** Each has `allowedToOperate` Y and authority I, and the tool prints "Authorized to operate".
- **OOS carriers are handled correctly today,** because QCMobile flips `allowedToOperate` to N.
- **The MC number is wrong ("Not reported") for all 10,** clean carriers included.
- **Motus disagrees with the legacy sources** for J.B. Hunt (its property-carrier row is missing), for Werner (a false Inactive in June) and for Orange Creek (a grant the legacy sources don't show). That is why the fix keeps Motus on its own line.

## 4. How many carriers are affected

`diagnostics/affected_carriers.sql` is read-only and can be pasted into the SQL editor. On 2026-10-08 it returned:

- **106,342** carriers with an active USDOT number, no active OOS order and inactive for-hire authority (L&I mirror rows dated 2026-06-12 to 2026-09-27). `lookup_carrier` says "Authorized to operate" for each.
- **19,902** broker-only firms with an active USDOT number. `lookup_carrier` says "Authorized to operate" with no mention that it's broker authority only.
- **Every carrier** gets "MC Number: Not reported by FMCSA" unless the caller passes one.

These are estimates from the hub's L&I mirror; live QCMobile is the authority.

## 5. Proposed fix (diff only, not applied)

**Files**

- **`diagnostics/lookup_carrier_fix.diff`** (applies cleanly to `src/index.ts`; checked with `git apply --check`).
- **`diagnostics/proposed_mcp_motus_authority.sql`**: a read-only RPC plus a one-line allowlist addition to the `tea-mcp-rpc` gateway.

**What changes**

1. **One shared reader, `readLiveFmcsa()`,** used by both `lookup_carrier` and `generate_investigation_report`. It fetches three things in parallel: the QCMobile carrier record, `/docket-numbers`, and the Motus mirror (optional). A failure in the last two never hides the carrier record.
2. **Two separate answers instead of one.**
   - `USDOT Operating Status`, from `statusCode`, `allowedToOperate` and `oosDate`. Examples: "Active; allowed to operate (no out-of-service order)"; "Active; NOT allowed to operate (federal out-of-service order)"; "Inactive; not allowed to operate".
   - `For-hire Operating Authority (MC)`, from `commonAuthorityStatus` and `contractAuthorityStatus`. Examples: "ACTIVE"; "INACTIVE: revoked or not reinstated. Not authorized for interstate for-hire carriage (the USDOT number may still be active)"; "Broker authority only"; "None on file (normal for private, exempt or intrastate carriers)"; "Unknown: FMCSA returned no operating authority record".
   - Plus an `Authority Detail` line showing the raw codes.
3. **The MC number comes from `/docket-numbers`.** The `mc_number` argument is used only as a labelled fallback ("as supplied; FMCSA lists no docket").
4. **Motus appears on its own line and never changes the status:** "Motus Registry (separate source, not used for the status above)". This follows Rob's toggle design, because Motus conflicts heavily with the legacy data since the migration. When the two disagree, a `Source Note` line says so in plain words and tells the reader to verify on SAFER, rather than picking one silently. This replaces the "most restrictive wins" idea from the task brief: a most-restrictive merge would have marked Werner as revoked in June.
5. **Scorecard relabel.** `carrier_vetting_scorecard`'s census `Status: A` line becomes "USDOT Status (census; for live MC authority run lookup_carrier)".

**Deploy order once approved**

1. Run `proposed_mcp_motus_authority.sql`.
2. Add `mcp_motus_authority` to `ALLOWED_RPCS` in tea-mcp-rpc and deploy it.
3. Deploy the Worker.

Without steps 1 and 2 the Worker still works and shows "Motus Registry: Not checked".

## 6. Other tools: same code path?

| Tool | Shares the bug? | Notes |
|---|---|---|
| `generate_investigation_report` | **Yes** | Uses `fetchQcMobileIdentity()`, which has the same `allowedToOperate` logic. Fixed by the same diff, which turns the helper into a wrapper over `readLiveFmcsa()`. |
| `new_entrant_workup` | **Indirectly** | Its RPC says "Authority status, MC number and out-of-service orders come from lookup_carrier", so it inherits whatever `lookup_carrier` says. Fixed when `lookup_carrier` is. |
| `carrier_vetting_scorecard` | **Labelling only** | The `carrier_lookup` edge function returns census `STATUS_CODE` ("A" even for revoked carriers), printed as "Status: A". Relabelled in the diff. |
| `investigate_dot`, `chameleon_risk_score`, `investigate_carrier` | No | They read census `status_code` for scoring and inactive flags but never print an authority status. |
| `insurance_coverage_check`, `carrier_exposure_signals`, the timeline and the other network tools | No | No authority status output. |
| `lookup_carrier` cache fallback | Minor | `authority_status` is explicitly null, but the dumped census row includes `status_code`. Consider omitting `status_code` from that dump. |

**Related, outside this Worker.** The hub's `qcmobile-status` function, used by MotusVerifi and LoadVerifi, already reads the common, contract and broker fields correctly (fixed 2026-10-07). It takes the MC docket from `/authority`, which returns nothing for inactive carriers, so revoked carriers get `docket: null` there. The same `/docket-numbers` change applies to it.

## Files in diagnostics/

- `lookup_carrier_authority_report.md` (this report)
- `lookup_carrier_fix.diff` (the proposed Worker change, not applied)
- `proposed_mcp_motus_authority.sql` (the proposed RPC and gateway line, not applied)
- `affected_carriers.sql` (read-only count)
- `<dot>/{carrier,authority,docket_numbers,oos}.json` (raw QCMobile, 2026-10-08 09:43 UTC)
- `safer_snapshots.txt`, `motus_mirror.json`, `simulate.js`, `simulation_output.json`, `extract.js`
