import type { StarredRepo } from './github';
import type { Bookmark } from './lifedata';

/** Canonical form for URL matching: lowercase host, no trailing slash. */
export function normalizeUrl(raw: string): string {
	try {
		return new URL(raw).toString().replace(/\/$/, ''); // URL lowercases the host for us
	} catch {
		return raw; // ponytail: non-URL strings pass through; they just never match anything
	}
}

export interface DiffResult {
	toCreate: StarredRepo[];
	alreadySynced: StarredRepo[];
	unstarred: Bookmark[]; // NEVER deleted — logged only; bookmarks may be kept intentionally
}

/** Pure diff of GitHub stars vs existing life-data bookmarks, keyed by normalized URL. */
export function diffStars(starred: StarredRepo[], existing: Bookmark[]): DiffResult {
	const existingByUrl = new Set(existing.map((b) => normalizeUrl(b.url)));
	const starredUrls = new Set(starred.map((r) => normalizeUrl(r.htmlUrl)));
	return {
		toCreate: starred.filter((r) => !existingByUrl.has(normalizeUrl(r.htmlUrl))),
		alreadySynced: starred.filter((r) => existingByUrl.has(normalizeUrl(r.htmlUrl))),
		unstarred: existing.filter((b) => !starredUrls.has(normalizeUrl(b.url)))
	};
}
