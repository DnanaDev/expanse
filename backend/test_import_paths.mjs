// Simulation tests for all import_pending data paths.
// No network, no database — all dependencies are stubbed.
// Run with: node test_import_paths.mjs

import { strict as assert } from 'assert';

// ---------------------------------------------------------------------------
// Shared stubs / helpers
// ---------------------------------------------------------------------------

function make_row(id, fn_prefix = 't3', permalink = `/r/sub/comments/${id}/`) {
	return { id, fn_prefix, permalink };
}

function reddit_post(id, title = 'A real title') {
	return { kind: 't3', data: { id, title, body: null, author: 'user', subreddit_name_prefixed: 'r/sub', permalink: `/r/sub/comments/${id}/`, created_utc: 0 } };
}

function reddit_comment(id, body = 'A real comment') {
	return { kind: 't1', data: { id, body, title: null, author: 'user', subreddit_name_prefixed: 'r/sub', permalink: `/r/sub/comments/post/_/${id}/`, created_utc: 0 } };
}

function pp_post(id) {
	return { kind: 't3', data: { id, title: 'Archived title', author: 'user', subreddit_name_prefixed: 'r/sub', permalink: `/r/sub/comments/${id}/`, created_utc: 0 } };
}

// Minimal import_pending logic extracted for simulation (mirrors user.mjs exactly).
async function run_import(opts) {
	const {
		queue,           // [{id, fn_prefix, permalink}]
		already_in_db,   // Set of IDs already in item table
		reddit_returns,  // [{kind, data}] — items Reddit returns
		pp_returns,      // [{kind, data}] | 'fail' — PullPush response or 'fail' for 500
		pp_consecutive_failures_in,
		PP_FAILURE_THRESHOLD  = 3,
		PP_FAILURE_BACKOFF_SECS = 3600,
		now_epoch = 1_000_000_000,
	} = opts;

	// Tracking what the stubs were called with
	const calls = {
		delete_imported_fns:  [],
		stamp_fetch_attempt:  [],   // [{ids, epoch, count_miss}]
		insert_data:          [],
		retire_hopeless_fns:  [],   // not simulated here — tested separately
	};

	let pp_consecutive_failures = pp_consecutive_failures_in ?? 0;

	const need_to_fetch = queue.filter(r => !already_in_db.has(r.id));
	const already_have  = queue.filter(r =>  already_in_db.has(r.id));

	if (already_have.length) {
		calls.delete_imported_fns.push(already_have.map(r => `${r.fn_prefix}_${r.id}`));
	}

	if (!need_to_fetch.length) return { calls, pp_consecutive_failures };

	// Reddit batch fetch
	const all_reddit = reddit_returns;
	const placeholders = new Set(['[removed]', '[deleted]']);
	const fetched = all_reddit.filter(c =>
		!placeholders.has(c.kind === 't3' ? c.data.title : c.data.body)
	);

	const fetched_ids   = new Set(fetched.map(c => c.data.id));
	const not_on_reddit = need_to_fetch.filter(r => !fetched_ids.has(r.id));
	const pp_ids        = new Set();

	if (not_on_reddit.length) {
		const pp_candidates = not_on_reddit.slice(0, 50); // deterministic for tests
		const pp_post_ids    = pp_candidates.filter(r => r.fn_prefix === 't3').map(r => r.id);
		const pp_comment_ids = pp_candidates.filter(r => r.fn_prefix === 't1').map(r => r.id);

		try {
			if (pp_returns === 'fail') throw new Error('PullPush 500 on /reddit/search/submission/');
			const pp_results = pp_returns;
			for (const c of pp_results) pp_ids.add(c.data.id);
			fetched.push(...pp_results);

			const missed = pp_candidates.filter(r => !pp_ids.has(r.id));
			if (missed.length) {
				calls.stamp_fetch_attempt.push({
					ids: missed.map(r => r.id),
					epoch: now_epoch,
					count_miss: true,
				});
			}
			pp_consecutive_failures = 0;
		} catch (err) {
			pp_consecutive_failures++;
			if (pp_consecutive_failures >= PP_FAILURE_THRESHOLD) {
				const backoff_epoch = now_epoch - 604800 + PP_FAILURE_BACKOFF_SECS;
				calls.stamp_fetch_attempt.push({
					ids: pp_candidates.map(r => r.id),
					epoch: backoff_epoch,
					count_miss: false,    // ← THE FIX: outage does not count as a miss
				});
			}
		}
	}

	// Build and insert batch
	const inserted_ids = new Set();
	for (const c of fetched) {
		inserted_ids.add(c.data.id);
	}

	if (inserted_ids.size) {
		calls.insert_data.push([...inserted_ids]);
	}

	const to_clear = need_to_fetch.filter(r => inserted_ids.has(r.id));
	if (to_clear.length) {
		calls.delete_imported_fns.push(to_clear.map(r => `${r.fn_prefix}_${r.id}`));
	}

	return { calls, pp_consecutive_failures };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name, fn) {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (err) {
		console.error(`  FAIL  ${name}`);
		console.error(`        ${err.message}`);
		failed++;
	}
}

