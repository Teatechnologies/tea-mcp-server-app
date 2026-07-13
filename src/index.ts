import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration constants — easy to correct in one place.
//
// TEA scores/scorecards come from real Supabase Edge Functions (Bearer
// API-key auth). FMCSA QCMobile remains the source of truth for legal name,
// authority status, MC/docket, and out-of-service status.
// ---------------------------------------------------------------------------

// Base path for the Supabase Edge Functions, appended to SUPABASE_URL.
const FUNCTIONS_BASE_PATH = "/functions/v1";

// Edge Function names.
const FN_CARRIER_SCORE = "carrier_score";
const FN_CARRIER_LOOKUP = "carrier_lookup";
// NOTE: this function name uses hyphens, not underscores.
const FN_NEW_ENTRANT = "new-entrant-full-report";
// Gateway Edge Function: POST { rpc, params } -> { rpc, data, data_source, as_of }.
const FN_GATEWAY = "tea-mcp-rpc";
// Dedicated VIN-network Edge Function: POST { dot_number } -> full object (no "data" wrapper).
const FN_VIN_NETWORK = "vin-network";

// Gateway RPC names (kept here so they are easy to correct in one place).
const RPC_INVESTIGATE_CARRIER = "investigate_carrier";
const RPC_INVESTIGATE_OFFICER = "investigate_officer";
const RPC_SAME_SESSION_FILINGS = "carrier_same_session_filings";
const RPC_EXPOSURE_SIGNALS = "carrier_exposure_signals";
const RPC_VIN_TRANSITIONS = "get_vin_transitions";
const RPC_CARRIER_VIN_DETAIL = "get_carrier_vin_detail";
const RPC_ADDRESS_NETWORK = "get_address_network";
const RPC_REINCARNATION_NETWORK = "get_reincarnation_network";
const RPC_CARRIER_EVENT_TIMELINE = "get_carrier_event_timeline";
const RPC_CHAMELEON_RISK = "score_chameleon_risk";
const RPC_NETWORK_SEARCH = "network_builder_search";
const RPC_CARRIERS_BY_PHONE = "get_carriers_by_phone";
const RPC_INVESTIGATE_DOT = "investigate_dot";

// FMCSA QCMobile live carrier endpoint (identity / authority / OOS status).
// The DOT number and webKey are interpolated at call time.
const QCMOBILE_CARRIER_URL = (dot: string, webKey: string) =>
	`https://mobile.fmcsa.dot.gov/qc/services/carriers/${encodeURIComponent(
		dot,
	)}?webKey=${encodeURIComponent(webKey)}`;

// Secret bindings are injected by the Worker runtime and are not part of the
// generated Cloudflare.Env. Declare them here so they are strongly typed.
declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Cloudflare {
		interface Env {
			SUPABASE_URL: string;
			SUPABASE_KEY: string;
			QCMOBILE_WEBKEY: string;
			TEA_API_KEY: string;
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a friendly error MCP result. */
function errorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
	};
}

/** Build a plain-text MCP result. */
function textResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
	};
}

/**
 * Ensure a required secret is present; returns the value or throws a friendly
 * error carrying the secret's name.
 */
function requireSecret(value: string | undefined, name: string): string {
	if (!value || value.trim() === "") {
		throw new Error(
			`Server is missing the ${name} configuration. Please ask an administrator to set the ${name} secret on the Worker.`,
		);
	}
	return value;
}

/** Format a possibly-missing value for display. */
function fmt(value: unknown): string {
	if (value === undefined || value === null || value === "") return "N/A";
	if (typeof value === "boolean") return value ? "Yes" : "No";
	return String(value);
}

