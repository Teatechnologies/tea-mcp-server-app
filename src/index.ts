import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration constants — easy to correct in one place.
//
// These names are intentionally surfaced here (rather than buried inline) so
// that the Supabase RPC name, its parameter name, and the response field names
// can be adjusted quickly once the real schema is confirmed.
// ---------------------------------------------------------------------------

// Supabase RPC that returns the TEA carrier vetting score.
// NOTE: placeholder name per request — confirm the real RPC name and update here.
const RPC_CARRIER_VETTING_SCORE = "carrier_vetting_score";

// Body parameter name passed to the RPC that carries the DOT number.
const RPC_PARAM_DOT_NUMBER = "dot_number";

// Candidate keys to look for the overall 0-100 score in the RPC response.
const SCORE_OVERALL_KEYS = [
	"overall_score",
	"overallScore",
	"score",
	"overall",
	"total_score",
	"tea_score",
];

// Candidate keys that may hold the per-category breakdown object/array.
const SCORE_CATEGORIES_KEYS = ["categories", "category_scores", "breakdown"];

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

/** Pick the first defined value among candidate keys on an object. */
function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
	for (const key of keys) {
		if (obj[key] !== undefined && obj[key] !== null) return obj[key];
	}
	return undefined;
}

/**
 * Call the Supabase TEA vetting-score RPC for a DOT number and return the
 * parsed JSON payload (object). Throws a friendly error on failure.
 */
async function fetchVettingScore(
	env: Cloudflare.Env,
	dotNumber: string,
): Promise<Record<string, unknown>> {
	const supabaseUrl = requireSecret(env.SUPABASE_URL, "SUPABASE_URL");
	const supabaseKey = requireSecret(env.SUPABASE_KEY, "SUPABASE_KEY");

	const url = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${RPC_CARRIER_VETTING_SCORE}`;

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: supabaseKey,
				Authorization: `Bearer ${supabaseKey}`,
			},
			body: JSON.stringify({ [RPC_PARAM_DOT_NUMBER]: dotNumber }),
		});
	} catch (e) {
		throw new Error(
			`Could not reach the TEA scoring service: ${(e as Error).message}`,
		);
	}

	const raw = await resp.text();
	if (!resp.ok) {
		throw new Error(
			`TEA scoring service returned ${resp.status} ${resp.statusText}: ${raw.slice(0, 300)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		throw new Error("TEA scoring service returned a response that was not valid JSON.");
	}

	// Supabase RPCs may return a scalar, an object, or a single-element array.
	if (Array.isArray(parsed)) parsed = parsed[0];
	if (parsed === null || parsed === undefined) {
		throw new Error(`No TEA score was found for DOT ${dotNumber}.`);
	}
	if (typeof parsed === "number") {
		return { [SCORE_OVERALL_KEYS[0]]: parsed };
	}
	if (typeof parsed !== "object") {
		return { [SCORE_OVERALL_KEYS[0]]: parsed };
	}
	return parsed as Record<string, unknown>;
}

/** Extract the overall 0-100 score from an RPC payload, if present. */
function extractOverallScore(payload: Record<string, unknown>): string {
	const score = pickFirst(payload, SCORE_OVERALL_KEYS);
	return score === undefined ? "N/A" : String(score);
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
		// Live FMCSA QCMobile identity/authority/OOS + TEA overall score.
		// -------------------------------------------------------------------
		this.server.registerTool(
			"lookup_carrier",
			{
				description:
					"Look up a motor carrier's live FMCSA identity, operating authority, MC number, and out-of-service status (from the QCMobile API), plus the TEA overall vetting score (0-100).",
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

				// --- TEA overall score (from Supabase) ---
				let teaScore = "N/A";
				try {
					const payload = await fetchVettingScore(env, dot_number);
					teaScore = extractOverallScore(payload);
				} catch (e) {
					teaScore = `Unavailable (${(e as Error).message})`;
				}

				const summary = [
					`Carrier: ${name}`,
					`DOT Number: ${dot}`,
					`MC Number: ${mc}`,
					`Authority Status: ${authority}`,
					`Out-of-Service Status: ${oosStatus}`,
					`TEA Overall Score (0-100): ${teaScore}`,
				].join("\n");

				return textResult(summary);
			},
		);

		// -------------------------------------------------------------------
		// Tool 2 — carrier_vetting_scorecard
		// TEA overall score plus the five category breakdowns.
		// -------------------------------------------------------------------
		this.server.registerTool(
			"carrier_vetting_scorecard",
			{
				description:
					"Return the TEA carrier vetting scorecard for a DOT number: the overall 0-100 score plus the category breakdowns.",
				inputSchema: {
					dot_number: z.string().describe("USDOT number of the carrier (required)."),
				},
			},
			async ({ dot_number }) => {
				const env = this.env as Cloudflare.Env;

				let payload: Record<string, unknown>;
				try {
					payload = await fetchVettingScore(env, dot_number);
				} catch (e) {
					return errorResult((e as Error).message);
				}

				const overall = extractOverallScore(payload);

				// Find the category breakdown — either under a known key, or by
				// treating remaining object/numeric fields as categories.
				let categories = pickFirst(payload, SCORE_CATEGORIES_KEYS) as
					| Record<string, unknown>
					| unknown[]
					| undefined;

				if (categories === undefined) {
					const rest: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(payload)) {
						if (SCORE_OVERALL_KEYS.includes(k)) continue;
						rest[k] = v;
					}
					if (Object.keys(rest).length > 0) categories = rest;
				}

				const lines: string[] = [
					`TEA Carrier Vetting Scorecard — DOT ${dot_number}`,
					`Overall Score (0-100): ${overall}`,
					"",
					"Category Breakdown:",
				];

				if (Array.isArray(categories)) {
					for (const item of categories) {
						if (item && typeof item === "object") {
							const o = item as Record<string, unknown>;
							const label = o.name ?? o.category ?? o.label ?? "Category";
							const value = o.score ?? o.value ?? o.points ?? JSON.stringify(o);
							lines.push(`  - ${label}: ${value}`);
						} else {
							lines.push(`  - ${item}`);
						}
					}
				} else if (categories && typeof categories === "object") {
					for (const [k, v] of Object.entries(categories)) {
						const value =
							v && typeof v === "object" ? JSON.stringify(v) : String(v);
						lines.push(`  - ${k}: ${value}`);
					}
				} else {
					lines.push("  (No category breakdown was returned.)");
				}

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