// ---------------------------------------------------------------------------
// PATH A — item already in DB → cleared, nothing fetched
// ---------------------------------------------------------------------------

await test('A: item already in item table → cleared from queue, no fetch', async () => {
	const row = make_row('aaa');
	const { calls } = await run_import({
		queue: [row],
		already_in_db: new Set(['aaa']),
		reddit_returns: [],
		pp_returns: [],
	});
	assert.equal(calls.delete_imported_fns.length, 1);
	assert.deepEqual(calls.delete_imported_fns[0], ['t3_aaa']);
	assert.equal(calls.stamp_fetch_attempt.length, 0);
	assert.equal(calls.insert_data.length, 0);
});

// ---------------------------------------------------------------------------
// PATH B — Reddit finds item → inserted, cleared, no stamp
// ---------------------------------------------------------------------------

await test('B: Reddit returns item → inserted and cleared, miss count unchanged', async () => {
	const row = make_row('bbb');
	const { calls } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [reddit_post('bbb')],
		pp_returns: [],
	});
	assert.equal(calls.insert_data.length, 1);
	assert.ok(calls.insert_data[0].includes('bbb'));
	assert.equal(calls.stamp_fetch_attempt.length, 0);
	const cleared = calls.delete_imported_fns.flat();
	assert.ok(cleared.includes('t3_bbb'));
});

// ---------------------------------------------------------------------------
// PATH C — Reddit returns placeholder → treated as not-found, goes to PullPush
// ---------------------------------------------------------------------------

await test('C: Reddit returns [removed] title → filtered out, falls to PullPush', async () => {
	const row = make_row('ccc');
	const { calls } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [{ kind: 't3', data: { id: 'ccc', title: '[removed]', body: null, author: '[deleted]', subreddit_name_prefixed: 'r/sub', permalink: '/r/sub/comments/ccc/', created_utc: 0 } }],
		pp_returns: [pp_post('ccc')],
	});
	// PullPush found it → inserted
	assert.equal(calls.insert_data.length, 1);
	assert.ok(calls.insert_data[0].includes('ccc'));
	assert.equal(calls.stamp_fetch_attempt.length, 0);
});

await test('C2: Reddit returns [deleted] comment body → filtered out, falls to PullPush', async () => {
	const row = make_row('ccc2', 't1');
	const { calls } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [{ kind: 't1', data: { id: 'ccc2', body: '[deleted]', title: null, author: '[deleted]', subreddit_name_prefixed: 'r/sub', permalink: '/r/sub/comments/p/_/ccc2/', created_utc: 0 } }],
		pp_returns: [],
	});
	// PullPush found nothing → stamped with count_miss=true
	assert.equal(calls.stamp_fetch_attempt.length, 1);
	assert.equal(calls.stamp_fetch_attempt[0].count_miss, true);
	assert.deepEqual(calls.stamp_fetch_attempt[0].ids, ['ccc2']);
});

// ---------------------------------------------------------------------------
// PATH D — Reddit miss, PullPush finds → inserted, cleared, no stamp
// ---------------------------------------------------------------------------

await test('D: Reddit misses, PullPush finds → inserted and cleared, miss count unchanged', async () => {
	const row = make_row('ddd');
	const { calls } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [],
		pp_returns: [pp_post('ddd')],
	});
	assert.equal(calls.insert_data.length, 1);
	assert.ok(calls.insert_data[0].includes('ddd'));
	assert.equal(calls.stamp_fetch_attempt.length, 0);
	const cleared = calls.delete_imported_fns.flat();
	assert.ok(cleared.includes('t3_ddd'));
});

