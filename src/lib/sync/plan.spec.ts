import { describe, it, expect } from 'vitest';
import {
	repoKey,
	keysToLookup,
	planSync,
	REVIEW_NOT_FOUND,
	REVIEW_UNKNOWN_LISTS,
	type Base,
	type Bookmark,
	type PlanInput,
	type Repo
} from './plan';

const repo = (n: number): Repo => ({
	id: `R${n}`,
	url: `https://github.com/owner/repo${n}`,
	fullName: `owner/repo${n}`,
	description: `desc ${n}`
});
const mark = (n: number, tags: string[] = [], extra: Partial<Bookmark> = {}): Bookmark => ({
	id: `b${n}`,
	url: `https://github.com/owner/repo${n}`,
	tags: ['Github', ...tags],
	needsReview: null,
	...extra
});
const entry = (n: number, lists: string[] = []) => ({ key: `owner/repo${n}`, lists });

function plan(p: Partial<PlanInput>) {
	return planSync({
		base: { repos: {} },
		stars: [],
		lists: {},
		bookmarks: [],
		lookups: {},
		vocab: ['Learning Material', 'Job Search'],
		...p
	});
}
const only = (p: ReturnType<typeof plan>, id: string) => {
	const found = p.repos.filter((r) => r.id === id);
	expect(found).toHaveLength(1);
	return found[0];
};

describe('repoKey', () => {
	it.each([
		['https://github.com/Owner/Repo', 'owner/repo'],
		['http://github.com/casey/just', 'casey/just'],
		['https://www.github.com/o/r/', 'o/r'],
		['https://github.com/mvdan/sh#shfmt', 'mvdan/sh'],
		['https://github.com/1Password/shell-plugins/tree/main', '1password/shell-plugins'],
		['https://github.com/o/r.git', 'o/r'],
		['https://github.com/t/s?utm_source=x', 't/s']
	])('%s -> %s', (url, key) => expect(repoKey(url)).toBe(key));

	it.each([
		'https://github.com/openrewrite',
		'https://github.com/pulls?q=is%3Aopen',
		'https://github.com/topics/nix',
		'https://github.com/orgs/acme/repositories',
		'https://gist.github.com/o/abc',
		'https://example.com/o/r',
		'not a url'
	])('%s is not a repo', (url) => expect(repoKey(url)).toBeNull());
});

describe('keysToLookup', () => {
	it('asks only for bookmarks no star or base entry explains, skipping flagged ones', () => {
		const base: Base = { repos: { R2: entry(2) } };
		const bookmarks = [
			mark(1),
			mark(2),
			mark(3),
			mark(4, [], { needsReview: REVIEW_NOT_FOUND }),
			{ ...mark(5), url: 'https://github.com/openrewrite' }
		];
		expect(keysToLookup(base, [repo(1)], bookmarks)).toEqual(['owner/repo3']);
	});
});

describe('planSync membership', () => {
	it('first run: a bookmark that is not starred gets starred, with its tags as lists', () => {
		const p = plan({
			bookmarks: [mark(1, ['Learning Material', 'Videogame'])],
			lookups: { 'owner/repo1': repo(1) }
		});
		const r = only(p, 'R1');
		expect(r.github).toEqual([
			{ kind: 'star' },
			{ kind: 'setLists', lists: ['Learning Material'] }
		]);
		expect(r.rows).toEqual([]);
		expect(r.target).toEqual({ key: 'owner/repo1', lists: ['Learning Material'] });
	});

	it('first run: a star with no bookmark gets one, tagged with its known lists', () => {
		const p = plan({ stars: [repo(1)], lists: { R1: ['Job Search'] } });
		const r = only(p, 'R1');
		expect(r.github).toEqual([]);
		expect(r.rows).toEqual([
			{ op: 'create', repo: repo(1), tags: ['Github', 'Job Search'], needsReview: null }
		]);
		expect(r.target).toEqual({ key: 'owner/repo1', lists: ['Job Search'] });
	});

	it('unstarred on GitHub after a sync: every bookmark of that repo is deleted', () => {
		const anchor = { ...mark(1), id: 'b1-anchor', url: 'https://github.com/owner/repo1#readme' };
		const p = plan({ base: { repos: { R1: entry(1) } }, bookmarks: [mark(1), anchor] });
		const r = only(p, 'R1');
		expect(r.github).toEqual([]);
		expect(r.rows).toEqual([
			{ op: 'delete', bookmarkId: 'b1' },
			{ op: 'delete', bookmarkId: 'b1-anchor' }
		]);
		expect(r.target).toBeNull();
	});

	it('bookmark deleted in life-data after a sync: the repo is unstarred', () => {
		const p = plan({ base: { repos: { R1: entry(1) } }, stars: [repo(1)] });
		const r = only(p, 'R1');
		expect(r.github).toEqual([{ kind: 'unstar' }]);
		expect(r.rows).toEqual([]);
		expect(r.target).toBeNull();
	});

	it('removed on both sides: the base entry is dropped with no writes', () => {
		const r = only(plan({ base: { repos: { R1: entry(1) } } }), 'R1');
		expect(r).toMatchObject({ github: [], rows: [], target: null });
	});

	it('in agreement with nothing to change: no plan entry at all', () => {
		const p = plan({
			base: { repos: { R1: entry(1, ['Job Search']) } },
			stars: [repo(1)],
			lists: { R1: ['Job Search'] },
			bookmarks: [mark(1, ['Job Search'])]
		});
		expect(p.repos).toEqual([]);
	});

	it('a renamed repo still matches its old bookmark through the base entry', () => {
		const renamed = {
			...repo(1),
			url: 'https://github.com/owner/new-name',
			fullName: 'owner/new-name'
		};
		const p = plan({ base: { repos: { R1: entry(1) } }, stars: [renamed], bookmarks: [mark(1)] });
		expect(p.repos).toEqual([]);
	});

	it('a bookmark whose repo does not exist is flagged once and otherwise ignored', () => {
		const p = plan({ bookmarks: [mark(1)], lookups: { 'owner/repo1': null } });
		expect(p.repos).toEqual([]);
		expect(p.reviews).toEqual([{ op: 'update', bookmarkId: 'b1', needsReview: REVIEW_NOT_FOUND }]);
		const again = plan({
			bookmarks: [mark(1, [], { needsReview: REVIEW_NOT_FOUND })],
			lookups: {}
		});
		expect(again.reviews).toEqual([]);
	});
});

