/**
 * Pure two-way planner: GitHub stars <-> live Github bookmarks, and GitHub
 * list membership <-> bookmark tags. A three-way merge against `base`, the
 * state both sides agreed on after the last successful sync: whichever side
 * differs from base changed, so its value wins. An empty base (first run)
 * makes this a union - every star gets a bookmark and every bookmark a star.
 */

export const REVIEW_NOT_FOUND = 'GitHub repository not found; fix the url to sync it';
export const REVIEW_UNKNOWN_LISTS = 'GitHub lists without a matching tag: ';

export interface Repo {
	id: string; // GitHub node id: survives renames and transfers
	url: string;
	fullName: string;
	description: string | null;
	isPrivate: boolean;
}

export interface Bookmark {
	id: string;
	url: string;
	tags: string[];
	needsReview: string | null;
	deletedAt?: string | null;
}

export interface BaseEntry {
	key: string; // repoKey of the bookmark that matched at the last sync
	lists: string[];
}
export interface Base {
	repos: Record<string, BaseEntry>; // repo node id -> agreed state; absent = neither side has it
}

export type GithubOp =
	{ kind: 'star' } | { kind: 'unstar' } | { kind: 'setLists'; lists: string[] };
export type RowOp =
	| { op: 'create'; repo: Repo; tags: string[]; needsReview: string | null }
	| { op: 'delete'; bookmarkId: string }
	| { op: 'update'; bookmarkId: string; tags?: string[]; needsReview?: string | null };

export interface RepoPlan {
	id: string;
	fullName: string;
	github: GithubOp[];
	rows: RowOp[];
	target: BaseEntry | null; // the base entry once every op above has landed
}

export interface PlanInput {
	base: Base;
	stars: Repo[];
	lists: Record<string, string[]>; // repo id -> names of the GitHub lists holding it
	bookmarks: Bookmark[]; // live bookmarks; non-repo urls are ignored
	lookups: Record<string, Repo | null>; // repoKey -> repo, null = GitHub has no such repo
	vocab: string[]; // the tags that mirror GitHub lists, in catalog order
}

export interface Plan {
	repos: RepoPlan[];
	reviews: RowOp[]; // flags on bookmarks that cannot be synced
}

// First path segments of github.com urls that are not owners.
const RESERVED = new Set(
	'about apps collections customer-stories dashboard enterprise events explore features issues login marketplace new notifications orgs organizations pricing pulls readme search security settings site sponsors stars team topics trending users'.split(
		' '
	)
);

/** `owner/repo` (lowercase) for a github.com repository url, else null. */
export function repoKey(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;
	const [owner, name] = url.pathname.split('/').filter(Boolean);
	if (!owner || !name || RESERVED.has(owner.toLowerCase())) return null;
	return `${owner}/${name.replace(/\.git$/i, '')}`.toLowerCase();
}

function keysById(base: Base, stars: Repo[], lookups: Record<string, Repo | null>) {
	const idByKey = new Map<string, string>();
	for (const [id, e] of Object.entries(base.repos)) idByKey.set(e.key, id);
	for (const [key, r] of Object.entries(lookups)) if (r) idByKey.set(key, r.id);
	for (const r of stars) {
		const key = repoKey(r.url);
		if (key) idByKey.set(key, r.id);
	}
	return idByKey;
}

/** Repo keys of bookmarks that neither a star nor the base explains: resolve these first. */
export function keysToLookup(base: Base, stars: Repo[], bookmarks: Bookmark[]): string[] {
	const known = keysById(base, stars, {});
	const keys = new Set<string>();
	for (const b of bookmarks) {
		const key = repoKey(b.url);
		if (!b.deletedAt && key && !known.has(key) && b.needsReview !== REVIEW_NOT_FOUND) keys.add(key);
	}
	return [...keys];
}

const sameSet = (a: string[], b: string[]) =>
	a.length === b.length && a.every((x) => b.includes(x));

function review(current: string | null, unknown: string[]): string | null {
	if (unknown.length) return REVIEW_UNKNOWN_LISTS + unknown.join(', ');
	return current?.startsWith(REVIEW_UNKNOWN_LISTS) ? null : current;
}