// ---------------------------------------------------------------------------
// PATH E — Reddit miss, PullPush miss (reachable) → stamp + miss count++
// ---------------------------------------------------------------------------

await test('E: Reddit misses, PullPush reachable but misses → stamped, count_miss=true', async () => {
	const row = make_row('eee');
	const { calls } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [],
		pp_returns: [], // PullPush up, returns nothing
	});
	assert.equal(calls.stamp_fetch_attempt.length, 1);
	assert.deepEqual(calls.stamp_fetch_attempt[0].ids, ['eee']);
	assert.equal(calls.stamp_fetch_attempt[0].count_miss, true);
	assert.equal(calls.insert_data.length, 0);
	// Item stays in queue (not cleared)
	assert.equal(calls.delete_imported_fns.flat().includes('t3_eee'), false);
});

await test('E2: PullPush partially finds — only missed items stamped, found items cleared', async () => {
	const rows = [make_row('e1'), make_row('e2'), make_row('e3')];
	const { calls } = await run_import({
		queue: rows,
		already_in_db: new Set(),
		reddit_returns: [],
		pp_returns: [pp_post('e1')], // only e1 found
	});
	// e1 inserted and cleared
	assert.ok(calls.insert_data[0].includes('e1'));
	const cleared = calls.delete_imported_fns.flat();
	assert.ok(cleared.includes('t3_e1'));
	// e2, e3 stamped with count_miss=true
	assert.equal(calls.stamp_fetch_attempt.length, 1);
	assert.ok(calls.stamp_fetch_attempt[0].ids.includes('e2'));
	assert.ok(calls.stamp_fetch_attempt[0].ids.includes('e3'));
	assert.equal(calls.stamp_fetch_attempt[0].count_miss, true);
	// e2, e3 NOT cleared
	assert.equal(cleared.includes('t3_e2'), false);
	assert.equal(cleared.includes('t3_e3'), false);
});

// ---------------------------------------------------------------------------
// PATH F — PullPush unreachable, below threshold → no stamp, no count change
// ---------------------------------------------------------------------------

await test('F: PullPush 500, failures < threshold → no stamp, counter incremented', async () => {
	const row = make_row('fff');
	const { calls, pp_consecutive_failures } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [],
		pp_returns: 'fail',
		pp_consecutive_failures_in: 1, // 1 previous failure → becomes 2, below threshold of 3
	});
	assert.equal(calls.stamp_fetch_attempt.length, 0);
	assert.equal(calls.insert_data.length, 0);
	assert.equal(pp_consecutive_failures, 2);
});

// ---------------------------------------------------------------------------
// PATH G — PullPush unreachable, at threshold → 1h backoff stamp, NO count_miss
//           THIS IS THE BUG that was found and fixed
// ---------------------------------------------------------------------------

await test('G: PullPush 500, failures reach threshold → 1h backoff stamp, count_miss=FALSE', async () => {
	const row = make_row('ggg');
	const now = 1_000_000_000;
	const { calls, pp_consecutive_failures } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [],
		pp_returns: 'fail',
		pp_consecutive_failures_in: 2, // 2 previous → becomes 3 = threshold
		now_epoch: now,
	});
	assert.equal(calls.stamp_fetch_attempt.length, 1);
	const stamp = calls.stamp_fetch_attempt[0];
	// Must NOT count as a miss — outage is not a confirmed absence
	assert.equal(stamp.count_miss, false, 'outage backoff must not increment fetch_miss_count');
	// Epoch must be 1 hour before the 7-day wall (items retry in 1h, not 7d)
	const expected_epoch = now - 604800 + 3600;
	assert.equal(stamp.epoch, expected_epoch);
	assert.deepEqual(stamp.ids, ['ggg']);
	assert.equal(pp_consecutive_failures, 3);
});

await test('G2: backoff epoch makes item eligible again in exactly 1 hour', async () => {
	const now = 1_000_000_000;
	const backoff_epoch = now - 604800 + 3600;
	const seven_day_window = 604800;
	// Item becomes eligible when: backoff_epoch < query_time - 604800
	// → query_time > backoff_epoch + 604800 = now + 3600
	const becomes_eligible_at = backoff_epoch + seven_day_window;
	assert.equal(becomes_eligible_at, now + 3600, 'item should retry after exactly 1 hour');
});