describe('planSync lists and tags', () => {
	const synced = (lists: string[], tags: string[], baseLists: string[]) =>
		plan({
			base: { repos: { R1: entry(1, baseLists) } },
			stars: [repo(1)],
			lists: { R1: lists },
			bookmarks: [mark(1, tags)]
		});

	it('added to a list on GitHub: the tag is added', () => {
		const r = only(synced(['Job Search'], [], []), 'R1');
		expect(r.github).toEqual([]);
		expect(r.rows).toEqual([{ op: 'update', bookmarkId: 'b1', tags: ['Github', 'Job Search'] }]);
		expect(r.target).toEqual(entry(1, ['Job Search']));
	});

	it('removed from a list on GitHub: the tag is removed', () => {
		const r = only(synced([], ['Job Search'], ['Job Search']), 'R1');
		expect(r.rows).toEqual([{ op: 'update', bookmarkId: 'b1', tags: ['Github'] }]);
		expect(r.target).toEqual(entry(1, []));
	});

	it('tag added in life-data: the repo joins that list', () => {
		const r = only(synced([], ['Learning Material'], []), 'R1');
		expect(r.github).toEqual([{ kind: 'setLists', lists: ['Learning Material'] }]);
		expect(r.rows).toEqual([]);
	});

	it('tag removed in life-data: the repo leaves that list', () => {
		const r = only(synced(['Job Search'], [], ['Job Search']), 'R1');
		expect(r.github).toEqual([{ kind: 'setLists', lists: [] }]);
	});

	it('both sides changed different lists: both changes survive', () => {
		const r = only(synced(['Job Search'], ['Learning Material'], []), 'R1');
		expect(r.github).toEqual([{ kind: 'setLists', lists: ['Learning Material', 'Job Search'] }]);
		expect(r.rows).toEqual([
			{ op: 'update', bookmarkId: 'b1', tags: ['Github', 'Learning Material', 'Job Search'] }
		]);
	});

	it('a GitHub list with no matching tag is kept on GitHub and flagged on the bookmark', () => {
		const r = only(
			synced(['Mystery', 'Job Search'], ['Learning Material', 'Job Search'], ['Job Search']),
			'R1'
		);
		expect(r.github).toEqual([
			{ kind: 'setLists', lists: ['Learning Material', 'Job Search', 'Mystery'] }
		]);
		expect(r.rows).toEqual([
			{ op: 'update', bookmarkId: 'b1', needsReview: `${REVIEW_UNKNOWN_LISTS}Mystery` }
		]);
	});

	it('clears its own flag once the list has a tag, and leaves other reviews alone', () => {
		const ours = plan({
			base: { repos: { R1: entry(1) } },
			stars: [repo(1)],
			bookmarks: [mark(1, [], { needsReview: `${REVIEW_UNKNOWN_LISTS}Mystery` })]
		});
		expect(only(ours, 'R1').rows).toEqual([{ op: 'update', bookmarkId: 'b1', needsReview: null }]);
		const theirs = plan({
			base: { repos: { R1: entry(1) } },
			stars: [repo(1)],
			bookmarks: [mark(1, [], { needsReview: 'check the description' })]
		});
		expect(theirs.repos).toEqual([]);
	});

	it('a new star in an unknown list is created already flagged', () => {
		const r = only(plan({ stars: [repo(1)], lists: { R1: ['Mystery'] } }), 'R1');
		expect(r.rows).toEqual([
			{
				op: 'create',
				repo: repo(1),
				tags: ['Github'],
				needsReview: `${REVIEW_UNKNOWN_LISTS}Mystery`
			}
		]);
	});
});
