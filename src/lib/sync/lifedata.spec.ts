import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchGithubBookmarks, createBookmark } from './lifedata';

const env = { LIFE_HUB_URL: 'https://hub.example/', LIFE_HUB_TOKEN: 'tok' };

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('fetchGithubBookmarks', () => {
	it('pulls the bookmarks table and keeps live Github-tagged rows with a url', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				rows: [
					{ id: 'a', url: 'https://github.com/o/r', tags: '["Github"]', deleted_at: null },
					{ id: 'b', url: 'https://example.com', tags: '["List"]', deleted_at: null },
					{ id: 'c', url: null, tags: '["Github"]', deleted_at: null },
					{
						id: 'd',
						url: 'https://github.com/o/gone',
						tags: '["Github"]',
						deleted_at: '2026-01-01'
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const out = await fetchGithubBookmarks(env);
		expect(out).toEqual([{ id: 'a', url: 'https://github.com/o/r' }]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://hub.example/v1/rows/pull');
		expect(init.headers['Authorization']).toBe('Bearer tok');
		expect(JSON.parse(init.body)).toEqual({
			table: 'bookmarks',
			columns: ['id', 'url', 'tags', 'deleted_at'],
			since: ''
		});
	});

	it('throws on a non-2xx hub response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })));
		await expect(fetchGithubBookmarks(env)).rejects.toThrow('403');
	});
});

describe('createBookmark', () => {
	it('pushes one catalog-valid row: fresh id, Github tag, no trailing period', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ upserted: 1, rejected: [] }));
		vi.stubGlobal('fetch', fetchMock);

		await createBookmark(env, {
			fullName: 'owner/repo',
			description: 'A thing.',
			htmlUrl: 'https://github.com/owner/repo'
		});
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://hub.example/v1/rows/push');
		const body = JSON.parse(init.body);
		expect(body.table).toBe('bookmarks');
		const row = body.rows[0];
		expect(row.id).toMatch(/^[0-9a-f]{32}$/);
		expect(row.url).toBe('https://github.com/owner/repo');
		expect(row.title).toBe('owner/repo: A thing.');
		expect(row.description).toBe('A thing');
		expect(row.tags).toEqual(['Github']);
		expect(row.updated_at).toMatch(/Z$/);
		expect(body.columns).toEqual(Object.keys(row));
	});

	it('falls back to fullName when the repo has no description', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ upserted: 1, rejected: [] }));
		vi.stubGlobal('fetch', fetchMock);
		await createBookmark(env, {
			fullName: 'o/r',
			description: null,
			htmlUrl: 'https://github.com/o/r'
		});
		const row = JSON.parse(fetchMock.mock.calls[0][1].body).rows[0];
		expect(row.title).toBe('o/r');
		expect(row.description).toBe('o/r');
	});

	it('throws when the catalog rejects the row', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(jsonResponse({ rejected: [{ col: 'tags', message: 'bad' }] }))
		);
		await expect(
			createBookmark(env, { fullName: 'o/r', description: 'x', htmlUrl: 'https://github.com/o/r' })
		).rejects.toThrow('rejected o/r: bad');
	});
});