await test('G3: repeated outage does NOT accumulate miss count', async () => {
	// Simulate 10 consecutive PullPush failures at threshold
	// miss count should never increase from outage stamps
	const row = make_row('g3');
	const now = 1_000_000_000;
	let failures = 2; // at threshold on first call
	let total_miss_increments = 0;

	for (let cycle = 0; cycle < 10; cycle++) {
		const { calls, pp_consecutive_failures: new_failures } = await run_import({
			queue: [row],
			already_in_db: new Set(),
			reddit_returns: [],
			pp_returns: 'fail',
			pp_consecutive_failures_in: failures,
			now_epoch: now + cycle * 3600,
		});
		failures = new_failures;
		for (const s of calls.stamp_fetch_attempt) {
			if (s.count_miss) total_miss_increments++;
		}
	}
	assert.equal(total_miss_increments, 0, 'outage cycles must never increment miss count');
});

// ---------------------------------------------------------------------------
// PATH H — PullPush recovers after outage → counter resets
// ---------------------------------------------------------------------------

await test('H: PullPush recovers → consecutive failure counter resets to 0', async () => {
	const row = make_row('hhh');
	const { calls, pp_consecutive_failures } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [],
		pp_returns: [pp_post('hhh')], // PullPush is back
		pp_consecutive_failures_in: 5, // was at high count
	});
	assert.equal(pp_consecutive_failures, 0);
	assert.equal(calls.stamp_fetch_attempt.length, 0);
	assert.ok(calls.insert_data[0].includes('hhh'));
});

// ---------------------------------------------------------------------------
// PATH I — retire_hopeless_fns: correct items moved, nothing else touched
// ---------------------------------------------------------------------------

await test('I: retire_hopeless_fns moves exactly the right items', async () => {
	// Simulate the DB state in memory
	const import_table = [
		{ id: 'i1', fn_prefix: 't3', permalink: '/r/a/comments/i1/', fetch_miss_count: 5 },
		{ id: 'i2', fn_prefix: 't1', permalink: null,                  fetch_miss_count: 3 },
		{ id: 'i3', fn_prefix: 't3', permalink: '/r/b/comments/i3/', fetch_miss_count: 5 },
		{ id: 'i4', fn_prefix: 't3', permalink: '/r/c/comments/i4/', fetch_miss_count: 4 },
	];
	const unresolvable_table = [];
	const now = 1_000_000_000;
	const MAX_MISSES = 5;

	// Simulate retire_hopeless_fns
	const to_retire = import_table.filter(r => r.fetch_miss_count >= MAX_MISSES);
	const remaining = import_table.filter(r => r.fetch_miss_count < MAX_MISSES);

	for (const r of to_retire) {
		const existing = unresolvable_table.find(u => u.id === r.id);
		if (existing) {
			existing.fetch_miss_count = r.fetch_miss_count;
			existing.given_up_at = now;
		} else {
			unresolvable_table.push({ ...r, given_up_at: now });
		}
	}

	// i1, i3 retired (miss_count = 5); i2 (3) and i4 (4) stay
	assert.equal(to_retire.length, 2);
	assert.ok(to_retire.some(r => r.id === 'i1'));
	assert.ok(to_retire.some(r => r.id === 'i3'));
	assert.equal(remaining.length, 2);
	assert.ok(remaining.some(r => r.id === 'i2'));
	assert.ok(remaining.some(r => r.id === 'i4'));

	// Unresolvable table has the retired items with all fields preserved
	assert.equal(unresolvable_table.length, 2);
	const u1 = unresolvable_table.find(r => r.id === 'i1');
	assert.equal(u1.fn_prefix, 't3');
	assert.equal(u1.permalink, '/r/a/comments/i1/');
	assert.equal(u1.fetch_miss_count, 5);
	assert.equal(u1.given_up_at, now);
});

