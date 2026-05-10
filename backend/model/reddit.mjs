const BASE_URL = "https://www.reddit.com";

// Threshold below which we pause before sending another request.
// Reddit allows ~60 req/min; pausing at 10 remaining gives a safety buffer.
const RATELIMIT_PAUSE_THRESHOLD = 10;

class RedditClient {
	constructor(session_cookie) {
		this.session_cookie = session_cookie;
		this.ratelimit_remaining = 60;
		this.ratelimit_reset_at = Date.now() + 60_000; // ms timestamp of next window
	}

	_headers() {
		return {
			"User-Agent": `web:expanse:v=${process.env.VERSION} (by u/${process.env.REDDIT_USERNAME})`,
			"Cookie": `reddit_session=${this.session_cookie}`,
			"Accept": "application/json",
			"Accept-Language": "en-US,en;q=0.9",
		};
	}

	_sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// Blocks until the rate-limit window resets when we're running low.
	async _wait_if_rate_limited() {
		if (this.ratelimit_remaining <= RATELIMIT_PAUSE_THRESHOLD) {
			const wait_ms = Math.max(0, this.ratelimit_reset_at - Date.now()) + 500; // +500ms buffer
			if (wait_ms > 0) {
				console.log(`rate limit low (${Math.floor(this.ratelimit_remaining)} remaining), waiting ${Math.ceil(wait_ms / 1000)}s`);
				await this._sleep(wait_ms);
			}
		}
	}

	_update_ratelimit_headers(response) {
		const remaining = response.headers.get("x-ratelimit-remaining");
		const reset_secs = response.headers.get("x-ratelimit-reset");
		if (remaining !== null) this.ratelimit_remaining = parseFloat(remaining);
		// x-ratelimit-reset is seconds until window reset, not an epoch
		if (reset_secs !== null) this.ratelimit_reset_at = Date.now() + parseFloat(reset_secs) * 1000;
	}

	async _get(path, params = {}, retry = true) {
		await this._wait_if_rate_limited();

		const url = new URL(path, BASE_URL);
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
		}
		const response = await fetch(url.toString(), { headers: this._headers() });

		this._update_ratelimit_headers(response);

		if (response.status === 429) {
			// Respect Retry-After if provided, otherwise wait for the rate-limit window.
			const retry_after_secs = parseFloat(response.headers.get("retry-after") || "0");
			const wait_ms = retry_after_secs > 0
				? retry_after_secs * 1000
				: Math.max(0, this.ratelimit_reset_at - Date.now()) + 1000;
			console.log(`429 received on ${path}, retrying after ${Math.ceil(wait_ms / 1000)}s`);
			await this._sleep(wait_ms);
			if (retry) return this._get(path, params, false); // retry once
		}

		if (!response.ok) {
			const err = new Error(`Reddit API ${response.status} on ${path}`);
			err.statusCode = response.status;
			throw err;
		}

		return response.json();
	}

	async _post(path, body = {}) {
		await this._wait_if_rate_limited();

		const url = new URL(path, BASE_URL);
		const response = await fetch(url.toString(), {
			method: "POST",
			headers: { ...this._headers(), "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body).toString(),
		});

		this._update_ratelimit_headers(response);

		if (!response.ok) {
			const err = new Error(`Reddit API ${response.status} on ${path}`);
			err.statusCode = response.status;
			throw err;
		}
		return response.json();
	}

	// Returns the /api/me.json data object (includes .name and .modhash)
	async getMe() {
		const data = await this._get("/api/me.json", { raw_json: 1 });
		return data.data;
	}

	// Fetches all pages of a listing (optionally filtered by before= for incremental sync).
	// Returns array of raw child objects: [{kind, data}]
	// A short random jitter between pages avoids burst patterns on large initial syncs.
	async fetchListing(path, params = {}) {
		const all_items = [];
		const fetch_params = { limit: 100, raw_json: 1, ...params };
		let page = 0;

		while (true) {
			if (page > 0) {
				// 600–1200ms jitter between pages — looks more human, eases rate pressure
				await this._sleep(600 + Math.random() * 600);
			}

			const response = await this._get(path, fetch_params);
			const listing = response.data;
			const batch = listing.children;

			if (!batch.length) break;
			all_items.push(...batch);
			page++;

			if (!listing.after) break;
			fetch_params.after = listing.after;
		}

		return all_items;
	}

	// Fetches just the single most-recent item from a listing endpoint.
	async fetchLatest(path) {
		const response = await this._get(path, { limit: 1, raw_json: 1 });
		return response.data.children;
	}

	// Fetches items by their Reddit permalink, one request per item.
	// items: array of {fn_prefix, permalink} (rows from get_fns_to_import).
	// Returns [{kind, data}] in the same shape as getContentByIds.
	async getItemsByPermalinks(items) {
		const results = [];
		for (let i = 0; i < items.length; i++) {
			if (i > 0) await this._sleep(600 + Math.random() * 600);
			const { fn_prefix, permalink } = items[i];
			if (!permalink) continue;
			try {
				const path = permalink.replace(/\/$/, '') + '.json';
				const response = await this._get(path, { raw_json: 1 });
				// Posts (t3) are in response[0]; comments (t1) in response[1].
				const idx = fn_prefix === 't3' ? 0 : 1;
				const child = response[idx]?.data?.children?.[0];
				if (child) results.push(child);
			} catch (err) {
				console.error(`failed to fetch permalink ${permalink}: ${err.message}`);
			}
		}
		return results;
	}

	// sr_names_chunk: array of "r/subredditname" strings (max 100)
	async getSubredditInfo(sr_names_chunk) {
		const response = await this._get("/api/info.json", {
			sr_name: sr_names_chunk.join(","),
			raw_json: 1,
		});
		return response.data.children.map(c => c.data);
	}

	// username: bare username without "u/" prefix
	async getUserAbout(username) {
		const response = await this._get(`/user/${username}/about.json`, { raw_json: 1 });
		return response.data;
	}

	async unsave(fullname, modhash) {
		await this._post("/api/unsave", { id: fullname, uh: modhash });
	}

	async deleteItem(fullname, modhash) {
		await this._post("/api/del", { id: fullname, uh: modhash });
	}

	async unvote(fullname, modhash) {
		await this._post("/api/vote", { id: fullname, dir: "0", uh: modhash });
	}

	async unhide(fullname, modhash) {
		await this._post("/api/unhide", { id: fullname, uh: modhash });
	}
}

function create_requester(session_cookie) {
	return new RedditClient(session_cookie);
}

export { create_requester };
