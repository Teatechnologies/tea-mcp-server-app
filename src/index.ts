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

// Gateway RPC names (kept here so they are easy to correct in one place).
const RPC_INVESTIGATE_CARRIER = "investigate_carrier";
const RPC_INVESTIGATE_OFFICER = "investigate_officer";
const RPC_SAME_SESSION_FILINGS = "carrier_same_session_filings";
const RPC_EXPOSURE_SIGNALS = "carrier_exposure_signals";

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
		throw new Error(
			`Could not reach the TEA gateway (${rpcName}): ${(e as Error).message}`,
		);
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
						.describe("Optional MC/docket number, used as a fallback if FMCSA does not return one."),
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
						return errorResult("FMCSA QCMobile returned a response that was not valid JSON.");
					}
					// QCMobile shape: { content: { carrier: {...} } | [{ carrier: {...} }] }
					const content = (parsed as Record<string, unknown> | null)?.content;
					if (Array.isArray(content)) {
						carrier = (content[0] as Record<string, unknown>)?.carrier as Record<string, unknown> ?? {};
					} else if (content && typeof content === "object") {
						const c = (content as Record<string, unknown>).carrier;
						carrier = (c as Record<string, unknown>) ?? (content as Record<string, unknown>);
					}
					if (!carrier || Object.keys(carrier).length === 0) {
						return errorResult(`No FMCSA carrier record found for DOT ${dot_number}.`);
					}
				} catch (e) {
					return errorResult((e as Error).message);
				}

				// --- Extract readable fields defensively ---
				const name =
					(carrier.legalName as string) ||
					(carrier.dbaName as string) ||
					"Unknown";
				const dot = (carrier.dotNumber as string | number) ?? dot_number;
				const mc =
					(carrier.docketNumber as string) ||
					mc_number ||
					"Not reported by FMCSA";
				const allowed = carrier.allowedToOperate;
				const authority =
					allowed === "Y"
						? "Authorized to operate"
						: allowed === "N"
							? "NOT authorized to operate"
							: "Unknown";
				const oosDate =
					(carrier.oosDate as string) || (carrier.outOfServiceDate as string);
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
				const consumed = new Set<string>([compositeKey, tierKey].filter(Boolean) as string[]);
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
					data = await callGateway(env, RPC_INVESTIGATE_CARRIER, { seed_dot: dot_number });
				} catch (e) {
					return errorResult((e as Error).message);
				}
				const lines: string[] = [`Carrier Network — DOT ${dot_number}`, ""];
				lines.push(...renderValue(data, ""));
				// TEMPORARY: confirm shape, then remove.
				lines.push("", `DEBUG data (first 800 chars): ${JSON.stringify(data).slice(0, 800)}`);
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
					officer_name: z.string().describe("Company officer name to search for (required)."),
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
				// TEMPORARY: confirm shape, then remove.
				lines.push("", `DEBUG data (first 800 chars): ${JSON.stringify(data).slice(0, 800)}`);
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
				// TEMPORARY: confirm shape, then remove.
				lines.push("", `DEBUG data (first 800 chars): ${JSON.stringify(data).slice(0, 800)}`);
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
				// TEMPORARY: confirm shape, then remove.
				lines.push("", `DEBUG data (first 800 chars): ${JSON.stringify(data).slice(0, 800)}`);
				return textResult(lines.join("\n"));
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
