import { fail } from "@sveltejs/kit";
import { insertFlight } from "$lib/db";
import { extractMetadata } from "$lib/igc";
import type { Actions, PageServerLoad } from "./$types";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — IGC files are small
const MAX_FILES = 500;

export const load: PageServerLoad = async ({ platform }) => {
	// Expose the public Turnstile site key (empty in dev → widget hidden).
	return { turnstileSiteKey: platform?.env?.TURNSTILE_SITEKEY ?? "" };
};

async function verifyTurnstile(
	secret: string,
	token: string,
	ip: string | null,
): Promise<boolean> {
	const body = new FormData();
	body.append("secret", secret);
	body.append("response", token);
	if (ip) body.append("remoteip", ip);
	const res = await fetch(
		"https://challenges.cloudflare.com/turnstile/v0/siteverify",
		{
			method: "POST",
			body,
		},
	);
	const data = (await res.json()) as { success: boolean };
	return data.success === true;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", buf);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

interface FileResult {
	name: string;
	status: "added" | "duplicate" | "error";
	id?: string;
	error?: string;
}

export const actions: Actions = {
	default: async ({ request, platform, getClientAddress }) => {
		if (!platform?.env) return fail(503, { error: "Storage unavailable." });
		const { DB_NAME: DB, BUCKET, TURNSTILE_SECRET } = platform.env;

		const form = await request.formData();

		// Spam check — only enforced when a secret is configured (skipped in dev).
		if (TURNSTILE_SECRET) {
			const token = String(form.get("cf-turnstile-response") ?? "");
			const ok =
				token &&
				(await verifyTurnstile(TURNSTILE_SECRET, token, getClientAddress()));
			if (!ok)
				return fail(400, {
					error: "Anti-spam check failed. Please try again.",
				});
		}

		const files = form
			.getAll("files")
			.filter((f): f is File => f instanceof File && f.size > 0);
		if (files.length === 0) return fail(400, { error: "No files selected." });
		if (files.length > MAX_FILES)
			return fail(400, { error: `Too many files (max ${MAX_FILES}).` });

		const now = Math.floor(Date.now() / 1000);
		const results: FileResult[] = [];

		for (const file of files) {
			try {
				if (file.size > MAX_FILE_BYTES) {
					results.push({
						name: file.name,
						status: "error",
						error: "File too large (max 5 MB).",
					});
					continue;
				}
				const buf = await file.arrayBuffer();
				const text = new TextDecoder().decode(buf);

				const parsed = extractMetadata(text);
				if (!parsed.ok) {
					results.push({
						name: file.name,
						status: "error",
						error: parsed.error,
					});
					continue;
				}

				const id = await sha256Hex(buf);
				await BUCKET.put(`${id}.igc`, buf, {
					httpMetadata: { contentType: "text/plain; charset=utf-8" },
				});
				const added = await insertFlight(DB, {
					id,
					...parsed.meta,
					size_bytes: file.size,
					uploaded_at: now,
				});
				results.push({
					name: file.name,
					status: added ? "added" : "duplicate",
					id,
				});
			} catch (e) {
				results.push({
					name: file.name,
					status: "error",
					error: (e as Error).message,
				});
			}
		}

		return { results };
	},
};
