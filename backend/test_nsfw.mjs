// Tests whether /api/info.json and the permalink endpoint return the same NSFW post.
// Usage: REDDIT_SESSION=<your_reddit_session_cookie> node test_nsfw.mjs
//
// Get your reddit_session cookie from browser dev tools:
//   DevTools → Application → Cookies → reddit.com → reddit_session

const POST_ID   = "1tbos2l";
const FULLNAME  = `t3_${POST_ID}`;
const USERNAME  = process.env.REDDIT_USERNAME || "expanse";
const SESSION   = process.env.REDDIT_SESSION;

if (!SESSION) {
	console.error("Set REDDIT_SESSION=<your cookie value> before running.");
	process.exit(1);
}

const headers = {
	"User-Agent": `web:expanse:test (by u/${USERNAME})`,
	"Cookie": `reddit_session=${SESSION}`,
	"Accept": "application/json",
};

async function get(url) {
	const res = await fetch(url, { headers });
	const status = res.status;
	let body = null;
	try { body = await res.json(); } catch {}
	return { status, body };
}

console.log(`\nTesting post ${FULLNAME}\n`);

// --- /api/info.json (the new batch endpoint) ---
const info_url = `https://www.reddit.com/api/info.json?id=${FULLNAME}&raw_json=1`;
console.log(`1. GET ${info_url}`);
const info = await get(info_url);
console.log(`   HTTP ${info.status}`);
if (info.body?.data?.children?.length) {
	const d = info.body.data.children[0].data;
	console.log(`   FOUND: "${d.title}"`);
	console.log(`   subreddit : ${d.subreddit_name_prefixed}`);
	console.log(`   over_18   : ${d.over_18}`);
} else {
	console.log(`   NOT FOUND — children array is empty`);
	if (info.body) console.log(`   raw body  :`, JSON.stringify(info.body).slice(0, 300));
}

console.log();

// --- permalink endpoint (the old approach) ---
const permalink_url = `https://www.reddit.com/comments/${POST_ID}.json?raw_json=1`;
console.log(`2. GET ${permalink_url}`);
const perm = await get(permalink_url);
console.log(`   HTTP ${perm.status}`);
if (Array.isArray(perm.body) && perm.body[0]?.data?.children?.length) {
	const d = perm.body[0].data.children[0].data;
	console.log(`   FOUND: "${d.title}"`);
	console.log(`   subreddit : ${d.subreddit_name_prefixed}`);
	console.log(`   over_18   : ${d.over_18}`);
} else {
	console.log(`   NOT FOUND or unexpected response`);
	if (perm.body) console.log(`   raw body  :`, JSON.stringify(perm.body).slice(0, 300));
}

console.log();
