import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchBookmarks, fetchListTags, writeRows } from './somadata';

const env = { SOMA_HUB_URL: 'https://hub.example/', SOMA_HUB_TOKEN: 'tok' };

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
const body = (m: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(m.mock.calls[i][1].body);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('fetchBookmarks', () => {
	it('keeps repository rows and deletion history and parses tags', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				rows: [
					{
						id: 'a',
						url: 'https://github.com/o/r',
						tags: '["Github","Money"]',
						needs_review: null,
						deleted_at: null
					},
					{
						id: 'b',
						url: 'https://example.com',
						tags: '["List"]',
						needs_review: null,
						deleted_at: null
					},
					{ id: 'c', url: null, tags: null, needs_review: null, deleted_at: null },
					{
						id: 'd',
						url: 'https://github.com/o/gone',
						tags: '["Github"]',
						needs_review: null,
						deleted_at: '2026-01-01'
					},
					{
						id: 'e',
						url: 'https://github.com/openrewrite',
						tags: '["Github"]',
						needs_review: null,
						deleted_at: null
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		expect(await fetchBookmarks(env)).toEqual([
			{
				id: 'a',
				url: 'https://github.com/o/r',
				tags: ['Github', 'Money'],
				needsReview: null,
				deletedAt: null
			},
			{
				id: 'd',
				url: 'https://github.com/o/gone',
				tags: ['Github'],
				needsReview: null,
				deletedAt: '2026-01-01'
			}
		]);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://hub.example/v1/rows/pull');
		expect(init.headers['Authorization']).toBe('Bearer tok');
		expect(body(fetchMock)).toEqual({
			table: 'bookmarks',
			columns: ['id', 'url', 'tags', 'needs_review', 'deleted_at'],
			limit: 200
		});
	});

	it('follows next_cursor until the last page, since a table-scoped pull returns 200 rows at most', async () => {
		const row = (id: string) => ({
			id,
			url: `https://github.com/o/${id}`,
			tags: '["Github"]',
			needs_review: null,
			deleted_at: null
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ rows: [row('a')], next_cursor: 'a' }))
			.mockResolvedValueOnce(jsonResponse({ rows: [row('b')], next_cursor: null }));
		vi.stubGlobal('fetch', fetchMock);

		expect((await fetchBookmarks(env)).map((b) => b.id)).toEqual(['a', 'b']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(body(fetchMock, 0).after).toBeUndefined();
		expect(body(fetchMock, 1)).toMatchObject({ limit: 200, after: 'a' });
	});

	it('goes through the SOMA_HUB service binding when one is bound', async () => {
		const bound = vi.fn().mockResolvedValue(jsonResponse({ rows: [] }));
		const global = vi.fn();
		vi.stubGlobal('fetch', global);
		await fetchBookmarks({ ...env, SOMA_HUB: { fetch: bound } });
		expect(bound).toHaveBeenCalledTimes(1);
		expect(global).not.toHaveBeenCalled();
	});

	it('throws on a non-2xx hub response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 403 })));
		await expect(fetchBookmarks(env)).rejects.toThrow('403');
	});
});

describe('fetchListTags', () => {
	it('reads the bookmarks.tags options, minus Github, through the table-scoped options route', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				options: [
					{ v: 'Github', d: 'g' },
					{ v: 'Money', d: 'Ways to earn or save money.' },
					{ v: 'Undescribed' }
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		expect(await fetchListTags(env)).toEqual([
			{ name: 'Money', description: 'Ways to earn or save money.' },
			{ name: 'Undescribed', description: '' }
		]);
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://hub.example/v1/catalog/options?table=bookmarks&column=tags'
		);
		expect(fetchMock.mock.calls[0][1].method).toBe('GET');
	});

	it('fails loudly when the vocabulary is empty', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ options: [] })));
		await expect(fetchListTags(env)).rejects.toThrow('bookmarks.tags');
	});
});

describe('writeRows', () => {
	it('pushes one request per column set and reports per-op success', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ rejected: [] }))
			.mockResolvedValueOnce(jsonResponse({ rejected: [{ id: 'b2', message: 'bad tag' }] }))
			.mockResolvedValueOnce(jsonResponse({ rejected: [] }));
		vi.stubGlobal('fetch', fetchMock);

		const out = await writeRows(env, [
			{
				op: 'create',
				repo: {
					id: 'R1',
					url: 'https://github.com/o/r',
					fullName: 'o/r',
					isPrivate: false,
					description: 'A thing.'
				},
				tags: ['Github'],
				needsReview: null
			},
			{ op: 'update', bookmarkId: 'b1', tags: ['Github', 'Money'] },
			{ op: 'update', bookmarkId: 'b2', tags: ['Github', 'Nope'] },
			{ op: 'delete', bookmarkId: 'b3' }
		]);

		expect(out.ok).toEqual([true, true, false, true]);
		expect(out.errors).toEqual(['b2: bad tag']);
		expect(fetchMock).toHaveBeenCalledTimes(3);

		const create = body(fetchMock, 0);
		expect(create.table).toBe('bookmarks');
		const row = create.rows[0];
		expect(row.id).toMatch(/^[0-9a-f]{32}$/);
		expect(row).toMatchObject({
			url: 'https://github.com/o/r',
			title: 'o/r: A thing.',
			description: 'A thing',
			tags: ['Github'],
			needs_review: null
		});
		expect(create.columns).toEqual(Object.keys(row));

		expect(body(fetchMock, 1).rows.map((r: { id: string }) => r.id)).toEqual(['b1', 'b2']);
		const del = body(fetchMock, 2).rows[0];
		expect(del.deleted_at).toBe(del.updated_at);
		expect(del.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
	});

	it('marks a whole group failed when the hub request fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('down', { status: 503 })));
		const out = await writeRows(env, [{ op: 'update', bookmarkId: 'b1', needsReview: null }]);
		expect(out.ok).toEqual([false]);
		expect(out.errors[0]).toMatch(/503/);
	});

	it('falls back to the repo name when it has no description', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ rejected: [] }));
		vi.stubGlobal('fetch', fetchMock);
		await writeRows(env, [
			{
				op: 'create',
				repo: {
					id: 'R1',
					url: 'https://github.com/o/r',
					fullName: 'o/r',
					isPrivate: false,
					description: null
				},
				tags: ['Github'],
				needsReview: null
			}
		]);
		expect(body(fetchMock).rows[0]).toMatchObject({ title: 'o/r', description: 'o/r' });
	});
});
