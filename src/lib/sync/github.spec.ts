import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchStarredRepos, fetchLists, lookupRepos, mutate } from './github';

const ghRepo = (n: number) => ({
	node_id: `R${n}`,
	private: n % 2 === 1,
	full_name: `owner/repo${n}`,
	description: n % 2 ? `desc ${n}` : null,
	html_url: `https://github.com/owner/repo${n}`
});

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}
const sent = (m: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(m.mock.calls[i][1].body);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('fetchStarredRepos', () => {
	it('maps node ids and fields from one page', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([ghRepo(1)])));
		expect(await fetchStarredRepos('tok')).toEqual([
			{
				id: 'R1',
				isPrivate: true,
				fullName: 'owner/repo1',
				description: 'desc 1',
				url: 'https://github.com/owner/repo1'
			}
		]);
	});

	it('follows Link header pagination with the right headers', async () => {
		const page2 = 'https://api.github.com/user/starred?per_page=100&page=2';
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse([ghRepo(1)], { Link: `<${page2}>; rel="next"` }))
			.mockResolvedValueOnce(jsonResponse([ghRepo(2)]));
		vi.stubGlobal('fetch', fetchMock);

		const repos = await fetchStarredRepos('tok');
		expect(repos.map((r) => r.id)).toEqual(['R1', 'R2']);
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/user/starred?per_page=100');
		expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer tok');
		expect(fetchMock.mock.calls[1][0]).toBe(page2);
	});

	it('throws on a non-2xx response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('bad credentials', { status: 401 }))
		);
		await expect(fetchStarredRepos('tok')).rejects.toThrow(/401/);
	});
});

const page = (nodes: unknown[], next?: string) => ({
	pageInfo: { hasNextPage: !!next, endCursor: next ?? null },
	nodes
});

describe('fetchLists', () => {
	it('pages through lists and through each list items', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					data: {
						viewer: {
							lists: page(
								[{ id: 'L1', name: 'Job Search', items: page([{ id: 'R1' }, {}], 'c1') }],
								'l1'
							)
						}
					}
				})
			)
			.mockResolvedValueOnce(jsonResponse({ data: { node: { items: page([{ id: 'R2' }]) } } }))
			.mockResolvedValueOnce(
				jsonResponse({
					data: { viewer: { lists: page([{ id: 'L2', name: 'Empty', items: page([]) }]) } }
				})
			);
		vi.stubGlobal('fetch', fetchMock);

		expect(await fetchLists('tok')).toEqual([
			{ id: 'L1', name: 'Job Search', itemIds: ['R1', 'R2'] },
			{ id: 'L2', name: 'Empty', itemIds: [] }
		]);
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/graphql');
		expect(sent(fetchMock, 1).variables).toEqual({ id: 'L1', after: 'c1' });
		expect(sent(fetchMock, 2).variables).toEqual({ after: 'l1' });
	});

	it('throws on GraphQL errors instead of returning a partial picture', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse({ data: null, errors: [{ message: 'Resource not accessible' }] })
				)
		);
		await expect(fetchLists('tok')).rejects.toThrow('Resource not accessible');
	});
});

describe('lookupRepos', () => {
	it('resolves keys with aliased queries and maps NOT_FOUND to null', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				data: {
					r0: {
						id: 'R1',
						isPrivate: true,
						url: 'https://github.com/owner/repo1',
						nameWithOwner: 'owner/repo1',
						description: 'd'
					},
					r1: null
				},
				errors: [{ type: 'NOT_FOUND', path: ['r1'], message: 'Could not resolve' }]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		expect(await lookupRepos('tok', ['owner/repo1', 'gone/away'])).toEqual({
			'owner/repo1': {
				id: 'R1',
				isPrivate: true,
				url: 'https://github.com/owner/repo1',
				fullName: 'owner/repo1',
				description: 'd'
			},
			'gone/away': null
		});
		expect(sent(fetchMock).variables).toEqual({ o0: 'owner', n0: 'repo1', o1: 'gone', n1: 'away' });
	});

	it('throws on any other GraphQL error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					data: { r0: null },
					errors: [{ type: 'RATE_LIMITED', path: ['r0'], message: 'slow down' }]
				})
			)
		);
		await expect(lookupRepos('tok', ['o/r'])).rejects.toThrow('slow down');
	});

	it('makes no request when there is nothing to look up', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		expect(await lookupRepos('tok', [])).toEqual({});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('mutate', () => {
	it('sends typed aliased mutations and reports per-op results', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				data: { m0: { clientMutationId: null }, m1: { list: { id: 'L9' } }, m2: null },
				errors: [{ path: ['m2'], message: 'nope' }]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const out = await mutate('tok', [
			{ kind: 'star', repoId: 'R1' },
			{ kind: 'createList', name: 'Money', description: 'Ways to earn' },
			{ kind: 'setLists', repoId: 'R2', listIds: ['L9'] }
		]);
		expect(out.results).toEqual([true, 'L9', null]);
		expect(out.errors).toEqual(['setLists R2: nope']);
		const body = sent(fetchMock);
		expect(body.query).toContain('$i0: AddStarInput!');
		expect(body.query).toContain('m1: createUserList(input: $i1)');
		expect(body.variables).toEqual({
			i0: { starrableId: 'R1' },
			i1: { name: 'Money', description: 'Ways to earn', isPrivate: false },
			i2: { itemId: 'R2', listIds: ['L9'] }
		});
	});

	it('stops at the first failed request and fails everything after it', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('secondary rate limit', { status: 403 }));
		vi.stubGlobal('fetch', fetchMock);
		const ops = Array.from({ length: 30 }, (_, i) => ({
			kind: 'unstar' as const,
			repoId: `R${i}`
		}));

		const out = await mutate('tok', ops);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(out.results).toEqual(Array(30).fill(null));
		expect(out.errors[0]).toMatch(/403/);
	});
});
