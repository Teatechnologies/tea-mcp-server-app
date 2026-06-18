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
