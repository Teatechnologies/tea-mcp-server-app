// Sign-in for the OAuth-protected MCP route (/sso/mcp).
//
// The Worker is its own OAuth authorization server (workers-oauth-provider, with dynamic
// client registration so claude.ai can connect). The user proves who they are with a
// Supabase email one-time code on their TEA / TruckVerifi account (same auth.users). On
// success the grant carries the user's id, email, API plan and a board-only TEA API key
// named "Claude MCP" (my_board_key_create: no API plan needed, limited to the board RPCs;
// created once and remembered in OAUTH_KV), which the Capacity Board tools send to the
// gateway so the RPCs run as that user.
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface SsoEnv {
	SUPABASE_URL: string;
	SUPABASE_ANON_KEY: string;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
}

export interface SsoProps extends Record<string, unknown> {
	viaSso: true;
	userId: string;
	email: string;
	/** From my_api_overview: "included" | "metered" | "none" | "suspended" | "unknown". */
	apiPlan: string;
	userApiKey?: string;
}

const KEY_NAME = "Claude MCP";
const OTP_LENGTH = 8;

/* ------------------------------ tiny helpers ------------------------------ */

const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dec = <T>(s: string): T | null => {
	try {
		const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
		return JSON.parse(atob(b64)) as T;
	} catch {
		return null;
	}
};

