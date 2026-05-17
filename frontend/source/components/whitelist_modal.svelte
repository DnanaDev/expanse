<script>
	import { tick } from "svelte";
	import * as globals from "frontend/source/globals.js";

	const globals_r = globals.readonly;

	const ITEM_HEIGHT = 42;
	const BUFFER = 10;

	let modal;
	let left_container;
	let all_subs = [];
	let loading = false;
	let saving = false;
	let save_error = false;
	let saved = false;
	let search_left = "";
	let sort_by = "frequency"; // "frequency" | "recency"
	let scroll_top = 0;
	let container_height = 0;

	// Single reactive block — avoids Svelte 3's chain-propagation fragility.
	// Any change to sort_by, search_left, all_subs, scroll_top, or container_height
	// re-runs the whole block atomically.
	let vs_items = [];
	let pad_top = 0;
	let pad_bot = 0;
	let available_count = 0;
	let total_available = 0;

	$: {
		const avail = all_subs.filter(s => !s.whitelisted);
		total_available = avail.length;

		if (sort_by === "recency") {
			avail.sort((a, b) => (b.latest_epoch || 0) - (a.latest_epoch || 0));
		} else {
			avail.sort((a, b) => b.count - a.count);
		}

		const filtered = search_left
			? avail.filter(s => s.sub.toLowerCase().includes(search_left.toLowerCase()))
			: avail;

		available_count = filtered.length;

		const start = Math.max(0, Math.floor(scroll_top / ITEM_HEIGHT) - BUFFER);
		const end   = Math.min(filtered.length, Math.ceil((scroll_top + container_height) / ITEM_HEIGHT) + BUFFER);

		vs_items = filtered.slice(start, end);
		pad_top  = start * ITEM_HEIGHT;
		pad_bot  = Math.max(0, (filtered.length - end) * ITEM_HEIGHT);
	}

	$: whitelisted_subs = all_subs
		.filter(s => s.whitelisted)
		.sort((a, b) => {
			if (a.sub === "*nsfw") return -1;
			if (b.sub === "*nsfw") return 1;
			return a.sub.localeCompare(b.sub);
		});

	// --- Scroll reset ---

	function reset_scroll() {
		scroll_top = 0;
		// Defer the DOM scrollTop write until after Svelte has flushed the new
		// pad heights, so the container's scroll range is correct first.
		tick().then(() => { if (left_container) left_container.scrollTop = 0; });
	}

	function set_sort(mode) {
		sort_by = mode;
		reset_scroll();
	}

	function on_search(e) {
		search_left = e.currentTarget.value;
		reset_scroll();
	}

	function fmt_recency(epoch) {
		if (!epoch) return "?";
		const diff = Date.now() / 1000 - epoch;
		if (diff < 86400)       return "<1d";
		if (diff < 86400 * 30)  return `${Math.floor(diff / 86400)}d`;
		if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)}mo`;
		return `${Math.floor(diff / 86400 / 365)}y`;
	}

	// --- External API ---

	export function open() {
		loading = true;
		save_error = false;
		saved = false;
		search_left = "";
		sort_by = "frequency";
		all_subs = [];
		scroll_top = 0;

		globals_r.socket.emit("get whitelist");
		globals_r.socket.once("got whitelist", (data) => {
			const map = {};
			for (const {sub, count, latest_epoch} of data.available) {
				map[sub] = {sub, count, latest_epoch, whitelisted: false};
			}
			for (const sub of data.whitelisted) {
				if (!map[sub]) map[sub] = {sub, count: 0, latest_epoch: 0, whitelisted: true};
				else           map[sub].whitelisted = true;
			}
			all_subs = Object.values(map);
			loading = false;
		});

		jQuery(modal).modal("show");
	}

	function toggle_sub(sub) {
		if (sub === "*nsfw") return;
		all_subs = all_subs.map(s => s.sub === sub ? {...s, whitelisted: !s.whitelisted} : s);
		saved = false;
	}

	async function save() {
		saving = true;
		save_error = false;
		saved = false;

		const subs = all_subs.filter(s => s.whitelisted).map(s => s.sub);
		try {
			await new Promise((resolve, reject) => {
				globals_r.socket.emit("save whitelist", subs);
				globals_r.socket.once("saved whitelist", (result) => {
					result === "error" ? reject() : resolve();
				});
			});
			saved = true;
		} catch {
			save_error = true;
		}

		saving = false;
	}
</script>

<div bind:this={modal} class="modal fade" tabindex="-1">
	<div class="modal-dialog modal-xl" style="max-width: 90vw;">
		<div class="modal-content bg-secondary">
			<div class="modal-header py-2">
				<h5 class="modal-title text-light">Archive Whitelist</h5>
				<button type="button" class="close text-light" data-dismiss="modal"><span>&times;</span></button>
			</div>

			<div class="modal-body pb-2">
				{#if loading}
					<div class="text-center py-5">
						<div class="spinner-border text-light" role="status">
							<span class="sr-only">loading...</span>
						</div>
					</div>
				{:else}
					<div class="row no-gutters">

						<!-- ── Left: Available ── -->
						<div class="col-7 pr-3">
							<div class="d-flex justify-content-between align-items-center mb-1">
								<h6 class="text-light mb-0">
									Available
									<small class="text-muted">
										({available_count}{available_count !== total_available ? ` / ${total_available}` : ""})
									</small>
								</h6>
								<div class="btn-group btn-group-sm">
									<button
										type="button"
										class="btn btn-sm py-0"
										class:btn-light={sort_by === "frequency"}
										class:btn-outline-light={sort_by !== "frequency"}
										style="font-size: 0.75rem;"
										on:click={() => set_sort("frequency")}
										title="sort by item count"
									><i class="fas fa-sort-amount-down mr-1"></i>freq</button>
									<button
										type="button"
										class="btn btn-sm py-0"
										class:btn-light={sort_by === "recency"}
										class:btn-outline-light={sort_by !== "recency"}
										style="font-size: 0.75rem;"
										on:click={() => set_sort("recency")}
										title="sort by most recent item"
									><i class="fas fa-clock mr-1"></i>recent</button>
								</div>
							</div>

							<input
								type="text"
								class="form-control form-control-sm mb-1"
								placeholder="filter subreddits..."
								value={search_left}
								on:input={on_search}
							/>

							<!-- Virtualised list -->
							<div
								bind:this={left_container}
								bind:clientHeight={container_height}
								style="height: 55vh; overflow-y: auto; overflow-x: hidden; border: 1px solid rgba(0,0,0,.2); border-radius: .25rem; background: #fff;"
								on:scroll={e => scroll_top = e.currentTarget.scrollTop}
							>
								<div style="height: {pad_top}px;"></div>

								{#each vs_items as {sub, count, latest_epoch} (sub)}
									<button
										type="button"
										class="d-flex justify-content-between align-items-center w-100 px-2 border-0 text-left"
										style="min-height: {ITEM_HEIGHT}px; font-size: 0.85rem; background: transparent; cursor: pointer; border-bottom: 1px solid #dee2e6 !important;"
										on:click={() => toggle_sub(sub)}
										on:mouseenter={e => e.currentTarget.style.background = "#f8f9fa"}
										on:mouseleave={e => e.currentTarget.style.background = "transparent"}
									>
										<span class="mr-2" style="color: #212529; min-width: 0; overflow-wrap: break-word; word-break: break-word; line-height: 1.3;">{sub}</span>
										<span class="badge badge-dark badge-pill flex-shrink-0">
											{sort_by === "recency" ? fmt_recency(latest_epoch) : count.toLocaleString()}
										</span>
									</button>
								{/each}

								<div style="height: {pad_bot}px;"></div>

								{#if available_count === 0}
									<div class="p-2 text-muted" style="font-size: 0.85rem;">
										{search_left ? "no matches" : "all subreddits whitelisted"}
									</div>
								{/if}
							</div>
						</div>

						<!-- ── Right: Whitelisted ── -->
						<div class="col-5 pl-3 border-left border-dark">
							<div class="d-flex justify-content-between align-items-center mb-1" style="height: 28px;">
								<h6 class="text-light mb-0">
									Whitelisted <small class="text-muted">({whitelisted_subs.length})</small>
								</h6>
								<small class="text-muted">click to remove</small>
							</div>

							<!-- spacer matching the filter input on the left -->
							<div style="height: 31px;" class="mb-1"></div>

							<div style="height: 55vh; overflow-y: auto; overflow-x: hidden; border: 1px solid rgba(0,0,0,.2); border-radius: .25rem; background: #fff;">
								{#each whitelisted_subs as {sub} (sub)}
									<button
										type="button"
										class="d-flex justify-content-between align-items-center w-100 px-2 border-0 text-left"
										style="min-height: {ITEM_HEIGHT}px; font-size: 0.85rem; background: transparent; cursor: {sub === '*nsfw' ? 'default' : 'pointer'}; border-bottom: 1px solid #dee2e6 !important; border-left: 3px solid {sub === '*nsfw' ? '#6c757d' : '#28a745'} !important;"
										disabled={sub === "*nsfw"}
										on:click={() => toggle_sub(sub)}
										on:mouseenter={e => { if (sub !== "*nsfw") e.currentTarget.style.background = "#f8f9fa"; }}
										on:mouseleave={e => e.currentTarget.style.background = "transparent"}
									>
										<span class="mr-2" style="color: #212529; min-width: 0; overflow-wrap: break-word; word-break: break-word; line-height: 1.3;">{sub}</span>
										{#if sub === "*nsfw"}
											<small class="text-muted flex-shrink-0">sentinel</small>
										{:else}
											<i class="fas fa-times flex-shrink-0" style="color: #adb5bd;"></i>
										{/if}
									</button>
								{/each}
								{#if whitelisted_subs.length === 0}
									<div class="p-2 text-muted" style="font-size: 0.85rem;">none selected</div>
								{/if}
							</div>
						</div>
					</div>

					<div class="mt-2 text-muted" style="font-size: 0.75rem;">
						<code class="text-light">*nsfw</code> archives all NSFW posts regardless of subreddit
						&nbsp;·&nbsp; freq = item count &nbsp;·&nbsp; recent = age of newest post saved
					</div>
				{/if}
			</div>

			<div class="modal-footer py-2">
				{#if save_error}
					<span class="text-danger mr-auto" style="font-size: 0.85rem;">save failed</span>
				{:else if saved}
					<span class="text-light mr-auto" style="font-size: 0.85rem;">saved</span>
				{/if}
				<button type="button" class="btn btn-light btn-sm" data-dismiss="modal">close</button>
				<button
					type="button"
					class="btn btn-dark btn-sm"
					on:click={save}
					disabled={saving || loading}
				>
					{#if saving}
						<span class="spinner-border spinner-border-sm" role="status"></span>
					{:else}
						save
					{/if}
				</button>
			</div>
		</div>
	</div>
</div>