/** Turn a snake_case / kebab-case key into a readable Title Case label. */
function prettyKey(key: string): string {
	return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Recursively render an arbitrary JSON value into readable, indented lines.
 * Used by new_entrant_workup, whose report shape varies; missing/empty values
 * fall back to the fmt() convention.
 */
function renderValue(value: unknown, indent: string): string[] {
	if (value === undefined || value === null || value === "") {
		return [`${indent}N/A`];
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${indent}(none)`];
		const out: string[] = [];
		value.forEach((item, i) => {
			if (item && typeof item === "object") {
				out.push(`${indent}- [${i + 1}]`);
				out.push(...renderValue(item, `${indent}    `));
			} else {
				out.push(`${indent}- ${fmt(item)}`);
			}
		});
		return out;
	}
	if (typeof value === "object") {
		const out: string[] = [];
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (v && typeof v === "object") {
				out.push(`${indent}${prettyKey(k)}:`);
				out.push(...renderValue(v, `${indent}  `));
			} else {
				out.push(`${indent}${prettyKey(k)}: ${fmt(v)}`);
			}
		}
		return out;
	}
	return [`${indent}${fmt(value)}`];
}

/**
 * Call a TEA Supabase Edge Function for a DOT number (Bearer API-key auth) and
 * return the parsed JSON object. Throws a friendly error on failure.
 */
async function fetchEdgeFunction(
	env: Cloudflare.Env,
	functionName: string,
	dotNumber: string,
): Promise<Record<string, unknown>> {
	const supabaseUrl = requireSecret(env.SUPABASE_URL, "SUPABASE_URL");
	const teaApiKey = requireSecret(env.TEA_API_KEY, "TEA_API_KEY");

	const url = `${supabaseUrl.replace(/\/+$/, "")}${FUNCTIONS_BASE_PATH}/${functionName}/${encodeURIComponent(
		dotNumber,
	)}`;

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${teaApiKey}`,
			},
		});
	} catch (e) {
		throw new Error(
			`Could not reach the TEA service (${functionName}): ${(e as Error).message}`,
		);
	}

	const raw = await resp.text();
	if (!resp.ok) {
		throw new Error(
			`TEA service (${functionName}) returned ${resp.status} ${resp.statusText}: ${raw.slice(0, 300)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		throw new Error(
			`TEA service (${functionName}) returned a response that was not valid JSON.`,
		);
	}

	if (Array.isArray(parsed)) parsed = parsed[0];
	if (parsed === null || parsed === undefined || typeof parsed !== "object") {
		throw new Error(`No TEA data was found for DOT ${dotNumber}.`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * POST to the TEA gateway Edge Function ({ rpc, params }) and return the parsed
 * "data" object. Throws a friendly error on a non-200 response or an {error}
 * body.
 */
async function callGateway(
	env: Cloudflare.Env,
	rpcName: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const supabaseUrl = requireSecret(env.SUPABASE_URL, "SUPABASE_URL");
	const teaApiKey = requireSecret(env.TEA_API_KEY, "TEA_API_KEY");

	const url = `${supabaseUrl.replace(/\/+$/, "")}${FUNCTIONS_BASE_PATH}/${FN_GATEWAY}`;

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${teaApiKey}`,
			},
			body: JSON.stringify({ rpc: rpcName, params }),
		});
	} catch (e) {
		throw new Error(`Could not reach the TEA gateway (${rpcName}): ${(e as Error).message}`);
	}

	const raw = await resp.text();
	if (!resp.ok) {
		throw new Error(
			`TEA gateway (${rpcName}) returned ${resp.status} ${resp.statusText}: ${raw.slice(0, 300)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		throw new Error(`TEA gateway (${rpcName}) returned a response that was not valid JSON.`);
	}

	if (parsed === null || typeof parsed !== "object") {
		throw new Error(`TEA gateway (${rpcName}) returned an empty response.`);
	}

	const body = parsed as Record<string, unknown>;
	if (body.error) {
		const err = body.error;
		const message =
			err && typeof err === "object"
				? String((err as Record<string, unknown>).message ?? JSON.stringify(err))
				: String(err);
		throw new Error(`TEA gateway (${rpcName}) error: ${message}`);
	}

	const data = body.data;
	if (data === null || data === undefined || typeof data !== "object") {
		throw new Error(`TEA gateway (${rpcName}) returned no data.`);
	}
	return data as Record<string, unknown>;
}

/**
 * Call the dedicated vin-network Edge Function for a DOT and return the parsed
 * object. Mirrors the inline logic in the vin_network tool so the orchestrator
 * can reuse it without touching that tool. Throws a friendly error on failure.
 */
async function fetchVinNetwork(
	env: Cloudflare.Env,
	dotNumber: string,
): Promise<Record<string, unknown>> {
	const supabaseUrl = requireSecret(env.SUPABASE_URL, "SUPABASE_URL");
	const teaApiKey = requireSecret(env.TEA_API_KEY, "TEA_API_KEY");
	const url = `${supabaseUrl.replace(/\/+$/, "")}${FUNCTIONS_BASE_PATH}/${FN_VIN_NETWORK}`;

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${teaApiKey}`,
			},
			body: JSON.stringify({ dot_number: dotNumber }),
		});
	} catch (e) {
		throw new Error(`Could not reach the VIN-network service: ${(e as Error).message}`);
	}

	const raw = await resp.text();
	if (!resp.ok) {
		throw new Error(
			`VIN-network service returned ${resp.status} ${resp.statusText}: ${raw.slice(0, 300)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		throw new Error("VIN-network service returned a response that was not valid JSON.");
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new Error(`No VIN-network data was found for DOT ${dotNumber}.`);
	}
	const data = parsed as Record<string, unknown>;
	if (data.error) {
		const err = data.error;
		const message =
			err && typeof err === "object"
				? String((err as Record<string, unknown>).message ?? JSON.stringify(err))
				: String(err);
		throw new Error(`VIN-network service error: ${message}`);
	}
	return data;
}

/**
 * Normalize an officer / person name for cross-referencing: upper-case, strip
 * punctuation and common honorifics/suffixes, and collapse whitespace. The
 * existing officer_network tool passes names through verbatim, so this is the
 * canonical normalizer shared by the orchestrator and corporate_registry_search.
 */
function normalizeOfficerName(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[.,'"]/g, " ")
		.replace(/\b(JR|SR|II|III|IV|V|MR|MRS|MS|DR|MD|ESQ)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Keys whose *name* marks an officer/principal context, and keys that carry an
// actual person name once we are inside such a context.
const OFFICER_CONTEXT_KEY = /officer|principal|owner|representative|contact|agent/i;
const PERSON_NAME_KEY = /^(name|full_name|officer_name|person|person_name|contact_name)$/i;

/**
 * Recursively pull candidate officer names out of an arbitrary gateway result.
 * Shapes vary across RPCs, so this is deliberately defensive: it collects string
 * values that are either directly under an officer-ish key or under a name-ish
 * key nested inside an officer-ish context. Returns names de-duplicated by their
 * normalized form, preserving the first display spelling seen.
 */
function extractOfficerNames(value: unknown): string[] {
	const found: string[] = [];
	const walk = (v: unknown, underOfficer: boolean): void => {
		if (v === null || v === undefined) return;
		if (typeof v === "string") {
			if (underOfficer && v.trim()) found.push(v.trim());
			return;
		}
		if (Array.isArray(v)) {
			for (const item of v) walk(item, underOfficer);
			return;
		}
		if (typeof v === "object") {
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				const keyIsOfficer = OFFICER_CONTEXT_KEY.test(k);
				if (typeof val === "string") {
					if ((keyIsOfficer || (underOfficer && PERSON_NAME_KEY.test(k))) && val.trim()) {
						found.push(val.trim());
					}
				} else {
					walk(val, underOfficer || keyIsOfficer);
				}
			}
		}
	};
	walk(value, false);

	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of found) {
		const norm = normalizeOfficerName(name);
		// Skip obvious non-names (empty after normalization, or pure numbers).
		if (!norm || /^\d+$/.test(norm)) continue;
		if (seen.has(norm)) continue;
		seen.add(norm);
		out.push(name);
	}
	return out;
}

/** Return the first primitive value whose key matches, searched recursively. */
function findFirstValue(value: unknown, keyRegex: RegExp): string | number | undefined {
	let result: string | number | undefined;
	const walk = (v: unknown): void => {
		if (result !== undefined || v === null || typeof v !== "object") return;
		if (Array.isArray(v)) {
			for (const item of v) {
				walk(item);
				if (result !== undefined) return;
			}
			return;
		}
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (
				(typeof val === "string" || typeof val === "number") &&
				val !== "" &&
				keyRegex.test(k)
			) {
				result = val;
				return;
			}
		}
		for (const val of Object.values(v as Record<string, unknown>)) {
			walk(val);
			if (result !== undefined) return;
		}
	};
	walk(value);
	return result;
}

/** Sum the lengths of every array found under a key matching keyRegex. */
function countArrayItems(value: unknown, keyRegex: RegExp): number {
	let total = 0;
	const walk = (v: unknown): void => {
		if (v === null || typeof v !== "object") return;
		if (Array.isArray(v)) {
			for (const item of v) walk(item);
			return;
		}
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (Array.isArray(val) && keyRegex.test(k)) total += val.length;
			walk(val);
		}
	};
	walk(value);
	return total;
}

/** One-line "key: count" summary of the top arrays in a result (depth-limited). */
function summarizeArrays(value: unknown): string[] {
	const parts: string[] = [];
	const walk = (v: unknown, prefix: string, depth: number): void => {
		if (depth > 2 || v === null || typeof v !== "object" || Array.isArray(v)) return;
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (Array.isArray(val)) parts.push(`${prefix}${k}: ${val.length}`);
			else if (val && typeof val === "object") walk(val, `${prefix}${k}.`, depth + 1);
		}
	};
	walk(value, "", 0);
	return parts;
}

// ---------------------------------------------------------------------------
// Corporate registry search — shared core
//
// corporate_registry_search (the standalone MCP tool) and the orchestrator's
// per-officer corporate enrichment both go through this one function. It is
// stubbed until the corporate_registry_search work item lands its registry
// fetchers + KV cache; the orchestrator reports enrichment as "pending" rather
// than fabricating matches in the meantime.
// ---------------------------------------------------------------------------

interface CorpRegistryOutcome {
	available: boolean;
	note?: string;
	matches: unknown[];
	sources_checked: string[];
	sources_failed: string[];
}

async function corporateRegistrySearchCore(
	_env: Cloudflare.Env,
	_args: { name: string; state?: string; search_type: "company" | "officer" },
): Promise<CorpRegistryOutcome> {
	return {
		available: false,
		note: "corporate_registry_search is not yet deployed; corporate enrichment pending.",
		matches: [],
		sources_checked: [],
		sources_failed: [],
	};
}

// ---------------------------------------------------------------------------
// MCP agent
// ---------------------------------------------------------------------------

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "TEA Highway Intelligence",
		version: "1.0.0",
	});

	async init() {
		// -------------------------------------------------------------------
		// Tool 1 — lookup_carrier
		// Live FMCSA QCMobile identity/authority/OOS + TEA score & risk tier.
		// -------------------------------------------------------------------
		this.server.registerTool(
			"lookup_carrier",
			{
				description:
					"Look up a motor carrier's live FMCSA identity, operating authority, MC number, and out-of-service status (from the QCMobile API), plus the TEA risk score (lower = safer) and risk tier.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
					mc_number: z
						.string()
						.optional()
						.describe(
							"Optional MC/docket number, used as a fallback if FMCSA does not return one.",
						),
				},
			},
			async ({ dot_number, mc_number }) => {
				const env = this.env as Cloudflare.Env;

				// --- Live FMCSA QCMobile lookup (never from Supabase) ---
				let carrier: Record<string, unknown> = {};
				try {
					const webKey = requireSecret(env.QCMOBILE_WEBKEY, "QCMOBILE_WEBKEY");
					const resp = await fetch(QCMOBILE_CARRIER_URL(dot_number, webKey), {
						headers: { Accept: "application/json" },
					});
					const raw = await resp.text();
					if (!resp.ok) {
						return errorResult(
							`FMCSA QCMobile returned ${resp.status} ${resp.statusText} for DOT ${dot_number}.`,
						);
					}
					let parsed: unknown;
					try {
						parsed = raw ? JSON.parse(raw) : null;
					} catch {
						return errorResult(
							"FMCSA QCMobile returned a response that was not valid JSON.",
						);
					}
					// QCMobile shape: { content: { carrier: {...} } | [{ carrier: {...} }] }
					const content = (parsed as Record<string, unknown> | null)?.content;
					if (Array.isArray(content)) {
						carrier =
							((content[0] as Record<string, unknown>)?.carrier as Record<
								string,
								unknown
							>) ?? {};
					} else if (content && typeof content === "object") {
						const c = (content as Record<string, unknown>).carrier;
						carrier =
							(c as Record<string, unknown>) ?? (content as Record<string, unknown>);
					}
					if (!carrier || Object.keys(carrier).length === 0) {
						return errorResult(`No FMCSA carrier record found for DOT ${dot_number}.`);
					}
				} catch (e) {
					return errorResult((e as Error).message);
				}

				// --- Extract readable fields defensively ---
				const name =
					(carrier.legalName as string) || (carrier.dbaName as string) || "Unknown";
				const dot = (carrier.dotNumber as string | number) ?? dot_number;
				const mc = (carrier.docketNumber as string) || mc_number || "Not reported by FMCSA";
				const allowed = carrier.allowedToOperate;
				const authority =
					allowed === "Y"
						? "Authorized to operate"
						: allowed === "N"
							? "NOT authorized to operate"
							: "Unknown";
				const oosDate = (carrier.oosDate as string) || (carrier.outOfServiceDate as string);
				const oosStatus = oosDate
					? `OUT OF SERVICE (since ${oosDate})`
					: "Not out of service";

				// --- TEA risk score & risk tier (from Supabase Edge Function) ---
				let teaScore = "N/A";
				let riskTier = "N/A";
				try {
					const payload = await fetchEdgeFunction(env, FN_CARRIER_SCORE, dot_number);
					teaScore = fmt(payload.tea_score);
					riskTier = fmt(payload.risk_tier);
				} catch (e) {
					teaScore = `Unavailable (${(e as Error).message})`;
				}

				const summary = [
					`Carrier: ${name}`,
					`DOT Number: ${dot}`,
					`MC Number: ${mc}`,
					`Authority Status: ${authority}`,
					`Out-of-Service Status: ${oosStatus}`,
					// Risk score: lower = safer (e.g. 15.4 is lower-risk than 23).
					`TEA Risk Score (lower = safer): ${teaScore}`,
					`Risk Tier: ${riskTier}`,
				].join("\n");

				return textResult(summary);
			},
		);

		// -------------------------------------------------------------------
		// Tool 2 — carrier_vetting_scorecard
		// Full TEA scorecard from the carrier_lookup Edge Function.
		// -------------------------------------------------------------------
		this.server.registerTool(
			"carrier_vetting_scorecard",
			{
				description:
					"Return the full TEA carrier vetting scorecard for a DOT number: overall TEA score and risk tier, a Safety section, and a Flags section.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;

				let payload: Record<string, unknown>;
				try {
					payload = await fetchEdgeFunction(env, FN_CARRIER_LOOKUP, dot_number);
				} catch (e) {
					return errorResult((e as Error).message);
				}

				const flags = (payload.flags as Record<string, unknown>) ?? {};
				const safety = (payload.safety as Record<string, unknown>) ?? {};

				const lines: string[] = [
					`TEA Carrier Vetting Scorecard — DOT ${dot_number}`,
					`Legal Name: ${fmt(payload.legal_name)}`,
					`Status: ${fmt(payload.status)}`,
					`Officer: ${fmt(payload.officer)}`,
					"",
					`Overall TEA Score: ${fmt(payload.tea_score)}`,
					`Risk Tier: ${fmt(payload.risk_tier)}`,
					"",
					"Safety:",
					`  Total Inspections: ${fmt(safety.total_inspections)}`,
					`  Total Violations: ${fmt(safety.total_violations)}`,
					`  Total Out-of-Service: ${fmt(safety.total_oos)}`,
					`  Crash Count: ${fmt(safety.crash_count)}`,
					`  Recordable Crash Rate: ${fmt(safety.recordable_crash_rate)}`,
					"",
					"Flags:",
					`  ELD Connection: ${fmt(flags.eld_connection)}`,
					`  ELD Company: ${fmt(flags.eld_company)}`,
					`  ELD Identifier: ${fmt(flags.eld_identifier)}`,
					`  ELD Revocation: ${fmt(flags.eld_revocation)}`,
					`  Reincarnation Watch: ${fmt(flags.reincarnation_watch)}`,
					`  Prior Revoke: ${fmt(flags.prior_revoke)}`,
					`  Vault Match: ${fmt(flags.vault_match)}`,
				];

				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 3 — new_entrant_workup
		// Comprehensive FMCSA new-entrant fitness workup via the
		// new-entrant-full-report Edge Function.
		// -------------------------------------------------------------------
		this.server.registerTool(
			"new_entrant_workup",
			{
				description:
					"Run a comprehensive FMCSA new-entrant fitness workup on a carrier by DOT number. Returns the full TEA new-entrant assessment — entity profile, authority/census, crashes, inspections, insurance, watchlists, network cross-references, the D1–D5 composite score and tier, and (if a Janus questionnaire exists) questionnaire contradiction analysis. Designed for federal investigators and FMCSA compliance reviews.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;

				// The Edge Function needs an integer DOT — a string DOT was the
				// bug we hit with carrier_score.
				const dotInt = Number(dot_number);
				if (!Number.isInteger(dotInt)) {
					return errorResult(`DOT number must be numeric. Received: ${dot_number}`);
				}

				let supabaseUrl: string;
				let teaApiKey: string;
				try {
					supabaseUrl = requireSecret(env.SUPABASE_URL, "SUPABASE_URL");
					teaApiKey = requireSecret(env.TEA_API_KEY, "TEA_API_KEY");
				} catch (e) {
					return errorResult((e as Error).message);
				}

				const base = `${supabaseUrl.replace(/\/+$/, "")}${FUNCTIONS_BASE_PATH}/${FN_NEW_ENTRANT}`;
				const authHeaders = {
					Accept: "application/json",
					Authorization: `Bearer ${teaApiKey}`,
				};

				// The request contract is not yet confirmed. Try POST (DOT +
				// hasQuestionnaire flag in the body) first, then fall back to GET
				// with the DOT in the path. The raw status + body are surfaced in
				// a TEMPORARY DEBUG block below so we can confirm the real shape
				// (remove once verified, as we did for carrier_score).
				let usedMethod = "POST";
				let status = "";
				let raw = "";
				try {
					const postResp = await fetch(base, {
						method: "POST",
						headers: { ...authHeaders, "Content-Type": "application/json" },
						body: JSON.stringify({ dot_number: dotInt, hasQuestionnaire: false }),
					});
					status = `${postResp.status} ${postResp.statusText}`;
					raw = await postResp.text();
					if (!postResp.ok) {
						const getResp = await fetch(`${base}/${dotInt}`, {
							method: "GET",
							headers: authHeaders,
						});
						const getStatus = `${getResp.status} ${getResp.statusText}`;
						const getRaw = await getResp.text();
						if (getResp.ok) {
							usedMethod = "GET";
							status = getStatus;
							raw = getRaw;
						} else {
							return textResult(
								[
									`TEA New-Entrant Fitness Workup — DOT ${dotInt}`,
									"Could not retrieve the new-entrant report (both POST and GET failed).",
									`DEBUG POST status: ${status}`,
									`DEBUG POST body: ${raw.slice(0, 1500)}`,
									`DEBUG GET status: ${getStatus}`,
									`DEBUG GET body: ${getRaw.slice(0, 1500)}`,
								].join("\n"),
							);
						}
					}
				} catch (e) {
					return errorResult(
						`Could not reach the TEA service (${FN_NEW_ENTRANT}): ${(e as Error).message}`,
					);
				}

				let payload: Record<string, unknown> = {};
				try {
					let parsed: unknown = raw ? JSON.parse(raw) : null;
					if (Array.isArray(parsed)) parsed = parsed[0];
					if (parsed && typeof parsed === "object") {
						payload = parsed as Record<string, unknown>;
					}
				} catch {
					// Leave payload empty; the raw body is surfaced in DEBUG below.
				}

				// Locate the composite score and tier (best-guess keys, confirmed
				// via the DEBUG block until the real shape is verified).
				const COMPOSITE_KEYS = ["composite_score", "composite", "d_composite", "score"];
				const TIER_KEYS = ["tier", "composite_tier", "risk_tier"];
				const compositeKey = COMPOSITE_KEYS.find((k) => payload[k] !== undefined);
				const tierKey = TIER_KEYS.find((k) => payload[k] !== undefined);
				const composite = compositeKey ? payload[compositeKey] : undefined;
				const tier = tierKey ? payload[tierKey] : undefined;
				const compositeIsObject = composite !== null && typeof composite === "object";

				const lines: string[] = [`TEA New-Entrant Fitness Workup — DOT ${dotInt}`];
				if (compositeIsObject) {
					lines.push("Composite Score (D1–D5):");
					lines.push(...renderValue(composite, "  "));
				} else {
					lines.push(`Composite Score (D1–D5): ${fmt(composite)}`);
				}
				lines.push(`Tier: ${fmt(tier)}`, "");

				// Narrative sections: render every other top-level section the
				// report returns, whatever its shape.
				const consumed = new Set<string>(
					[compositeKey, tierKey].filter(Boolean) as string[],
				);
				for (const [key, value] of Object.entries(payload)) {
					if (consumed.has(key)) continue;
					lines.push(`${prettyKey(key)}:`);
					lines.push(...renderValue(value, "  "));
					lines.push("");
				}

				// TEMPORARY: confirm method + response shape, then remove.
				lines.push(`DEBUG method: ${usedMethod}`);
				lines.push(`DEBUG status: ${status}`);
				lines.push(`DEBUG raw (first 1500 chars): ${raw.slice(0, 1500)}`);

				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 4 — carrier_network
		// Network / chameleon relationships for a DOT (gateway RPC).
		// -------------------------------------------------------------------
		this.server.registerTool(
			"carrier_network",
			{
				description:
					"Find carriers connected to a DOT through shared officers, addresses, phones, or VINs — surfaces network and chameleon relationships.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_INVESTIGATE_CARRIER, {
						seed_dot: dot_number,
					});
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Carrier Network — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 5 — officer_network
		// Carriers tied to a company officer by name (gateway RPC).
		// -------------------------------------------------------------------
		this.server.registerTool(
			"officer_network",
			{
				description:
					"Find all carriers tied to a company officer by name across the FMCSA universe.",
				inputSchema: {
					officer_name: z
						.string()
						.describe("Company officer name to search for (required)."),
				},
			},
			async ({ officer_name }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_INVESTIGATE_OFFICER, { officer_name });
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Officer Network — ${officer_name}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 6 — same_session_filings
		// Carriers that filed FMCSA updates the same day (gateway RPC).
		// -------------------------------------------------------------------
		this.server.registerTool(
			"same_session_filings",
			{
				description:
					"Find carriers that filed FMCSA authority/MCS-150 updates the same day as this DOT — a filing-service / chameleon signal.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_SAME_SESSION_FILINGS, { p_dot: dot_number });
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Same-Session Filings — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 7 — carrier_exposure_signals
		// Broker-vetting exposure signals for a DOT (gateway RPC).
		// -------------------------------------------------------------------
		this.server.registerTool(
			"carrier_exposure_signals",
			{
				description:
					"Broker-vetting exposure signals for a DOT: insurer quality, capacity, clone-truck hits, litigation, authority age.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_EXPOSURE_SIGNALS, { p_dot: dot_number });
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Carrier Exposure Signals — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 8 — vin_network
		// Uses the dedicated vin-network Edge Function directly (the gateway
		// get_vin_network RPC is broken — missing vin_problem_child table).
		// Response is the full object, NOT wrapped in a "data" field.
		// -------------------------------------------------------------------
		this.server.registerTool(
			"vin_network",
			{
				description:
					"Every VIN operated by this DOT and every other carrier that has used those VINs — the core VIN-crossover / clone-truck view.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;

				let data: Record<string, unknown>;
				try {
					const supabaseUrl = requireSecret(env.SUPABASE_URL, "SUPABASE_URL");
					const teaApiKey = requireSecret(env.TEA_API_KEY, "TEA_API_KEY");
					const url = `${supabaseUrl.replace(/\/+$/, "")}${FUNCTIONS_BASE_PATH}/${FN_VIN_NETWORK}`;

					const resp = await fetch(url, {
						method: "POST",
						headers: {
							Accept: "application/json",
							"Content-Type": "application/json",
							Authorization: `Bearer ${teaApiKey}`,
						},
						body: JSON.stringify({ dot_number }),
					});

					const raw = await resp.text();
					if (!resp.ok) {
						return errorResult(
							`VIN-network service returned ${resp.status} ${resp.statusText}: ${raw.slice(0, 300)}`,
						);
					}

					let parsed: unknown;
					try {
						parsed = raw ? JSON.parse(raw) : null;
					} catch {
						return errorResult(
							"VIN-network service returned a response that was not valid JSON.",
						);
					}
					if (parsed === null || typeof parsed !== "object") {
						return errorResult(`No VIN-network data was found for DOT ${dot_number}.`);
					}
					// The response IS the payload (no "data" wrapper) — use it as-is.
					data = parsed as Record<string, unknown>;
					if (data.error) {
						const err = data.error;
						const message =
							err && typeof err === "object"
								? String(
										(err as Record<string, unknown>).message ??
											JSON.stringify(err),
									)
								: String(err);
						return errorResult(`VIN-network service error: ${message}`);
					}
				} catch (e) {
					return errorResult((e as Error).message);
				}

				const lines: string[] = [`VIN Network — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 9 — vin_transitions
		// -------------------------------------------------------------------
		this.server.registerTool(
			"vin_transitions",
			{
				description:
					"VINs that moved from this DOT to a new DOT, with crash dates — surfaces equipment handed off to successor/chameleon carriers.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_VIN_TRANSITIONS, {
						p_dot: String(parseInt(dot_number, 10)),
					});
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`VIN Transitions — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 10 — carrier_vin_detail
		// -------------------------------------------------------------------
		this.server.registerTool(
			"carrier_vin_detail",
			{
				description: "Every VIN and plate operated by a DOT with inspection counts.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_CARRIER_VIN_DETAIL, {
						target_dot: String(parseInt(dot_number, 10)),
					});
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Carrier VIN Detail — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 11 — address_network
		// -------------------------------------------------------------------
		this.server.registerTool(
			"address_network",
			{
				description: "Carriers sharing an address, phone, email, or officer with this DOT.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_ADDRESS_NETWORK, {
						p_dot_number: String(parseInt(dot_number, 10)),
					});
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Address Network — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 12 — reincarnation_network
		// -------------------------------------------------------------------
		this.server.registerTool(
			"reincarnation_network",
			{
				description:
					"Reincarnation matches for a DOT based on officer/address/phone overlap — chameleon successor detection.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_REINCARNATION_NETWORK, {
						p_dot_number: String(parseInt(dot_number, 10)),
					});
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Reincarnation Network — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 13 — carrier_event_timeline
		// NOTE: this RPC takes the DOT as a BIGINT — pass a number, not a string.
		// -------------------------------------------------------------------
		this.server.registerTool(
			"carrier_event_timeline",
			{
				description:
					"Chronological timeline of filings, crashes, OOS events, and enforcement for a carrier.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_CARRIER_EVENT_TIMELINE, {
						p_dot: parseInt(dot_number, 10),
					});
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Carrier Event Timeline — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 14 — chameleon_risk_score
		// -------------------------------------------------------------------
		this.server.registerTool(
			"chameleon_risk_score",
			{
				description:
					"Chameleon risk score 0-100 with tier, connection counts, and top shared-VIN partner.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_CHAMELEON_RISK, {
						seed_dot: String(parseInt(dot_number, 10)),
					});
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Chameleon Risk Score — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 15 — network_search
		// -------------------------------------------------------------------
		this.server.registerTool(
			"network_search",
			{
				description:
					"Find all carriers reachable from any seed — phone, email, address, officer name, or DOT — across multiple hops.",
				inputSchema: {
					seed_value: z
						.string()
						.describe(
							"Seed value: phone, email, address, officer name, or DOT (required).",
						),
					max_depth: z
						.number()
						.int()
						.min(1)
						.max(4)
						.optional()
						.default(2)
						.describe("Number of hops to traverse (default 2, max 4)."),
				},
			},
			async ({ seed_value, max_depth }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_NETWORK_SEARCH, { seed_value, max_depth });
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [
					`Network Search — "${seed_value}" (depth ${max_depth})`,
					"",
				];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 16 — carriers_by_phone
		// -------------------------------------------------------------------
		this.server.registerTool(
			"carriers_by_phone",
			{
				description: "All carriers tied to a given phone number.",
				inputSchema: {
					phone: z.string().describe("Phone number to search for (required)."),
				},
			},
			async ({ phone }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_CARRIERS_BY_PHONE, { p_phone: phone });
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Carriers By Phone — ${phone}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 17 — investigate_dot
		// -------------------------------------------------------------------
		this.server.registerTool(
			"investigate_dot",
			{
				description:
					"Full chameleon and network investigation bundle for a DOT in one call.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;
				let data: Record<string, unknown>;
				try {
					data = await callGateway(env, RPC_INVESTIGATE_DOT, {
						input_dot: String(parseInt(dot_number, 10)),
					});
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Investigate DOT — ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				return textResult(lines.join("\n"));
			},
		);

		// -------------------------------------------------------------------
		// Tool 18 — generate_investigation_report
		// Orchestrator: chains the existing investigation tools server-side in
		// a fixed order, extracts officers, optionally enriches each of the top
		// 5 officers via corporate_registry_search, and returns one structured
		// markdown report. No new data sources. Inherits the same gateway /
		// TEA_API_KEY auth as every other tool (no separate tier gate exists).
		// Partial failures are captured per step rather than failing the call.
		// -------------------------------------------------------------------
		this.server.registerTool(
			"generate_investigation_report",
			{
				description:
					"Generate one consolidated carrier investigation report for a DOT number. Chains the existing tools server-side (investigate_dot -> officer_network -> address_network -> vin_network -> same_session_filings -> carrier_exposure_signals), and unless include_corporate is false, cross-references the top 5 discovered officers against free public corporate registries. Returns a single structured markdown report: carrier identity, TEA score, network summary, per-officer corporate entity matches, silent-transfer flags, and a findings section. Resilient to individual step failures.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
					include_corporate: z
						.boolean()
						.optional()
						.default(true)
						.describe(
							"Whether to cross-reference discovered officers against public corporate registries (default true).",
						),
				},
			},
			async ({ dot_number, include_corporate = true }) => {
				const env = this.env as Cloudflare.Env;

				const dotInt = parseInt(dot_number, 10);
				if (!Number.isInteger(dotInt)) {
					return errorResult(`DOT number must be numeric. Received: ${dot_number}`);
				}
				const dotStr = String(dotInt);

				// Each step records its own success/failure so one failing portal
				// or RPC never sinks the whole report.
				interface StepResult {
					key: string;
					title: string;
					ok: boolean;
					data?: Record<string, unknown>;
					error?: string;
				}
				const steps: StepResult[] = [];
				const run = async (
					key: string,
					title: string,
					fn: () => Promise<Record<string, unknown>>,
				): Promise<Record<string, unknown> | undefined> => {
					try {
						const data = await fn();
						steps.push({ key, title, ok: true, data });
						return data;
					} catch (e) {
						steps.push({ key, title, ok: false, error: (e as Error).message });
						return undefined;
					}
				};

				// 1. investigate_dot - the identity/network bundle and officer source.
				const invData = await run("investigate_dot", "Investigation Bundle", () =>
					callGateway(env, RPC_INVESTIGATE_DOT, { input_dot: dotStr }),
				);

				// Officers are discovered from the investigation bundle, then fed
				// into officer_network (which requires a name, not a DOT).
				const officerNames = invData ? extractOfficerNames(invData) : [];
				const primaryOfficer = officerNames[0];

				// 2. officer_network - keyed on the primary discovered officer.
				if (primaryOfficer) {
					await run("officer_network", `Officer Network - ${primaryOfficer}`, () =>
						callGateway(env, RPC_INVESTIGATE_OFFICER, { officer_name: primaryOfficer }),
					);
				} else {
					steps.push({
						key: "officer_network",
						title: "Officer Network",
						ok: false,
						error: "No officer name was found in the investigation bundle to search on.",
					});
				}

				// 3-6. Remaining DOT-keyed steps (param conventions match each tool).
				await run("address_network", "Address Network", () =>
					callGateway(env, RPC_ADDRESS_NETWORK, { p_dot_number: dotStr }),
				);
				await run("vin_network", "VIN Network", () => fetchVinNetwork(env, dot_number));
				await run("same_session_filings", "Same-Session Filings", () =>
					callGateway(env, RPC_SAME_SESSION_FILINGS, { p_dot: dot_number }),
				);
				await run("carrier_exposure_signals", "Exposure Signals", () =>
					callGateway(env, RPC_EXPOSURE_SIGNALS, { p_dot: dot_number }),
				);

				// Corporate enrichment: top 5 officers, via the shared core.
				const topOfficers = officerNames.slice(0, 5);
				const corpResults: { officer: string; outcome: CorpRegistryOutcome }[] = [];
				if (include_corporate) {
					for (const officer of topOfficers) {
						const outcome = await corporateRegistrySearchCore(env, {
							name: officer,
							search_type: "officer",
						});
						corpResults.push({ officer, outcome });
					}
				}

				// --- Compose the markdown report ---
				const dataFor = (key: string) => steps.find((s) => s.key === key)?.data;
				const inv = dataFor("investigate_dot") ?? {};
				const vinData = dataFor("vin_network");
				const ssData = dataFor("same_session_filings");
				const expData = dataFor("carrier_exposure_signals");

				const md: string[] = [];
				md.push(`# Investigation Report - DOT ${dotStr}`, "");

				// Carrier identity
				md.push("## Carrier Identity");
				md.push(
					`- Legal Name: ${fmt(findFirstValue(inv, /legal_name|carrier_name|entity_name|dba_name|company_name/i))}`,
					`- DOT Number: ${dotStr}`,
					`- MC Number: ${fmt(findFirstValue(inv, /docket|mc_number|mc_num/i))}`,
					`- Status: ${fmt(findFirstValue(inv, /operating_status|authority_status|^status$/i))}`,
					`- Principal Address: ${fmt(findFirstValue(inv, /address|principal_address|phy_/i))}`,
					"",
				);

				// TEA score
				md.push("## TEA Score");
				md.push(
					`- TEA / Composite Score: ${fmt(findFirstValue(inv, /tea_score|composite_score|risk_score|chameleon_score/i))}`,
					`- Risk Tier: ${fmt(findFirstValue(inv, /risk_tier|^tier$|composite_tier/i))}`,
					"",
				);

				// Network summary - per-step status + array counts.
				md.push("## Network Summary");
				for (const s of steps) {
					if (!s.ok) {
						md.push(`- **${s.title}**: step failed - ${s.error}`);
						continue;
					}
					const counts = summarizeArrays(s.data);
					md.push(
						`- **${s.title}**: ok${counts.length ? ` (${counts.join(", ")})` : ""}`,
					);
				}
				md.push("");

				md.push("## Officers Discovered");
				if (officerNames.length === 0) {
					md.push("- None found in the investigation bundle.", "");
				} else {
					for (const o of officerNames) {
						md.push(`- ${o}  _(normalized: ${normalizeOfficerName(o)})_`);
					}
					md.push("");
				}

				// Corporate entity matches per officer
				md.push("## Corporate Entity Matches");
				if (!include_corporate) {
					md.push("- Skipped (include_corporate = false).", "");
				} else if (topOfficers.length === 0) {
					md.push("- No officers available to cross-reference.", "");
				} else {
					for (const { officer, outcome } of corpResults) {
						md.push(`### ${officer}`);
						if (!outcome.available) {
							md.push(`- ${outcome.note ?? "No corporate data available."}`);
						} else if (outcome.matches.length === 0) {
							md.push(
								`- No matches. Sources checked: ${outcome.sources_checked.join(", ") || "none"}.`,
							);
						} else {
							md.push(`- ${outcome.matches.length} match(es):`);
							md.push(...renderValue(outcome.matches, "  "));
							if (outcome.sources_failed.length) {
								md.push(`- Sources failed: ${outcome.sources_failed.join(", ")}`);
							}
						}
						md.push("");
					}
				}

				// Silent-transfer flags - heuristic signals from the network steps.
				md.push("## Silent-Transfer Flags");
				const flag = (label: string, present: boolean | undefined, detail: string) => {
					if (present === undefined) md.push(`- ${label}: unknown (source step failed)`);
					else md.push(`- ${label}: ${present ? `yes - ${detail}` : "no"}`);
				};
				const sharedVins = vinData
					? countArrayItems(vinData, /carrier|cross|shared|other|partner|dot/i)
					: undefined;
				const coFilers = ssData
					? countArrayItems(ssData, /filing|carrier|session|match|result|dot/i)
					: undefined;
				const exposureHits = expData
					? countArrayItems(expData, /clone|litig|signal|hit|flag|exposure/i)
					: undefined;
				flag(
					"Shared VINs with other carriers",
					sharedVins === undefined ? undefined : sharedVins > 0,
					`${sharedVins} related VIN/carrier record(s)`,
				);
				flag(
					"Same-session co-filers",
					coFilers === undefined ? undefined : coFilers > 0,
					`${coFilers} co-filing record(s)`,
				);
				flag(
					"Exposure / clone-truck signals",
					exposureHits === undefined ? undefined : exposureHits > 0,
					`${exposureHits} exposure signal(s)`,
				);
				md.push("");

				// Findings - synthesis.
				md.push("## Findings");
				const okSteps = steps.filter((s) => s.ok).map((s) => s.title);
				const failedSteps = steps.filter((s) => !s.ok);
				md.push(`- Steps completed: ${okSteps.length}/${steps.length}.`);
				if (failedSteps.length) {
					md.push(`- Steps failed: ${failedSteps.map((s) => s.title).join(", ")}.`);
				}
				md.push(`- Officers discovered: ${officerNames.length}.`);
				if (include_corporate) {
					const withMatches = corpResults.filter(
						(r) => r.outcome.matches.length > 0,
					).length;
					const pending = corpResults.some((r) => !r.outcome.available);
					md.push(
						`- Corporate enrichment: ${withMatches} of ${corpResults.length} top officer(s) matched${pending ? " (corporate_registry_search not yet deployed - enrichment pending)" : ""}.`,
					);
				}
				const activeFlags: string[] = [];
				if (sharedVins) activeFlags.push("shared VINs");
				if (coFilers) activeFlags.push("same-session co-filers");
				if (exposureHits) activeFlags.push("exposure signals");
				md.push(
					`- Silent-transfer indicators: ${activeFlags.length ? activeFlags.join(", ") : "none detected in available data"}.`,
				);
				md.push("");

				// Full per-step detail, so nothing is hidden behind the summary.
				md.push("## Detail");
				for (const s of steps) {
					md.push(`### ${s.title}`);
					if (!s.ok) {
						md.push(`_Step failed: ${s.error}_`, "");
						continue;
					}
					md.push(...renderValue(s.data, ""));
					md.push("");
				}

				return textResult(md.join("\n"));
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