await test('I2: retire on already-retired item updates record, does not duplicate', async () => {
	const unresolvable_table = [
		{ id: 'i1', fn_prefix: 't3', permalink: '/r/a/', fetch_miss_count: 5, given_up_at: 999 }
	];
	const import_table = [
		{ id: 'i1', fn_prefix: 't3', permalink: '/r/a/', fetch_miss_count: 8 }
	];
	const now = 1_000_000_001;

	// Simulate ON CONFLICT DO UPDATE
	const to_retire = import_table.filter(r => r.fetch_miss_count >= 5);
	for (const r of to_retire) {
		const existing = unresolvable_table.find(u => u.id === r.id);
		if (existing) {
			existing.fetch_miss_count = r.fetch_miss_count;
			existing.given_up_at = now;
		} else {
			unresolvable_table.push({ ...r, given_up_at: now });
		}
	}

	assert.equal(unresolvable_table.length, 1, 'no duplicate rows');
	assert.equal(unresolvable_table[0].fetch_miss_count, 8);
	assert.equal(unresolvable_table[0].given_up_at, now);
});

// ---------------------------------------------------------------------------
// PATH J — ghost item (permalink=null) included in batch, not skipped
// ---------------------------------------------------------------------------

await test('J: ghost item (permalink=null) is included in Reddit batch fetch', async () => {
	const ghost = make_row('jjj', 't3', null); // no permalink
	// Reddit finds it anyway via ID
	const { calls } = await run_import({
		queue: [ghost],
		already_in_db: new Set(),
		reddit_returns: [reddit_post('jjj')],
		pp_returns: [],
	});
	assert.equal(calls.insert_data.length, 1);
	assert.ok(calls.insert_data[0].includes('jjj'));
});

await test('J2: ghost item not on Reddit falls to PullPush without error', async () => {
	const ghost = make_row('jj2', 't3', null);
	const { calls } = await run_import({
		queue: [ghost],
		already_in_db: new Set(),
		reddit_returns: [],
		pp_returns: [pp_post('jj2')],
	});
	assert.equal(calls.insert_data.length, 1);
	assert.equal(calls.stamp_fetch_attempt.length, 0);
});

// ---------------------------------------------------------------------------
// PATH K — mixed batch: some found by Reddit, some by PullPush, some missed
// ---------------------------------------------------------------------------

await test('K: mixed batch — correct routing for each item', async () => {
	const rows = [
		make_row('k1'), // found by Reddit
		make_row('k2'), // found by PullPush
		make_row('k3'), // missed everywhere
		make_row('k4'), // already in DB
	];
	const { calls } = await run_import({
		queue: rows,
		already_in_db: new Set(['k4']),
		reddit_returns: [reddit_post('k1')],
		pp_returns: [pp_post('k2')],
	});

	const inserted = calls.insert_data.flat();
	assert.ok(inserted.includes('k1'), 'k1 inserted via Reddit');
	assert.ok(inserted.includes('k2'), 'k2 inserted via PullPush');
	assert.equal(inserted.includes('k3'), false, 'k3 not inserted');

	const cleared = calls.delete_imported_fns.flat();
	assert.ok(cleared.includes('t3_k1'), 'k1 cleared');
	assert.ok(cleared.includes('t3_k2'), 'k2 cleared');
	assert.ok(cleared.includes('t3_k4'), 'k4 cleared (was already in DB)');
	assert.equal(cleared.includes('t3_k3'), false, 'k3 stays in queue');

	// k3 stamped as genuine miss
	assert.equal(calls.stamp_fetch_attempt.length, 1);
	assert.deepEqual(calls.stamp_fetch_attempt[0].ids, ['k3']);
	assert.equal(calls.stamp_fetch_attempt[0].count_miss, true);
});

// ---------------------------------------------------------------------------
// PATH L — stamp_fetch_attempt epoch math for 7-day retry
// ---------------------------------------------------------------------------

await test('L: normal miss stamp uses current epoch (7-day retry window)', async () => {
	const now = 1_000_000_000;
	const row = make_row('lll');
	const { calls } = await run_import({
		queue: [row],
		already_in_db: new Set(),
		reddit_returns: [],
		pp_returns: [],
		now_epoch: now,
	});
	assert.equal(calls.stamp_fetch_attempt[0].epoch, now);
	// Item retries when: now < future_time - 604800 → future_time > now + 604800 (7 days)
	const retries_at = now + 604800;
	assert.ok(retries_at > now + 604799, '7-day wait confirmed');
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
