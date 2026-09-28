import { describe, it, expect } from 'vitest';
import { normalizeUrl, diffStars } from './diff';
import type { StarredRepo } from './github';
import type { Bookmark } from './lifedata';

const repo = (fullName: string, htmlUrl: string): StarredRepo => ({
	fullName,
	description: null,
	htmlUrl
});
const bookmark = (url: string): Bookmark => ({ id: `page-${url}`, url });

describe('normalizeUrl', () => {
	it('lowercases the host', () => {
		expect(normalizeUrl('https://GitHub.com/Owner/Repo')).toBe('https://github.com/Owner/Repo');
	});

	it('strips a trailing slash', () => {
		expect(normalizeUrl('https://github.com/owner/repo/')).toBe('https://github.com/owner/repo');
	});

	it('leaves an already-normalized URL unchanged', () => {
		expect(normalizeUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo');
	});

	it('returns non-URL strings unchanged rather than throwing', () => {
		expect(normalizeUrl('not a url')).toBe('not a url');
	});
});

describe('diffStars', () => {
	it('puts everything in toCreate when the DB is empty', () => {
		const stars = [repo('a/b', 'https://github.com/a/b'), repo('c/d', 'https://github.com/c/d')];
		const result = diffStars(stars, []);
		expect(result.toCreate).toEqual(stars);
		expect(result.alreadySynced).toEqual([]);
		expect(result.unstarred).toEqual([]);
	});

	it('matches by normalized URL (case + trailing slash differences)', () => {
		const stars = [repo('a/b', 'https://GitHub.com/a/b/')];
		const existing = [bookmark('https://github.com/a/b')];
		const result = diffStars(stars, existing);
		expect(result.toCreate).toEqual([]);
		expect(result.alreadySynced).toEqual(stars);
		expect(result.unstarred).toEqual([]);
	});

	it('reports bookmarks whose repo is no longer starred as unstarred (never deletes)', () => {
		const existing = [bookmark('https://github.com/old/gone')];
		const result = diffStars([], existing);
		expect(result.toCreate).toEqual([]);
		expect(result.unstarred).toEqual(existing);
	});

	it('is idempotent: a second run after creating everything creates nothing', () => {
		const stars = [repo('a/b', 'https://github.com/a/b'), repo('c/d', 'https://github.com/c/d')];
		const firstRun = diffStars(stars, []);
		// simulate the first run creating a bookmark per toCreate entry
		const dbAfterFirstRun = firstRun.toCreate.map((r) => bookmark(r.htmlUrl));
		const secondRun = diffStars(stars, dbAfterFirstRun);
		expect(secondRun.toCreate).toEqual([]);
		expect(secondRun.alreadySynced).toEqual(stars);
		expect(secondRun.unstarred).toEqual([]);
	});
});
