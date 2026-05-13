const backend = process.cwd();

const sql = await import(`${backend}/model/sql.mjs`);
const reddit = await import(`${backend}/model/reddit.mjs`);
const pullpush = await import(`${backend}/model/pullpush.mjs`);
const cryptr = await import(`${backend}/model/cryptr.mjs`);
const logger = await import(`${backend}/model/logger.mjs`);
const utils = await import(`${backend}/model/utils.mjs`);

let update_all_completed = null;

const usernames_to_socket_ids = {};
const socket_ids_to_usernames = {};

class User {
	constructor(username, session_cookie, dummy=false, token_v2=null) {
		this.username = username;

		if (dummy) {
			null;
		} else {
			this.reddit_api_refresh_token_encrypted = cryptr.encrypt(session_cookie);
			this.token_v2_encrypted = token_v2 ? cryptr.encrypt(token_v2) : null;
			this.category_sync_info = {
				saved: {
					latest_fn_mixed: null,
					latest_new_data_epoch: null
				},
				created: {
					latest_fn_posts: null,
					latest_fn_comments: null,
					latest_new_data_epoch: null
				},
				upvoted: {
					latest_fn_posts: null,
					latest_new_data_epoch: null
				},
				downvoted: {
					latest_fn_posts: null,
					latest_new_data_epoch: null
				},
				hidden: {
					latest_fn_posts: null,
					latest_new_data_epoch: null
				}
			};
			this.last_updated_epoch = null;
			this.last_active_epoch = utils.now_epoch();
		}
	}
	async save() {
		let user_for_comparison = null;
		try {
			user_for_comparison = await get(this.username, true);
		} catch (err) {
			if (err != `Error: user (${this.username}) dne`) {
				console.error(err);
				logger.error(err);
				return;
			}
		}

		if (!user_for_comparison || !user_for_comparison.last_updated_epoch) {
			console.log(`new user (${this.username})`);

			await sql.save_user(this.username, this.reddit_api_refresh_token_encrypted, this.token_v2_encrypted, this.category_sync_info, this.last_active_epoch);
		} else {
			console.log(`returning user (${this.username})`);

			const update_fields = { reddit_api_refresh_token_encrypted: this.reddit_api_refresh_token_encrypted };
			if (this.token_v2_encrypted !== null) update_fields.token_v2_encrypted = this.token_v2_encrypted;
			await sql.update_user(this.username, update_fields);
		}

		console.log(`saved user (${this.username})`);
	}

	// Maps category+type to the Reddit JSON API listing endpoint path.
	_category_endpoint(category, type) {
		switch (category) {
			case "saved":    return `/user/${this.username}/saved.json`;
			case "upvoted":  return `/user/${this.username}/upvoted.json`;
			case "downvoted": return `/user/${this.username}/downvoted.json`;
			case "hidden":   return `/user/${this.username}/hidden.json`;
			case "created":
				return (type === "posts")
					? `/user/${this.username}/submitted.json`
					: `/user/${this.username}/comments.json`;
			default:
				throw new Error(`unknown category: ${category}`);
		}
	}

	// Returns all new items since since_fn as [{kind, data}]. If since_fn is null,
	// fetches the entire listing (used on first sync).
	async get_listing(since_fn, category, type) {
		const endpoint = this._category_endpoint(category, type);
		const params = {};
		if (since_fn) params.before = since_fn;
		return this.requester.fetchListing(endpoint, params);
	}

