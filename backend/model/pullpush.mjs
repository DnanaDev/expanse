const BASE_URL = "https://api.pullpush.io";

// PullPush.io is a Pushshift-compatible archive of Reddit data.
// Used as a fallback for items that Reddit no longer serves (deleted/removed content).

class PullPushClient {
	constructor() {
		this.last_request_at = 0;
	}

	_sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	async _get(path, params = {}) {
		// 1s minimum between requests — be polite to a free community service
		const wait = 1000 - (Date.now() - this.last_request_at);
		if (wait > 0) await this._sleep(wait);
		this.last_request_at = Date.now();

		const url = new URL(path, BASE_URL);
		for (const [k, v] of Object.entries(params)) {
			if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
		}

		const controller = new AbortController();
		const tid = setTimeout(() => controller.abort(), 60_000);
		try {
			const response = await fetch(url.toString(), {
				headers: { "Accept": "application/json" },
				signal: controller.signal
			});
			if (!response.ok) {
				const err = new Error(`PullPush ${response.status} on ${path}`);
				err.statusCode = response.status;
				throw err;
			}
			return response.json();
		} finally {
			clearTimeout(tid);
		}
	}

	// subreddit_name_prefixed may be absent on older archived items — reconstruct it.
	// PullPush stores user-profile subreddits as "u_username" in the subreddit field.
	_normalize_sub(item) {
		if (item.subreddit_name_prefixed) return item.subreddit_name_prefixed;
		if (!item.subreddit) return "r/unknown";
		return item.subreddit.startsWith("u_")
			? `u/${item.subreddit.slice(2)}`
			: `r/${item.subreddit}`;
	}

	async _fetch_chunk(endpoint, ids) {
		const response = await this._get(endpoint, { ids: ids.join(","), size: ids.length });
		return response.data || [];
	}

	async _fetch_all(endpoint, ids) {
		const results = [];
		for (let i = 0; i < ids.length; i += 100) {
			if (i > 0) await this._sleep(500);
			results.push(...await this._fetch_chunk(endpoint, ids.slice(i, i + 100)));
		}
		return results;
	}

	// ids: base36 IDs without "t3_" prefix. Returns [{kind:"t3", data:{...}}].
	async getSubmissions(ids) {
		if (!ids.length) return [];
		const items = await this._fetch_all("/reddit/search/submission/", ids);
		return items
			.filter(item => item.id) // guard: skip rows with no primary key
			.map(item => ({
				kind: "t3",
				data: {
					id: item.id,
					title: item.title || "[removed]",
					author: item.author || "[deleted]",
					subreddit_name_prefixed: this._normalize_sub(item),
					// permalink is occasionally absent in old archive entries — construct a
					// working fallback from the subreddit + id (Reddit URL format uses
					// "u_username" not "u/username" in the path, matching item.subreddit).
					permalink: item.permalink || `/r/${item.subreddit || "unknown"}/comments/${item.id}/`,
					created_utc: item.created_utc ?? 0,
					is_self: item.is_self,   // leave undefined for old archive entries; parse guards with === false/true
					url: item.url || null,
					selftext: item.selftext || null,
				}
			}));
	}

	// ids: base36 IDs without "t1_" prefix. Returns [{kind:"t1", data:{...}}].
	async getComments(ids) {
		if (!ids.length) return [];
		const items = await this._fetch_all("/reddit/search/comment/", ids);
		return items
			.filter(item => item.id)
			.map(item => {
				// PullPush provides link_id ("t3_postid") so we can reconstruct the URL.
				const post_id = item.link_id ? item.link_id.replace(/^t3_/, "") : null;
				const permalink = item.permalink
					|| (post_id
						? `/r/${item.subreddit || "unknown"}/comments/${post_id}/_/${item.id}/`
						: `/r/${item.subreddit || "unknown"}/comments/_/_/${item.id}/`);
				return {
					kind: "t1",
					data: {
						id: item.id,
						body: item.body || "[removed]",
						author: item.author || "[deleted]",
						subreddit_name_prefixed: this._normalize_sub(item),
						permalink,
						created_utc: item.created_utc ?? 0
					}
				};
			});
	}
}

const client = new PullPushClient();
export { client };
