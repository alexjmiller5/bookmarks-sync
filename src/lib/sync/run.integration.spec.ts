import { afterEach, expect, it, vi } from 'vitest';
import { runSync } from './run';
import type { Base } from './plan';

afterEach(() => vi.restoreAllMocks());

it('preserves deleted rows and private discovery while writing public stars through a different token', async () => {
	const stars = new Map([
		[
			'R1',
			{
				node_id: 'R1',
				full_name: 'owner/private',
				html_url: 'https://github.com/owner/private',
				description: null,
				private: true
			}
		],
		[
			'R2',
			{
				node_id: 'R2',
				full_name: 'owner/deleted',
				html_url: 'https://github.com/owner/deleted',
				description: null,
				private: false
			}
		]
	]);
	const rows = [
		{
			id: 'b1',
			url: 'https://github.com/owner/private',
			tags: '["Github"]',
			needs_review: null,
			deleted_at: null
		},
		{
			id: 'b2',
			url: 'https://github.com/owner/deleted',
			tags: '["Github"]',
			needs_review: null,
			deleted_at: '2026-01-01'
		},
		{
			id: 'b3',
			url: 'https://github.com/other/public',
			tags: '["Github","Learning"]',
			needs_review: null,
			deleted_at: null
		}
	];
	const memberships = new Set<string>();
	let base: Base | null = null;
	const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
	const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		const path = String(url);
		const auth = new Headers(init?.headers).get('Authorization');
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		if (path.startsWith('https://hub.example')) {
			expect(auth).toBe('Bearer life');
			if (path.endsWith('/v1/rows/pull')) return json({ rows });
			if (path.endsWith('/v1/catalog'))
				return json({
					properties: [{ id: 'bookmarks.tags', options: '[{"v":"Github"},{"v":"Learning"}]' }]
				});
			throw new Error('No source row should need a write in this scenario');
		}
		if (path.includes('/user/starred')) {
			// The public-only credential cannot see R1. Using it must fail the test.
			return json([...stars.values()].filter((r) => auth === 'Bearer fine' || !r.private));
		}
		if (body.query.startsWith('query')) {
			expect(auth).toBe('Bearer fine');
			if (body.query.includes('viewer'))
				return json({
					data: {
						viewer: {
							lists: page(
								memberships.size
									? [{ id: 'L1', name: 'Learning', items: page([{ id: 'R3' }]) }]
									: []
							)
						}
					}
				});
			expect(body.query).toContain('isPrivate');
			return json({
				data: {
					r0: {
						id: 'R3',
						nameWithOwner: 'other/public',
						url: 'https://github.com/other/public',
						description: null,
						isPrivate: false
					}
				}
			});
		}
		const data: Record<string, unknown> = {};
		for (const [key, input] of Object.entries(body.variables) as [
			string,
			Record<string, unknown>
		][]) {
			const alias = key.replace('i', 'm');
			if (auth !== 'Bearer public')
				return json({
					data: null,
					errors: [{ message: 'Resource not accessible by personal access token' }]
				});
			if (input.name) data[alias] = { list: { id: 'L1' } };
			else {
				if (body.query.includes(`${alias}: removeStar`)) stars.delete(String(input.starrableId));
				if (body.query.includes(`${alias}: addStar`))
					stars.set('R3', {
						node_id: 'R3',
						full_name: 'other/public',
						html_url: 'https://github.com/other/public',
						description: null,
						private: false
					});
				if (input.itemId) memberships.add(String(input.itemId));
				data[alias] = { clientMutationId: null };
			}
		}
		return json({ data });
	});
	const env = {
		GITHUB_TOKEN: 'fine',
		GITHUB_PUBLIC_TOKEN: 'public',
		LIFE_HUB_URL: 'https://hub.example',
		LIFE_HUB_TOKEN: 'life'
	};
	const state = {
		load: async () => base,
		save: async (b: Base) => {
			base = b;
		}
	};
	const first = await runSync(env, state, { trigger: 'test' });
	expect(first.errors).toEqual([]);
	expect(first.planned.unstar).toEqual(['owner/deleted']);
	expect([...stars.keys()]).toEqual(['R1', 'R3']);
	expect(memberships.has('R3')).toBe(true);
	expect(rows[1].deleted_at).toBe('2026-01-01');
	expect(base).toEqual({
		repos: {
			R1: { key: 'owner/private', lists: [] },
			R3: { key: 'other/public', lists: ['Learning'] }
		}
	});
	const second = await runSync(env, state, { trigger: 'test' });
	expect(second.errors).toEqual([]);
	expect(second.applied).toBe(0);
	expect(second.planned.star).toEqual([]);
	expect(second.planned.unstar).toEqual([]);
});
