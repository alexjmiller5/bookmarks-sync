import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSync } from './run';
import { fetchStarredRepos, type StarredRepo } from './github';
import { fetchGithubBookmarks, createBookmark, type Bookmark } from './lifedata';

vi.mock('./github', () => ({ fetchStarredRepos: vi.fn() }));
vi.mock('./lifedata', () => ({ fetchGithubBookmarks: vi.fn(), createBookmark: vi.fn() }));

const repo = (n: number): StarredRepo => ({
	fullName: `owner/repo${n}`,
	description: `desc ${n}`,
	htmlUrl: `https://github.com/owner/repo${n}`
});
const bookmark = (n: number): Bookmark => ({
	id: `row-${n}`,
	url: `https://github.com/owner/repo${n}`
});

const env = { GITHUB_TOKEN: 'gh', LIFE_HUB_URL: 'https://hub.example', LIFE_HUB_TOKEN: 'lt' };

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('runSync', () => {
	it('creates bookmarks for new stars and counts skipped/unstarred', async () => {
		vi.mocked(fetchStarredRepos).mockResolvedValue([repo(1), repo(2)]);
		vi.mocked(fetchGithubBookmarks).mockResolvedValue([bookmark(2), bookmark(3)]);
		vi.mocked(createBookmark).mockResolvedValue();

		const summary = await runSync(env, { trigger: 'test' });

		expect(createBookmark).toHaveBeenCalledTimes(1);
		expect(createBookmark).toHaveBeenCalledWith(env, repo(1));
		expect(summary).toMatchObject({
			trigger: 'test',
			dryRun: false,
			created: 1,
			skipped: 1,
			toCreate: ['owner/repo1'],
			unstarred: ['https://github.com/owner/repo3'],
			errors: []
		});
	});

	it('dry run never writes but still reports toCreate/unstarred', async () => {
		vi.mocked(fetchStarredRepos).mockResolvedValue([repo(1)]);
		vi.mocked(fetchGithubBookmarks).mockResolvedValue([bookmark(9)]);

		const summary = await runSync(env, { trigger: 'test', dryRun: true });

		expect(createBookmark).not.toHaveBeenCalled();
		expect(summary).toMatchObject({
			dryRun: true,
			created: 0,
			toCreate: ['owner/repo1'],
			unstarred: ['https://github.com/owner/repo9']
		});
	});

	it('a failed create is recorded as an error and the rest still run', async () => {
		vi.mocked(fetchStarredRepos).mockResolvedValue([repo(1), repo(2)]);
		vi.mocked(fetchGithubBookmarks).mockResolvedValue([]);
		vi.mocked(createBookmark)
			.mockRejectedValueOnce(new Error('life-data /v1/rows/push 500: boom'))
			.mockResolvedValueOnce();

		const summary = await runSync(env, { trigger: 'test' });

		expect(createBookmark).toHaveBeenCalledTimes(2);
		expect(summary.created).toBe(1);
		expect(summary.errors).toEqual(['owner/repo1: life-data /v1/rows/push 500: boom']);
	});

	it('emits one structured log line with the summary', async () => {
		vi.mocked(fetchStarredRepos).mockResolvedValue([]);
		vi.mocked(fetchGithubBookmarks).mockResolvedValue([]);

		await runSync(env, { trigger: 'cron' });

		const logged = vi.mocked(console.log).mock.calls.map((c) => c[0]);
		const parsed = logged.map((l) => JSON.parse(l as string));
		expect(parsed).toContainEqual(
			expect.objectContaining({ event: 'sync_run', trigger: 'cron', created: 0, errors: [] })
		);
	});
});
