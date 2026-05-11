<script context="module">
	import * as globals from "frontend/source/globals.js";
	import Navbar from "frontend/source/components/navbar.svelte";

	import * as svelte from "svelte";

	const globals_r = globals.readonly;
</script>
<script>
	let session_cookie = "";
	let token_v2 = "";
	let error_msg = "";
	let loading = false;

	svelte.onMount(() => {
		globals_r.socket.emit("page", "landing");
	});

	async function submit_login() {
		const trimmed = session_cookie.trim();
		if (!trimmed) return;

		loading = true;
		error_msg = "";

		try {
			const response = await fetch("/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ session_cookie: trimmed, token_v2: token_v2.trim() || null })
			});
			const data = await response.json();
			if (response.ok) {
				window.location.href = "/";
			} else {
				error_msg = data.error || "Login failed";
			}
		} catch (err) {
			error_msg = "Network error — is the server running?";
		} finally {
			loading = false;
		}
	}

	function on_keydown(evt) {
		if (evt.key === "Enter") submit_login();
	}
</script>

<Navbar/>
<div class="text-center mt-3">
	<div class="jumbotron bg-dark mb-0 py-5">
		<h1 class="display-4">{globals_r.app_name}</h1>
		<p class="lead text-left">{globals_r.description}</p>
		<p class="lead text-left">features: new items auto-sync, synced items not affected by Reddit deletion, search for items, filter by subreddit, import csv data from <a href="https://www.reddit.com/settings/data-request" target="_blank">Reddit data request</a>, export data as json</p>
		<hr class="bg-secondary my-4"/>
		<div class="embed-responsive embed-responsive-16by9">
			<iframe title="demo" class="embed-responsive-item" src="https://www.youtube.com/embed/4pxXM98ewIc" allow="fullscreen"></iframe>
		</div>
		<hr class="bg-secondary my-4"/>
		<p class="lead text-left font-weight-bold">How to log in</p>
		<ol class="text-left mt-n2">
			<li>Open <a href="https://www.reddit.com" target="_blank">reddit.com</a> in your browser and make sure you are logged in.</li>
			<li>Open DevTools: press <kbd>F12</kbd> (Windows/Linux) or <kbd>Cmd+Option+I</kbd> (Mac).</li>
			<li>Go to the <strong>Application</strong> tab → <strong>Cookies</strong> → <code>https://www.reddit.com</code>.</li>
			<li>Find <code>reddit_session</code> and copy its <strong>Value</strong>. Paste it in the first field below.</li>
			<li>Optionally, find <code>token_v2</code> and paste it in the second field — this enables upvoted/downvoted sync immediately. If left blank the app will obtain it automatically on the first sync.</li>
			<li>Click <strong>Log in</strong>.</li>
		</ol>
		<p class="text-left text-muted small mt-n2">Cookies are stored encrypted and used only to sync your data. <code>reddit_session</code> lasts ~2 years. <code>token_v2</code> is refreshed automatically in the background.</p>
		<div class="row mt-3">
			<div class="col-1 col-sm-2"></div>
			<div class="col-10 col-sm-8">
				<input
					type="password"
					class="form-control mb-2"
					placeholder="reddit_session cookie value"
					bind:value={session_cookie}
					on:keydown={on_keydown}
					disabled={loading}
				/>
				<input
					type="password"
					class="form-control mb-2"
					placeholder="token_v2 cookie value (optional)"
					bind:value={token_v2}
					on:keydown={on_keydown}
					disabled={loading}
				/>
				{#if error_msg}
					<p class="text-danger text-left small mb-2">{error_msg}</p>
				{/if}
				<button
					class="btn btn-primary btn-block"
					on:click={submit_login}
					disabled={loading || !session_cookie.trim()}
				>
					{loading ? "Logging in…" : "Log in"}
				</button>
			</div>
			<div class="col-1 col-sm-2"></div>
		</div>
	</div>
</div>
