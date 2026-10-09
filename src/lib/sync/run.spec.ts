import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSync, MAX_GITHUB_WRITES, MAX_REMOVALS, type StateStore } from './run';
import { fetchStarredRepos, fetchLists, lookupRepos, mutate, type Mutation } from './github';
import { fetchBookmarks, fetchListTags, writeRows } from './somadata';
import type { Base, Bookmark, Repo, RowOp } from './plan';

vi.mock('./github', () => ({
	fetchStarredRepos: vi.fn(),
	fetchLists: vi.fn(),
	lookupRepos: vi.fn(),
	mutate: vi.fn()
}));
vi.mock('./somadata', () => ({
	fetchBookmarks: vi.fn(),
	fetchListTags: vi.fn(),
	writeRows: vi.fn()
}));

const repo = (n: number): Repo => ({
	id: `R${n}`,
	url: `https://github.com/owner/repo${n}`,
	fullName: `owner/repo${n}`,
	description: `desc ${n}`,
	isPrivate: false
});
const mark = (n: number, tags: string[] = []): Bookmark => ({
	id: `b${n}`,
	url: `https://github.com/owner/repo${n}`,
	tags: ['Github', ...tags],
	needsReview: null
});
const env = {
	GITHUB_TOKEN: 'gh',
	GITHUB_PUBLIC_TOKEN: 'public',
	SOMA_HUB_URL: 'https://hub.example',
	SOMA_HUB_TOKEN: 'lt'
};

function memory(initial: Base | null) {
	const store = { saved: undefined as Base | undefined } as StateStore & { saved?: Base };
	store.load = async () => initial;
	store.save = async (b) => {
		store.saved = b;
	};
	return store;
}

function world(w: {
	stars?: Repo[];
	bookmarks?: Bookmark[];
	lists?: { id: string; name: string; itemIds: string[] }[];
}) {
	vi.mocked(fetchStarredRepos).mockResolvedValue(w.stars ?? []);
	vi.mocked(fetchBookmarks).mockResolvedValue(w.bookmarks ?? []);
	vi.mocked(fetchLists).mockResolvedValue(w.lists ?? []);
	vi.mocked(fetchListTags).mockResolvedValue([
		{ name: 'Money', description: 'Ways to earn or save money.' }
	]);
	vi.mocked(lookupRepos).mockImplementation(async (_t, keys) =>
		Object.fromEntries(keys.map((k) => [k, repo(Number(k.replace('owner/repo', '')))]))
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.mocked(writeRows).mockImplementation(async (_e, ops: RowOp[]) => ({
		ok: ops.map(() => true),
		errors: []
	}));
	vi.mocked(mutate).mockImplementation(async (_t, ops: Mutation[]) => ({
		results: ops.map((o) => (o.kind === 'createList' ? `L-${o.name}` : true)),
		errors: []
	}));
});

