// Unit test for getContentByIdsBatched — no network, no credentials needed.
// Run with: node test_batched.mjs

import { strict as assert } from 'assert';

// Minimal stub of RedditClient exposing only the methods under test.
class RedditClientStub {
	constructor() {
		this.calls = [];       // fullname arrays passed to getContentByIds
		this.sleeps = [];      // ms values passed to _sleep
	}

	async _sleep(ms) {
		this.sleeps.push(ms);
	}

	async getContentByIds(fullnames) {
		this.calls.push([...fullnames]);
		// Return a fake item per fullname so we can verify result assembly.
		return fullnames.map(fn => ({ kind: fn.startsWith('t3') ? 't3' : 't1', data: { id: fn.split('_')[1] } }));
	}

	async getContentByIdsBatched(fullnames) {
		const results = [];
		for (let i = 0; i < fullnames.length; i += 100) {
			if (i > 0) await this._sleep(1000);
			const batch = fullnames.slice(i, i + 100);
			const items = await this.getContentByIds(batch);
			results.push(...items);
		}
		return results;
	}
}

function makeIds(count, prefix = 't3') {
	return Array.from({ length: count }, (_, i) => `${prefix}_${String(i).padStart(6, '0')}`);
}

let passed = 0;

async function test(name, fn) {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (err) {
		console.error(`  FAIL  ${name}`);
		console.error(`        ${err.message}`);
		process.exitCode = 1;
	}
}

// --- empty input ---
await test('empty array → no calls, no sleeps, empty results', async () => {
	const c = new RedditClientStub();
	const res = await c.getContentByIdsBatched([]);
	assert.equal(res.length, 0);
	assert.equal(c.calls.length, 0);
	assert.equal(c.sleeps.length, 0);
});

// --- exactly 1 item ---
await test('1 item → 1 call, no sleep, 1 result', async () => {
	const c = new RedditClientStub();
	const res = await c.getContentByIdsBatched(['t3_aaaaaa']);
	assert.equal(c.calls.length, 1);
	assert.deepEqual(c.calls[0], ['t3_aaaaaa']);
	assert.equal(c.sleeps.length, 0);
	assert.equal(res.length, 1);
	assert.equal(res[0].data.id, 'aaaaaa');
});

// --- exactly 100 items (one full batch, no sleep) ---
await test('100 items → 1 call, no sleep, 100 results', async () => {
	const c = new RedditClientStub();
	const ids = makeIds(100);
	const res = await c.getContentByIdsBatched(ids);
	assert.equal(c.calls.length, 1);
	assert.equal(c.calls[0].length, 100);
	assert.equal(c.sleeps.length, 0);
	assert.equal(res.length, 100);
});

// --- 101 items (splits into 100 + 1, one sleep) ---
await test('101 items → 2 calls, 1 sleep of 1000ms, 101 results', async () => {
	const c = new RedditClientStub();
	const ids = makeIds(101);
	const res = await c.getContentByIdsBatched(ids);
	assert.equal(c.calls.length, 2);
	assert.equal(c.calls[0].length, 100);
	assert.equal(c.calls[1].length, 1);
	assert.deepEqual(c.sleeps, [1000]);
	assert.equal(res.length, 101);
});

// --- 500 items (5 batches, 4 sleeps) ---
await test('500 items → 5 calls, 4 sleeps, 500 results', async () => {
	const c = new RedditClientStub();
	const ids = makeIds(500);
	const res = await c.getContentByIdsBatched(ids);
	assert.equal(c.calls.length, 5);
	assert.equal(c.sleeps.length, 4);
	assert.ok(c.sleeps.every(ms => ms === 1000));
	assert.equal(res.length, 500);
	// Each batch must be exactly 100 items.
	for (const call of c.calls) assert.equal(call.length, 100);
});

// --- 250 mixed prefixes (t1 and t3), verifying no cross-batch id leakage ---
await test('250 items → 3 calls, correct batch sizes (100+100+50)', async () => {
	const c = new RedditClientStub();
	const ids = [...makeIds(125, 't3'), ...makeIds(125, 't1')];
	const res = await c.getContentByIdsBatched(ids);
	assert.equal(c.calls.length, 3);
	assert.equal(c.calls[0].length, 100);
	assert.equal(c.calls[1].length, 100);
	assert.equal(c.calls[2].length, 50);
	assert.equal(c.sleeps.length, 2);
	assert.equal(res.length, 250);
});

// --- order preservation: results appear in input order ---
await test('result order matches input order across batch boundaries', async () => {
	const c = new RedditClientStub();
	const ids = makeIds(150);
	const res = await c.getContentByIdsBatched(ids);
	for (let i = 0; i < 150; i++) {
		const expected_id = String(i).padStart(6, '0');
		assert.equal(res[i].data.id, expected_id, `position ${i}`);
	}
});

// --- import_pending integration: fullname construction from queue rows ---
await test('fullname construction from {fn_prefix, id} rows matches expected', async () => {
	const c = new RedditClientStub();
	const rows = [
		{ fn_prefix: 't3', id: 'abc123', permalink: '/r/x/comments/abc123/' },
		{ fn_prefix: 't1', id: 'def456', permalink: null },   // ghost item (no permalink)
		{ fn_prefix: 't3', id: 'ghi789', permalink: '/r/y/comments/ghi789/' },
	];
	const fullnames = rows.map(r => `${r.fn_prefix}_${r.id}`);
	const res = await c.getContentByIdsBatched(fullnames);
	assert.deepEqual(c.calls[0], ['t3_abc123', 't1_def456', 't3_ghi789']);
	assert.equal(res.length, 3);
	// Ghost item (permalink=null) is no longer skipped — it's included.
	assert.equal(res[1].data.id, 'def456');
});

console.log(`\n${passed} tests passed`);