export function planSync(inp: PlanInput): Plan {
	const vocab = new Set(inp.vocab);
	const stars = new Map(inp.stars.map((r) => [r.id, r]));
	const idByKey = keysById(inp.base, inp.stars, inp.lookups);
	const info = new Map<string, Repo>();
	for (const r of Object.values(inp.lookups)) if (r) info.set(r.id, r);
	for (const r of inp.stars) info.set(r.id, r);

	const deletedKeys = new Set(inp.bookmarks.filter((b) => b.deletedAt).map((b) => repoKey(b.url)));
	const marks = new Map<string, Array<Bookmark & { key: string }>>();
	const reviews: RowOp[] = [];
	for (const b of inp.bookmarks) {
		const key = repoKey(b.url);
		if (!key || b.deletedAt) continue;
		const id = idByKey.get(key);
		if (id) marks.set(id, [...(marks.get(id) ?? []), { ...b, key }]);
		else if (inp.lookups[key] === null && b.needsReview !== REVIEW_NOT_FOUND)
			reviews.push({ op: 'update', bookmarkId: b.id, needsReview: REVIEW_NOT_FOUND });
	}

	const repos: RepoPlan[] = [];
	const ids = new Set([...Object.keys(inp.base.repos), ...stars.keys(), ...marks.keys()]);
	for (const id of ids) {
		const base = inp.base.repos[id];
		const star = stars.get(id);
		const group = marks.get(id) ?? [];
		const fullName = info.get(id)?.fullName ?? base?.key ?? group[0]?.key ?? id;
		const onGithub = inp.lists[id] ?? [];
		const known = inp.vocab.filter((n) => onGithub.includes(n));
		const unknown = onGithub.filter((n) => !vocab.has(n));
		const tagged = inp.vocab.filter((n) => group.some((b) => b.tags.includes(n)));
		const out: RepoPlan = { id, fullName, github: [], rows: [], target: null };

		if (!star && !group.length) {
			if (base) repos.push(out); // gone on both sides
			continue;
		}
		if (star && !group.length) {
			if (base || deletedKeys.has(repoKey(star.url))) out.github.push({ kind: 'unstar' });
			else {
				out.rows.push({
					op: 'create',
					repo: star,
					tags: ['Github', ...known],
					needsReview: review(null, unknown)
				});
				out.target = { key: repoKey(star.url)!, lists: known };
			}
			repos.push(out);
			continue;
		}
		if (!star) {
			if (base) for (const b of group) out.rows.push({ op: 'delete', bookmarkId: b.id });
			else {
				out.github.push({ kind: 'star' });
				if (tagged.length) out.github.push({ kind: 'setLists', lists: tagged });
				out.target = { key: group[0].key, lists: tagged };
			}
			repos.push(out);
			continue;
		}

		// Both sides have it: merge list membership name by name.
		const was = base?.lists ?? [];
		const lists = inp.vocab.filter((n) => {
			const g = known.includes(n);
			const l = tagged.includes(n);
			return g === l ? g : g !== was.includes(n) ? g : l;
		});
		if (!sameSet(lists, known))
			out.github.push({ kind: 'setLists', lists: [...lists, ...unknown] });
		for (const b of group) {
			const row: RowOp & { op: 'update' } = { op: 'update', bookmarkId: b.id };
			const kept = b.tags.filter((t) => !vocab.has(t) || lists.includes(t));
			const tags = [...kept, ...lists.filter((n) => !kept.includes(n))];
			if (!sameSet(tags, b.tags)) row.tags = tags;
			const flag = review(b.needsReview, unknown);
			if (flag !== b.needsReview) row.needsReview = flag;
			if (row.tags || row.needsReview !== undefined) out.rows.push(row);
		}
		out.target = { key: base?.key ?? group[0].key, lists };
		const settled = base && base.key === out.target.key && sameSet(base.lists, lists);
		if (out.github.length || out.rows.length || !settled) repos.push(out);
	}
	return { repos, reviews };
}