function page(title: string, body: string, status = 200): Response {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · TEA Highway Intelligence</title>
<style>
body{margin:0;background:#0b1220;color:#e6edf3;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:420px;margin:8vh auto;padding:32px 28px;background:#111a2b;border:1px solid #22304a;border-radius:14px}
h1{font-size:20px;margin:0 0 4px}p{margin:8px 0;color:#aab6c8}small{color:#7d8aa0}
label{display:block;margin:18px 0 6px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #2b3a55;border-radius:8px;background:#0b1220;color:#fff;font-size:16px}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.err{margin-top:14px;padding:10px 12px;border-radius:8px;background:#3b1d24;color:#ffb4c0}
a{color:#8ab4ff}
</style></head><body><main>${body}</main></body></html>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
	);
}

async function supabaseAuth(env: SsoEnv, path: string, body: unknown, token?: string) {
	const resp = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/${path}`, {
		method: "POST",
		headers: {
			apikey: env.SUPABASE_ANON_KEY,
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	let json: Record<string, unknown> = {};
	try {
		json = (await resp.json()) as Record<string, unknown>;
	} catch {
		/* empty body */
	}
	return { ok: resp.ok, status: resp.status, json };
}

async function supabaseRpc(env: SsoEnv, token: string, fn: string, args: Record<string, unknown>): Promise<unknown> {
	const resp = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
		method: "POST",
		headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(args),
	});
	const text = await resp.text();
	let parsed: unknown = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = text;
	}
	if (!resp.ok) {
		const msg = parsed && typeof parsed === "object" ? String((parsed as Record<string, unknown>).message ?? text) : text;
		throw new Error(msg.slice(0, 200));
	}
	return parsed;
}

const authError = (json: Record<string, unknown>) =>
	String(json.msg ?? json.error_description ?? json.message ?? json.error ?? "Sign-in failed");

/* ------------------------------ pages ------------------------------ */

function emailForm(clientName: string, req: AuthRequest, error?: string, email = "") {
	return page(
		"Sign in",
		`<h1>Sign in to TEA</h1>
<p><strong>${esc(clientName)}</strong> wants to use your TEA / TruckVerifi account: your Capacity Boards and the carrier intelligence tools.</p>
<form method="post">
<input type="hidden" name="step" value="email"><input type="hidden" name="req" value="${esc(enc(req))}">
<label for="email">Account email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus value="${esc(email)}">
<button type="submit">Email me a sign-in code</button>
${error ? `<div class="err">${esc(error)}</div>` : ""}
</form>
<p><small>Same login as theteaintel.com and truckverifi.com. No password is entered here; we send a one-time code to your email.</small></p>`,
		error ? 400 : 200,
	);
}

function codeForm(clientName: string, req: AuthRequest, email: string, error?: string) {
	return page(
		"Enter code",
		`<h1>Check your email</h1>
<p>We sent an ${OTP_LENGTH}-digit code to <strong>${esc(email)}</strong>. Enter it to finish connecting <strong>${esc(clientName)}</strong>.</p>
<form method="post">
<input type="hidden" name="step" value="code"><input type="hidden" name="req" value="${esc(enc(req))}"><input type="hidden" name="email" value="${esc(email)}">
<label for="code">Sign-in code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" minlength="${OTP_LENGTH}" maxlength="${OTP_LENGTH}" required autofocus>
<button type="submit">Connect</button>
${error ? `<div class="err">${esc(error)}</div>` : ""}
</form>
<p><small>Didn't get it? Check spam, or <a href="javascript:history.back()">go back</a> and try again.</small></p>`,
		error ? 400 : 200,
	);
}

/* ------------------------------ key provisioning ------------------------------ */

/**
 * Find or create the user's "Claude MCP" self-serve key. Returns the key and the plan
 * from my_api_overview; the key is null when the account has no API plan.
 */
async function provisionKey(env: SsoEnv, userId: string, accessToken: string): Promise<{ key: string | null; plan: string }> {
	const kvKey = `mcpkey:${userId}`;
	let plan = "unknown";
	let overview: Record<string, unknown> | null = null;
	try {
		overview = (await supabaseRpc(env, accessToken, "my_api_overview", {})) as Record<string, unknown>;
		plan = String(overview?.plan ?? "unknown");
	} catch {
		/* overview unavailable: fall through with whatever is stored */
	}

	const stored = await env.OAUTH_KV.get(kvKey);
	if (stored) {
		// Still active on the account? (the overview lists previews, not keys)
		const preview = `${stored.slice(0, 12)}…${stored.slice(-4)}`;
		const keys = Array.isArray(overview?.keys) ? (overview!.keys as Record<string, unknown>[]) : null;
		const active = keys ? keys.some((k) => k.preview === preview && k.active) : true;
		if (active) return { key: stored, plan };
		await env.OAUTH_KV.delete(kvKey);
	}

	// A board-only key: any signed-in account can have one, so the plan does not gate it.
	try {
		const created = await supabaseRpc(env, accessToken, "my_board_key_create", { p_name: KEY_NAME });
		if (typeof created === "string" && created.startsWith("tea_")) {
			await env.OAUTH_KV.put(kvKey, created);
			return { key: created, plan };
		}
	} catch {
		/* e.g. key limit reached or account suspended; the tool explains */
	}
	return { key: null, plan };
}

/* ------------------------------ /authorize ------------------------------ */

export async function handleAuthorize(request: Request, env: SsoEnv): Promise<Response> {
	if (request.method === "GET") {
		let req: AuthRequest;
		try {
			req = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		} catch (e) {
			return page("Invalid request", `<h1>Invalid sign-in request</h1><p>${esc((e as Error).message)}</p>`, 400);
		}
		const client = await env.OAUTH_PROVIDER.lookupClient(req.clientId).catch(() => null);
		if (!client) return page("Unknown client", "<h1>Unknown client</h1><p>This app is not registered with the TEA MCP server.</p>", 400);
		return emailForm(client.clientName ?? "This app", req);
	}

	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

	const form = await request.formData();
	const req = dec<AuthRequest>(String(form.get("req") ?? ""));
	if (!req || !req.clientId || !req.redirectUri) return page("Invalid request", "<h1>Invalid sign-in request</h1><p>Start again from your MCP client.</p>", 400);
	const client = await env.OAUTH_PROVIDER.lookupClient(req.clientId).catch(() => null);
	if (!client || !client.redirectUris.includes(req.redirectUri)) {
		return page("Invalid request", "<h1>Invalid sign-in request</h1><p>The redirect address does not match the registered app.</p>", 400);
	}
	const clientName = client.clientName ?? "This app";
	const email = String(form.get("email") ?? "").trim().toLowerCase();
	const step = String(form.get("step") ?? "");

	if (step === "email") {
		if (!email) return emailForm(clientName, req, "Enter your account email.");
		const sent = await supabaseAuth(env, "otp", { email, create_user: false });
		if (!sent.ok) {
			const msg = /signups? not allowed/i.test(authError(sent.json))
				? "No TEA account uses that email. Sign up at https://www.theteaintel.com first."
				: authError(sent.json);
			return emailForm(clientName, req, msg, email);
		}
		return codeForm(clientName, req, email);
	}

	if (step === "code") {
		const code = String(form.get("code") ?? "").replace(/\D/g, "");
		if (!email || code.length !== OTP_LENGTH) return codeForm(clientName, req, email, `Enter the ${OTP_LENGTH}-digit code from the email.`);
		const verified = await supabaseAuth(env, "verify", { type: "email", email, token: code });
		const accessToken = String(verified.json.access_token ?? "");
		const user = verified.json.user as Record<string, unknown> | undefined;
		if (!verified.ok || !accessToken || !user?.id) {
			return codeForm(clientName, req, email, /expired|invalid/i.test(authError(verified.json)) ? "That code is wrong or has expired. Try again." : authError(verified.json));
		}
		const userId = String(user.id);
		const { key, plan } = await provisionKey(env, userId, accessToken);
		const props: SsoProps = { viaSso: true, userId, email: String(user.email ?? email), apiPlan: plan, userApiKey: key ?? undefined };
		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			request: req,
			userId,
			metadata: { email: props.email, plan },
			scope: req.scope,
			props,
		});
		return Response.redirect(redirectTo, 302);
	}

	return page("Invalid request", "<h1>Invalid sign-in request</h1><p>Start again from your MCP client.</p>", 400);
}