	// items: [{kind, data}] array from the JSON API
	parse_listing(items, category, type, from_mixed=false, from_import=false) {
		if (type == "mixed") {
			if (!from_import && items.length > 0) {
				this.category_sync_info[category].latest_fn_mixed = items[0].data.name;
			}

			const posts    = items.filter(i => i.kind === "t3");
			const comments = items.filter(i => i.kind === "t1");

			this.parse_listing(posts,    category, "posts",    true, from_import);
			this.parse_listing(comments, category, "comments", true, from_import);
		} else {
			if (!from_mixed && !from_import && items.length > 0) {
				this.category_sync_info[category][`latest_fn_${type}`] = items[0].data.name;
			}

			const PLACEHOLDERS = new Set(["[removed]", "[deleted]"]);
			for (const item of items) {
				const d = item.data;
				const content = type == "posts" ? d.title : d.body;
				this.new_data.items[d.id] = {
					type: (type == "posts" ? "post" : "comment"),
					content,
					author: `u/${d.author}`,
					sub: d.subreddit_name_prefixed,
					url: `https://www.reddit.com${utils.strip_trailing_slash(d.permalink)}`,
					created_epoch: d.created_utc,
					source: 'reddit'
				};

				this.new_data.category_item_ids[category].add(d.id);
				this.sub_icon_urls_to_get.add(d.subreddit_name_prefixed);

				// Queue items with placeholder content for PullPush recovery next import cycle.
				if (!from_import && this.placeholder_fns && PLACEHOLDERS.has(content)) {
					this.placeholder_fns.set(d.id, {
						fn_prefix: type == "posts" ? "t3" : "t1",
						permalink: d.permalink ?? null
					});
				}
			}
		}
	}

	async replace_latest_fn(category, type) {
		const endpoint = this._category_endpoint(category, type);
		const items = await this.requester.fetchLatest(endpoint);
		const latest_fn = (items.length != 0 ? items[0].data.name : null);
		this.category_sync_info[category][`latest_fn_${type}`] = latest_fn;
	}

	async sync_category(category, type) {
		const since_fn = this.category_sync_info[category][`latest_fn_${type}`];
		const items = await this.get_listing(since_fn, category, type);

		if (items.length === 0) {
			// Either listing is empty, or the item we tracked was deleted on Reddit.
			await this.replace_latest_fn(category, type);
		} else {
			this.parse_listing(items, category, type);
			this.category_sync_info[category].latest_new_data_epoch = utils.now_epoch();
		}
	}

	async import_category(category, type) {
		const rows = await sql.get_fns_to_import(this.username, category);
		if (rows.length > 0) {
			console.log(`importing (${rows.length}) (${category}) items`);

			const items = await this.requester.getItemsByPermalinks(rows);
			this.parse_listing(items, category, type, false, true);

			for (const row of rows) {
				this.imported_fns_to_delete.add(`${row.fn_prefix}_${row.id}`);
			}
		}
	}

	async request_item_icon_urls(type, subs) {
		switch (type) {
			case "r/": {
				const chunks = [];
				for (let i = 0; i < subs.length && chunks.length < this.requester.ratelimit_remaining; i += 100) {
					chunks.push(subs.slice(i, i + 100));
				}
				if (chunks.length < Math.ceil(subs.length / 100)) {
					console.log(`user (${this.username}) ratelimit reached`);
				}

				const results = await Promise.all(chunks.map(chunk => this.requester.getSubredditInfo(chunk)));
				for (const listing of results) {
					for (const sub of listing) {
						const sub_name = sub.display_name_prefixed;
						let sub_icon_url = "#";
						if (sub.icon_img) {
							sub_icon_url = sub.icon_img.split("?")[0];
						} else if (sub.community_icon) {
							sub_icon_url = sub.community_icon.split("?")[0];
						}
						this.new_data.item_sub_icon_urls[sub_name] = sub_icon_url;
					}
				}
				break;
			}
			case "u/": {
				const limit = Math.min(subs.length, this.requester.ratelimit_remaining);
				if (limit < subs.length) {
					console.log(`user (${this.username}) ratelimit reached`);
				}

				const results = await Promise.all(
					subs.slice(0, limit).map(s => this.requester.getUserAbout(s.slice(2))) // strip "u/" prefix
				);
				for (const sub of results) {
					const sub_name = `u/${sub.name}`;
					let sub_icon_url = "#";
					if (sub.icon_img) {
						sub_icon_url = sub.icon_img.split("?")[0];
					} else if (sub.snoovatar_img) {
						sub_icon_url = sub.snoovatar_img.split("?")[0];
					} else if (sub.community_icon) {
						sub_icon_url = sub.community_icon.split("?")[0];
					} else if (sub.subreddit?.icon_img) {
						sub_icon_url = sub.subreddit.icon_img.split("?")[0];
					}
					this.new_data.item_sub_icon_urls[sub_name] = sub_icon_url;
				}
				break;
			}
			default:
				break;
		}
	}