describe('runSync', () => {
	it('first run unions both sides and saves the agreed base', async () => {
		world({ stars: [repo(1)], bookmarks: [mark(2, ['Money'])] });
		const state = memory(null);

		const s = await runSync(env, state, { trigger: 'test' });

		expect(writeRows).toHaveBeenCalledWith(env, [
			{ op: 'create', repo: repo(1), tags: ['Github'], needsReview: null }
		]);
		expect(vi.mocked(mutate).mock.calls.map((c) => c[1])).toEqual([
			[{ kind: 'createList', name: 'Money', description: 'Ways to earn or save money.' }],
			[
				{ kind: 'star', repoId: 'R2' },
				{ kind: 'setLists', repoId: 'R2', listIds: ['L-Money'] }
			]
		]);
		expect(state.saved).toEqual({
			repos: {
				R1: { key: 'owner/repo1', lists: [] },
				R2: { key: 'owner/repo2', lists: ['Money'] }
			}
		});
		expect(s).toMatchObject({
			dryRun: false,
			planned: { star: ['owner/repo2'], createBookmark: ['owner/repo1'], createLists: ['Money'] },
			applied: 2,
			deferred: [],
			errors: []
		});
	});

	it('dry run plans but never writes or saves', async () => {
		world({ stars: [repo(1)], bookmarks: [mark(2)] });
		const state = memory(null);

		const s = await runSync(env, state, { trigger: 'test', dryRun: true });

		expect(writeRows).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
		expect(state.saved).toBeUndefined();
		expect(s.planned).toMatchObject({ star: ['owner/repo2'], createBookmark: ['owner/repo1'] });
	});

	it('refuses a mass removal unless allowed', async () => {
		const n = MAX_REMOVALS + 1;
		const base: Base = { repos: {} };
		for (let i = 1; i <= n; i++) base.repos[`R${i}`] = { key: `owner/repo${i}`, lists: [] };
		world({ stars: Array.from({ length: n }, (_, i) => repo(i + 1)) });

		const state = memory(base);
		const s = await runSync(env, state, { trigger: 'test' });
		expect(mutate).not.toHaveBeenCalled();
		expect(state.saved).toBeUndefined();
		expect(s.errors[0]).toMatch(/refusing to remove 21/);

		const allowed = await runSync(env, memory(base), { trigger: 'test', allowRemovals: true });
		expect(allowed.planned.unstar).toHaveLength(n);
		expect(mutate).toHaveBeenCalledTimes(1);
	});

	it('spends at most the GitHub write budget and defers the rest to the next run', async () => {
		const n = MAX_GITHUB_WRITES + 10;
		world({ bookmarks: Array.from({ length: n }, (_, i) => mark(i + 1)) });
		const state = memory(null);

		const s = await runSync(env, state, { trigger: 'test' });

		expect(vi.mocked(mutate).mock.calls[0][1]).toHaveLength(MAX_GITHUB_WRITES);
		expect(s.deferred).toHaveLength(10);
		expect(Object.keys(state.saved!.repos)).toHaveLength(MAX_GITHUB_WRITES);
	});

	it('a failed write leaves that repo out of the base so the next run retries it', async () => {
		world({ stars: [repo(1)], bookmarks: [mark(2), mark(3)] });
		vi.mocked(writeRows).mockResolvedValue({ ok: [false], errors: ['row: rejected'] });
		vi.mocked(mutate).mockResolvedValue({ results: [true, null], errors: ['star R3: nope'] });
		const state = memory(null);

		const s = await runSync(env, state, { trigger: 'test' });

		expect(state.saved).toEqual({ repos: { R2: { key: 'owner/repo2', lists: [] } } });
		expect(s.errors).toEqual(['row: rejected', 'star R3: nope']);
		expect(s.applied).toBe(1);
	});

	it('routes public writes to classic and private stars to fine-grained, without settling unsupported lists', async () => {
		const privateRepo = { ...repo(1), isPrivate: true };
		world({ stars: [privateRepo], bookmarks: [mark(2, ['Money']), mark(3, ['Money'])] });
		vi.mocked(lookupRepos).mockResolvedValue({
			'owner/repo2': { ...repo(2), isPrivate: false },
			'owner/repo3': { ...repo(3), isPrivate: true }
		});
		const state = memory({ repos: { R1: { key: 'owner/repo1', lists: [] } } });
		const s = await runSync(env, state, { trigger: 'test' });
		expect(fetchStarredRepos).toHaveBeenCalledWith('gh');
		expect(fetchLists).toHaveBeenCalledWith('gh');
		expect(lookupRepos).toHaveBeenCalledWith('gh', expect.any(Array));
		const calls = vi.mocked(mutate).mock.calls;
		expect(calls.filter(([token]) => token === 'public').flatMap(([, ops]) => ops)).toEqual([
			{ kind: 'createList', name: 'Money', description: 'Ways to earn or save money.' },
			{ kind: 'star', repoId: 'R2' },
			{ kind: 'setLists', repoId: 'R2', listIds: ['L-Money'] }
		]);
		expect(calls.filter(([token]) => token === 'gh').flatMap(([, ops]) => ops)).toEqual([
			{ kind: 'unstar', repoId: 'R1' },
			{ kind: 'star', repoId: 'R3' }
		]);
		expect(s.errors).toEqual([expect.stringMatching(/owner\/repo3.*private.*list/i)]);
		expect(state.saved).toEqual({ repos: { R2: { key: 'owner/repo2', lists: ['Money'] } } });
	});

	it('reports private list restrictions even in dry runs and spends no writes creating their lists', async () => {
		world({ stars: [{ ...repo(1), isPrivate: true }], bookmarks: [mark(1, ['Money'])] });
		const state = memory(null);
		const dry = await runSync(env, state, { trigger: 'test', dryRun: true });
		expect(dry.errors).toEqual([expect.stringMatching(/private.*list/i)]);
		const live = await runSync(env, state, { trigger: 'test' });
		expect(mutate).not.toHaveBeenCalled();
		expect(live.applied).toBe(0);
		expect(state.saved).toEqual({ repos: {} });
	});

	it('does not settle a failed private write when the public batch succeeds', async () => {
		world({ stars: [repo(1), { ...repo(2), isPrivate: true }], bookmarks: [mark(3)] });
		vi.mocked(mutate).mockImplementation(async (token, ops) => ({
			results: ops.map(() => (token === 'gh' ? null : true)),
			errors: token === 'gh' ? ['private write denied'] : []
		}));
		const state = memory({
			repos: {
				R1: { key: 'owner/repo1', lists: [] },
				R2: { key: 'owner/repo2', lists: [] }
			}
		});
		const result = await runSync(env, state, { trigger: 'test' });
		expect(state.saved).toEqual({
			repos: {
				R2: { key: 'owner/repo2', lists: [] },
				R3: { key: 'owner/repo3', lists: [] }
			}
		});
		expect(result.applied).toBe(2);
		expect(result.errors).toEqual(['private write denied']);
	});

	it('refuses missing credentials before any reads or writes', async () => {
		world({});
		await expect(
			runSync({ ...env, GITHUB_PUBLIC_TOKEN: '' }, memory(null), { trigger: 'test' })
		).rejects.toThrow('Both GITHUB_TOKEN and GITHUB_PUBLIC_TOKEN');
		expect(fetchStarredRepos).not.toHaveBeenCalled();
		expect(writeRows).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
	});

	it('emits one structured sync_run log line', async () => {
		world({});
		await runSync(env, memory(null), { trigger: 'cron' });
		const parsed = vi.mocked(console.log).mock.calls.map((c) => JSON.parse(c[0] as string));
		expect(parsed).toContainEqual(
			expect.objectContaining({ event: 'sync_run', trigger: 'cron', errors: [] })
		);
	});
});
