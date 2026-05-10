const backend = process.cwd();

const sql = await import(`${backend}/model/sql.mjs`);
const reddit = await import(`${backend}/model/reddit.mjs`);
const cryptr = await import(`${backend}/model/cryptr.mjs`);
const logger = await import(`${backend}/model/logger.mjs`);
const utils = await import(`${backend}/model/utils.mjs`);

let update_all_completed = null;

const usernames_to_socket_ids = {};
const socket_ids_to_usernames = {};

class User {
	constructor(username, session_cookie, dummy=false) {
		this.username = username;

		if (dummy) {
			null;
		} else {
			this.reddit_api_refresh_token_encrypted = cryptr.encrypt(session_cookie);
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

			await sql.save_user(this.username, this.reddit_api_refresh_token_encrypted, this.category_sync_info, this.last_active_epoch);
		} else {
			console.log(`returning user (${this.username})`);

			await sql.update_user(this.username, {
				reddit_api_refresh_token_encrypted: this.reddit_api_refresh_token_encrypted
			});
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

			for (const item of items) {
				const d = item.data;
				this.new_data.items[d.id] = {
					type: (type == "posts" ? "post" : "comment"),
					content: (type == "posts" ? d.title : d.body),
					author: `u/${d.author}`,
					sub: d.subreddit_name_prefixed,
					url: `https://www.reddit.com${utils.strip_trailing_slash(d.permalink)}`,
					created_epoch: d.created_utc
				};

				this.new_data.category_item_ids[category].add(d.id);
				this.sub_icon_urls_to_get.add(d.subreddit_name_prefixed);
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

		this.requester = reddit.create_requester(cryptr.decrypt(this.reddit_api_refresh_token_encrypted));

		this.new_data = {
			items: {},
			category_item_ids: {},
			item_sub_icon_urls: {}
		};
		this.sub_icon_urls_to_get = new Set();
		this.imported_fns_to_delete = new Set();

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
			await this.import_category("saved", "mixed");
		});
		await run("created", async () => {
			await this.sync_category("created", "posts");
			await this.sync_category("created", "comments");
			await this.import_category("created", "mixed");
		});
		await run("upvoted", async () => {
			await this.sync_category("upvoted", "posts");
			await this.import_category("upvoted", "posts");
		});
		await run("downvoted", async () => {
			await this.sync_category("downvoted", "posts");
			await this.import_category("downvoted", "posts");
		});
		await run("hidden", async () => {
			await this.sync_category("hidden", "posts");
			await this.import_category("hidden", "posts");
		});
		await this.get_new_item_icon_urls();

		try {
			await sql.insert_data(this.username, this.new_data);
			await sql.delete_imported_fns([...(this.imported_fns_to_delete)]);
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
	}

	async renew_comment(comment_id) {
		const requester = reddit.create_requester(cryptr.decrypt(this.reddit_api_refresh_token_encrypted));
		const items = await requester.getContentByIds([`t1_${comment_id}`]);
		if (!items.length) throw new Error(`comment ${comment_id} not found`);
		const comment_content = items[0].data.body;
		sql.update_item(comment_id, comment_content).catch((err) => console.error(err));
		return comment_content;
	}

	async delete_item_from_reddit_acc(item_id, item_category, item_type) {
		const requester = reddit.create_requester(cryptr.decrypt(this.reddit_api_refresh_token_encrypted));
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