	async get_new_item_icon_urls() {
		let r_subs = [];
		let u_subs = [];

		for (const sub of this.sub_icon_urls_to_get) {
			if (sub.startsWith("r/")) {
				r_subs.push(sub);
			} else if (sub.startsWith("u/")) {
				u_subs.push(sub);
			}
		}

		(r_subs.length != 0 ? await this.request_item_icon_urls("r/", r_subs) : null);
		(u_subs.length != 0 ? await this.request_item_icon_urls("u/", u_subs) : null);
	}

	async update(io=null, socket_id=null) {
		console.log(`updating user (${this.username})`);

		let progress = (io ? 0 : null);
		const complete = (io ? 7 : null);

		const session_cookie = cryptr.decrypt(this.reddit_api_refresh_token_encrypted);
		let current_token_v2 = this.token_v2_encrypted ? cryptr.decrypt(this.token_v2_encrypted) : null;
		const token_exp = utils.jwt_exp_secs(current_token_v2);

		if (!token_exp || token_exp - utils.now_epoch() < 7200) {
			try {
				// Pass current_token_v2 (even if expired) — Reddit only issues a new
				// token_v2 when the existing one is present in the cookie, mirroring
				// what a real browser does on every authenticated request.
				const seed = reddit.create_requester(session_cookie, current_token_v2);
				const fresh = await seed.refreshToken_v2();
				if (fresh) {
					current_token_v2 = fresh;
					this.token_v2_encrypted = cryptr.encrypt(fresh);
					await sql.update_user(this.username, { token_v2_encrypted: this.token_v2_encrypted });
					console.log(`user (${this.username}): token_v2 refreshed successfully`);
				} else {
					console.warn(`user (${this.username}): token_v2 refresh returned nothing`);
				}
			} catch (err) {
				console.error(`token_v2 refresh failed for user (${this.username}): ${err.message}`);
			}
		}

		// Compute detailed token status after refresh attempt and store for socket emission.
		{
			const now = utils.now_epoch();
			const payload = current_token_v2 ? utils.jwt_payload(current_token_v2) : null;
			const exp = payload?.exp ?? null;
			const iat = payload?.iat ?? null;
			const issued_str = iat ? ` (issued ${utils.format_duration(now - iat)} ago)` : '';

			if (!current_token_v2) {
				this.token_v2_status = { status: 'missing', message: 'token_v2 missing — upvoted/downvoted sync will fail. Re-login and provide the token_v2 cookie.' };
				console.warn(`[WARNING] user (${this.username}): ${this.token_v2_status.message}`);
			} else if (exp && exp < now) {
				this.token_v2_status = { status: 'expired', message: `token_v2 expired ${utils.format_duration(now - exp)} ago${issued_str} — upvoted/downvoted sync may fail. Re-login to refresh.` };
				console.warn(`[WARNING] user (${this.username}): ${this.token_v2_status.message}`);
			} else if (exp && exp - now < 7200) {
				this.token_v2_status = { status: 'expiring_soon', message: `token_v2 expires in ${utils.format_duration(exp - now)}${issued_str} — re-login soon to maintain upvoted/downvoted sync.` };
				console.warn(`[WARNING] user (${this.username}): ${this.token_v2_status.message}`);
			} else {
				const remaining = exp ? utils.format_duration(exp - now) : 'unknown expiry';
				this.token_v2_status = { status: 'ok' };
				console.log(`user (${this.username}): token_v2 ok — expires in ${remaining}${issued_str}`);
			}
		}

		this.requester = reddit.create_requester(session_cookie, current_token_v2);

		this.new_data = {
			items: {},
			category_item_ids: {},
			item_sub_icon_urls: {}
		};
		this.sub_icon_urls_to_get = new Set();
		this.imported_fns_to_delete = new Set();
		this.placeholder_fns = new Map(); // id → {fn_prefix, permalink} for items stored with placeholder content

		const categories = ["saved", "created", "upvoted", "downvoted", "hidden"];
		for (const category of categories) {
			this.new_data.category_item_ids[category] = new Set();
		}

		// Run categories sequentially to avoid bursting all 6 at once against Reddit's rate limit.
		// Each failure is tagged with its category so update_all can recover the cursor.
		const run = async (category, fn) => {
			try {
				await fn();
				(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
			} catch (err) {
				err.extras = { category };
				throw err;
			}
		};

		await run("saved", async () => {
			await this.sync_category("saved", "mixed");
		});
		await run("created", async () => {
			await this.sync_category("created", "posts");
			await this.sync_category("created", "comments");
		});
		await run("upvoted", async () => {
			await this.sync_category("upvoted", "posts");
		});
		await run("downvoted", async () => {
			await this.sync_category("downvoted", "posts");
		});
		await run("hidden", async () => {
			await this.sync_category("hidden", "posts");
		});
		await this.get_new_item_icon_urls().catch((err) => {
			console.error(`icon url fetch failed for user (${this.username}): ${err.message}`);
		});

		try {
			await sql.insert_data(this.username, this.new_data);
			await sql.delete_imported_fns([...(this.imported_fns_to_delete)]);
			if (this.placeholder_fns.size) {
				const to_enqueue = [...this.placeholder_fns.entries()].map(([id, { fn_prefix, permalink }]) => ({ id, fn_prefix, permalink }));
				await sql.enqueue_for_import(to_enqueue);
				console.log(`queued ${to_enqueue.length} placeholder items for PullPush retry (${this.username})`);
			}
			(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
		} catch (err) {
			console.error(err);
			logger.error(`user (${this.username}) db update error (${err})`);
			return;
		}

		await sql.update_user(this.username, {
			category_sync_info: JSON.stringify(this.category_sync_info),
			last_updated_epoch: this.last_updated_epoch = utils.now_epoch()
		});
		(io ? io.to(socket_id).emit("update progress", ++progress, complete) : null);
		console.log(`updated user (${this.username})`);

		delete this.new_data;
		delete this.sub_icon_urls_to_get;
		delete this.imported_fns_to_delete;
		delete this.placeholder_fns;
	}

	async renew_comment(comment_id) {
		const requester = reddit.create_requester(
			cryptr.decrypt(this.reddit_api_refresh_token_encrypted),
			this.token_v2_encrypted ? cryptr.decrypt(this.token_v2_encrypted) : null
		);
		const items = await requester.getContentByIds([`t1_${comment_id}`]);
		if (!items.length) throw new Error(`comment ${comment_id} not found`);
		const comment_content = items[0].data.body;
		if (comment_content === "[removed]" || comment_content === "[deleted]") {
			throw new Error("comment no longer available on Reddit — archived content preserved");
		}
		sql.update_item(comment_id, comment_content).catch((err) => console.error(err));
		return comment_content;
	}

	async delete_item_from_reddit_acc(item_id, item_category, item_type) {
		const requester = reddit.create_requester(
			cryptr.decrypt(this.reddit_api_refresh_token_encrypted),
			this.token_v2_encrypted ? cryptr.decrypt(this.token_v2_encrypted) : null
		);
		const me = await requester.getMe();
		const modhash = me.modhash;

		const item_fn = `${item_type === "post" ? "t3" : "t1"}_${item_id}`;

		let replace_latest_fn = false;
		if (item_category == "saved") {
			replace_latest_fn = (item_fn == this.category_sync_info.saved.latest_fn_mixed);
		} else {
			replace_latest_fn = (item_fn == this.category_sync_info[item_category][`latest_fn_${item_type}s`]);
		}

		switch (item_category) {
			case "saved":
				await requester.unsave(item_fn, modhash);
				break;
			case "created":
				await requester.deleteItem(item_fn, modhash);
				break;
			case "upvoted":
			case "downvoted":
				await requester.unvote(item_fn, modhash);
				break;
			case "hidden":
				await requester.unhide(item_fn, modhash);
				break;
			default:
				break;
		}

		if (replace_latest_fn) {
			const saved_requester = this.requester;
			this.requester = requester;
			await this.replace_latest_fn(item_category, (item_category == "saved" ? "mixed" : `${item_type}s`));
			this.requester = saved_requester;
			await sql.update_user(this.username, {
				category_sync_info: JSON.stringify(this.category_sync_info)
			});
		}
	}

	async purge() {
		await sql.purge_user(this.username);
		delete usernames_to_socket_ids[this.username];
		console.log(`purged user (${this.username})`);
	}
}

async function fill_usernames_to_socket_ids() {
	const rows = await sql.get_all_non_purged_users();
	for (const row of rows) {
		usernames_to_socket_ids[row.username] = null;
	}
}

async function get(username, existence_check=false) {
	(existence_check ? console.log(`checking if user (${username}) exists`) : console.log(`getting user (${username})`));

	const result = await sql.get_user(username);
	if (result == undefined) {
		throw new Error(`user (${username}) dne`);
	} else {
		const plain_object = result;
		(plain_object.last_updated_epoch ? plain_object.last_updated_epoch = Number.parseInt(plain_object.last_updated_epoch) : null);
		plain_object.last_active_epoch = Number.parseInt(plain_object.last_active_epoch);

		const u = Object.assign(new User(null, null, true), plain_object);
		return u;
	}
}

// Tracks consecutive PullPush failures across all users/categories.
// After PP_FAILURE_THRESHOLD failures in a row, items are stamped with a short
// backoff (PP_FAILURE_BACKOFF_SECS) so they stop retrying every cycle during an
// outage, but are tried again well before the normal 7-day window.
let pp_consecutive_failures = 0;
const PP_FAILURE_THRESHOLD  = 3;
const PP_FAILURE_BACKOFF_SECS = 3600; // 1 hour

// Processes the CSV import queue for one user, completely independent of the
// sync cycle. Has its own requester and data structures so it never blocks update_all.
async function import_pending(username) {
	let u;
	try {
		u = await get(username);
	} catch (err) {
		return;
	}

	const session_cookie = cryptr.decrypt(u.reddit_api_refresh_token_encrypted);
	const token_v2 = u.token_v2_encrypted ? cryptr.decrypt(u.token_v2_encrypted) : null;
	const requester = reddit.create_requester(session_cookie, token_v2);

	// Drop items that have been missed by both Reddit and PullPush too many times —
	// they are gone from both sources and will never resolve.
	const MAX_FETCH_MISSES = 5;
	const hopeless = await sql.retire_hopeless_fns(MAX_FETCH_MISSES);
	if (hopeless.length) console.log(`retired ${hopeless.length} items to unresolvable archive after ${MAX_FETCH_MISSES} misses on both Reddit and PullPush`);

	const category_types = [
		{ category: "saved",    type: "mixed" },
		{ category: "created",  type: "mixed" },
		{ category: "upvoted",  type: "posts" },
		{ category: "downvoted", type: "posts" },
		{ category: "hidden",   type: "posts" },
	];

	for (const { category, type } of category_types) {
		try {
			const rows = await sql.get_fns_to_import(username, category);
			if (!rows.length) continue;

			// Bulk-check which IDs are already stored. Items in the DB with placeholder
			// content ([removed]/[deleted]) are treated as not-have so PullPush gets a
			// chance to recover the original content.
			const existing_ids = await sql.get_existing_item_ids(rows.map(r => r.id));
			const placeholder_ids = await sql.get_placeholder_item_ids([...existing_ids]);

			const already_have = rows.filter(r => existing_ids.has(r.id) && !placeholder_ids.has(r.id));
			const need_to_fetch = rows.filter(r => !existing_ids.has(r.id) || placeholder_ids.has(r.id));

			if (already_have.length) {
				await sql.delete_imported_fns(already_have.map(r => `${r.fn_prefix}_${r.id}`));
			}

			if (!need_to_fetch.length) continue;

			const truly_new = need_to_fetch.filter(r => !placeholder_ids.has(r.id)).length;
			const recovering = placeholder_ids.size;
			const fetch_desc = [
				truly_new  ? `${truly_new} new`         : null,
				recovering ? `${recovering} recovering`  : null
			].filter(Boolean).join(", ");
			console.log(`importing (${fetch_desc}) (${category}) items for user (${username})`);
			const all_reddit_results = await requester.getContentByIdsBatched(need_to_fetch.map(r => `${r.fn_prefix}_${r.id}`));

			// Drop Reddit responses where the content is a placeholder — the author or mods
			// removed it after archival. Treat these as not-found so PullPush gets a chance
			// to serve the original. ON CONFLICT DO NOTHING protects already-stored items,
			// but this guard is critical for items being inserted for the first time.
			const reddit_placeholders = new Set(["[removed]", "[deleted]"]);
			const fetched = all_reddit_results.filter(c =>
				!reddit_placeholders.has(c.kind === "t3" ? c.data.title : c.data.body)
			);

			// PullPush fallback for items Reddit didn't return (deleted/removed content).
			// Capped at 50 per cycle — remaining items stay queued and are tried next cycle.
			const fetched_ids = new Set(fetched.map(c => c.data.id));
			const not_on_reddit = need_to_fetch.filter(r => !fetched_ids.has(r.id));
			console.log(`Reddit returned ${fetched.length}/${need_to_fetch.length} (${category}) items for user (${username})`);
			const pp_ids = new Set();
			if (not_on_reddit.length) {
				const pp_candidates = not_on_reddit.sort(() => Math.random() - 0.5).slice(0, 50);
				const pp_post_ids    = pp_candidates.filter(r => r.fn_prefix === "t3").map(r => r.id);
				const pp_comment_ids = pp_candidates.filter(r => r.fn_prefix === "t1").map(r => r.id);
				console.log(`${not_on_reddit.length} not on Reddit — fetching ${pp_candidates.length} from PullPush this cycle (${not_on_reddit.length - pp_candidates.length} deferred) for user (${username})`);
				try {
					const pp_posts    = pp_post_ids.length    ? await pullpush.client.getSubmissions(pp_post_ids)   : [];
					const pp_comments = pp_comment_ids.length ? await pullpush.client.getComments(pp_comment_ids)  : [];
					for (const c of [...pp_posts, ...pp_comments]) pp_ids.add(c.data.id);
					fetched.push(...pp_posts, ...pp_comments);

					// saved/created hold both posts and comments. Ghost items re-queued
					// without a known prefix default to t3 — if the submission endpoint
					// returns nothing for them, try the comment endpoint before stamping.
					if ((category === "saved" || category === "created") && pp_post_ids.length) {
						const submission_misses = pp_post_ids.filter(id => !pp_ids.has(id));
						if (submission_misses.length) {
							const pp_fallback = await pullpush.client.getComments(submission_misses);
							for (const c of pp_fallback) {
								pp_ids.add(c.data.id);
								fetched.push(c);
							}
						}
					}

					// PullPush was reachable — stamp items it didn't return so they aren't
					// retried for 7 days. Items that do come back are cleared via to_clear below.
					const missed = pp_candidates.filter(r => !pp_ids.has(r.id));
					if (missed.length) {
						await sql.stamp_fetch_attempt(missed.map(r => r.id));
						console.log(`PullPush miss for (${missed.length}) items — will retry in 7 days`);
					}
					pp_consecutive_failures = 0;
				} catch (err) {
					pp_consecutive_failures++;
					if (pp_consecutive_failures >= PP_FAILURE_THRESHOLD) {
						// PullPush has been down for multiple cycles — apply a short backoff so
						// items stop retrying every cycle and resume automatically when it recovers.
						const backoff_epoch = Math.floor(Date.now() / 1000) - 604800 + PP_FAILURE_BACKOFF_SECS;
						await sql.stamp_fetch_attempt(pp_candidates.map(r => r.id), backoff_epoch, false);
						console.error(`PullPush down for ${pp_consecutive_failures} consecutive cycles — stamping ${pp_candidates.length} items with 1h backoff (${err.message})`);
					} else {
						console.error(`PullPush fetch failed for user (${username}): ${err.message} — ${pp_candidates.length} items will retry next cycle`);
					}
				}
			}

			const batch = {
				items: {},
				category_item_ids: { saved: new Set(), created: new Set(), upvoted: new Set(), downvoted: new Set(), hidden: new Set() },
				item_sub_icon_urls: {}
			};

			const parse = (children, item_type) => {
				for (const child of children) {
					const d = child.data;
					batch.items[d.id] = {
						type: item_type,
						content: item_type === "post" ? d.title : d.body,
						author: `u/${d.author}`,
						sub: d.subreddit_name_prefixed,
						url: `https://www.reddit.com${utils.strip_trailing_slash(d.permalink)}`,
						created_epoch: d.created_utc,
						source: pp_ids.has(d.id) ? 'pullpush' : 'reddit'
					};
					batch.category_item_ids[category].add(d.id);
				}
			};

			if (type === "mixed") {
				parse(fetched.filter(c => c.kind === "t3"), "post");
				parse(fetched.filter(c => c.kind === "t1"), "comment");
			} else {
				parse(fetched, "post");
			}

			await sql.insert_data(username, batch);

			// For items that were stored as placeholders and now have real content,
			// ON CONFLICT DO NOTHING skips the insert — update them explicitly.
			const overwrites = need_to_fetch.filter(r => placeholder_ids.has(r.id) && batch.items[r.id]);
			for (const row of overwrites) {
				const item = batch.items[row.id];
				await sql.update_item_from_source(row.id, item.content, item.author, item.source);
			}
			if (overwrites.length) console.log(`recovered content for ${overwrites.length} placeholder items (${username})`);

			// Only clear queue entries for items that were actually resolved.
			// Items not found by Reddit or PullPush stay in the queue and retry next cycle.
			const resolved_ids = new Set(Object.keys(batch.items));
			const to_clear = need_to_fetch.filter(r => resolved_ids.has(r.id));
			if (to_clear.length) {
				await sql.delete_imported_fns(to_clear.map(r => `${r.fn_prefix}_${r.id}`));
			}
		} catch (err) {
			console.error(`import error for user (${username}) category (${category}): ${err.message}`);
		}
	}
}

let import_bg_running = false;

async function import_all_bg() {
	if (import_bg_running) return;
	import_bg_running = true;
	console.log("import all started");
	for (const username of Object.keys(usernames_to_socket_ids)) {
		try {
			await import_pending(username);
		} catch (err) {
			console.error(err);
		}
	}
	import_bg_running = false;
	console.log("import all completed");
}

async function update_all(io) {
	console.log("update all started");
	update_all_completed = false;

	const all_usernames = Object.keys(usernames_to_socket_ids);
	for (const username of all_usernames) {
		let u = null;
		try {
			u = await get(username);

			if (u.last_updated_epoch && utils.now_epoch() - u.last_updated_epoch >= 30) {
				const pre_update_category_sync_info = JSON.parse(JSON.stringify(u.category_sync_info));

				await u.update();

				const post_update_category_sync_info = u.category_sync_info;

				const socket_id = usernames_to_socket_ids[u.username];
				if (socket_id) {
					const categories_w_new_data = [];
					for (const category in u.category_sync_info) {
						(post_update_category_sync_info[category].latest_new_data_epoch > pre_update_category_sync_info[category].latest_new_data_epoch ? categories_w_new_data.push(category) : null);
					}
					(categories_w_new_data.length > 0 ? io.to(socket_id).emit("show refresh alert", categories_w_new_data) : null);

					io.to(socket_id).emit("store last updated epoch", u.last_updated_epoch);
					io.to(socket_id).emit("token_v2_status", u.token_v2_status);
				}
			}
		} catch (err) {
			if (err != `Error: user (${username}) dne`) {
				console.error(err);
				logger.error(`user (${username}) update error (${err})`);

				// On 403, the tracked cursor item may have been deleted — reset it.
				if (err.statusCode == 403 && u) {
					try {
						const category = err.extras?.category;
						if (category) {
							u.requester = reddit.create_requester(cryptr.decrypt(u.reddit_api_refresh_token_encrypted));
							switch (category) {
								case "saved":
									await u.replace_latest_fn(category, "mixed");
									break;
								case "created":
									await Promise.all([
										u.replace_latest_fn(category, "posts"),
										u.replace_latest_fn(category, "comments")
									]);
									break;
								case "upvoted":
								case "downvoted":
								case "hidden":
									await u.replace_latest_fn(category, "posts");
									break;
								default:
									break;
							}
							await sql.update_user(u.username, {
								category_sync_info: JSON.stringify(u.category_sync_info)
							});
						}
					} catch (err2) {
						console.error(err2);
						logger.error(`user (${username}) replace_latest_fn error (${err2})`);
					}
				}
			}
		}
	}

	update_all_completed = true;
	console.log("update all completed");
	import_all_bg().catch(err => console.error(err));
}

function cycle_update_all(io) {
	const interval_ms = (parseInt(process.env.SYNC_INTERVAL_SECONDS) || 300) * 1000;
	update_all(io).catch((err) => console.error(err));

	setInterval(() => {
		(update_all_completed ? update_all(io).catch((err) => console.error(err)) : null);
	}, interval_ms);
}

export {
	User,
	usernames_to_socket_ids,
	socket_ids_to_usernames,
	fill_usernames_to_socket_ids,
	get,
	cycle_update_all
};
