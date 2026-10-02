import { fetchStarredRepos, fetchLists, lookupRepos, mutate, type Mutation } from './github';
import { fetchBookmarks, fetchListTags, writeRows, type HubEnv } from './lifedata';
import { keysToLookup, planSync, type Base, type RepoPlan } from './plan';

/** GitHub writes per run. GitHub's content-creation limits are about 80/min and 500/h. */
export const MAX_GITHUB_WRITES = 50;
/** Repos one run may unstar or un-bookmark before it refuses (guards against a broken read). */
export const MAX_REMOVALS = 20;

export interface SyncEnv extends HubEnv {
	GITHUB_TOKEN: string;
}

/** Where the base (last agreed state) lives: a Durable Object in the Worker. */
export interface StateStore {
	load(): Promise<Base | null>;
	save(base: Base): Promise<void>;
}

export interface SyncSummary {
	trigger: string;
	dryRun: boolean;
	starred: number;
	bookmarked: number;
	planned: {
		star: string[];
		unstar: string[];
		createBookmark: string[];
		deleteBookmark: string[];
		setLists: string[];
		createLists: string[];
		tagUpdates: number;
		reviews: number;
	};
	applied: number; // repos whose every op landed this run
	deferred: string[]; // repos left for the next run by the write budget
	errors: string[];
}

const has = (p: RepoPlan, kind: string) => p.github.some((o) => o.kind === kind);
const names = (ps: RepoPlan[]) => ps.map((p) => p.fullName);

export async function runSync(
	env: SyncEnv,
	state: StateStore,
	opts: { trigger: string; dryRun?: boolean; allowRemovals?: boolean }
): Promise<SyncSummary> {
	const dryRun = opts.dryRun ?? false;
	const base = (await state.load()) ?? { repos: {} };
	const [stars, lists, bookmarks, tags] = await Promise.all([
		fetchStarredRepos(env.GITHUB_TOKEN),
		fetchLists(env.GITHUB_TOKEN),
		fetchBookmarks(env),
		fetchListTags(env)
	]);
	const lookups = await lookupRepos(env.GITHUB_TOKEN, keysToLookup(base, stars, bookmarks));
	const membership: Record<string, string[]> = {};
	for (const l of lists) for (const id of l.itemIds) (membership[id] ??= []).push(l.name);
	const plan = planSync({
		base,
		stars,
		lists: membership,
		bookmarks,
		lookups,
		vocab: tags.map((t) => t.name)
	});

	const listIds = new Map(lists.map((l) => [l.name, l.id]));
	const wanted = (p: RepoPlan) =>
		p.github.flatMap((o) => (o.kind === 'setLists' ? o.lists : [])).filter((n) => !listIds.has(n));

	const summary: SyncSummary = {
		trigger: opts.trigger,
		dryRun,
		starred: stars.length,
		bookmarked: bookmarks.length,
		planned: {
			star: names(plan.repos.filter((p) => has(p, 'star'))),
			unstar: names(plan.repos.filter((p) => has(p, 'unstar'))),
			createBookmark: names(plan.repos.filter((p) => p.rows.some((r) => r.op === 'create'))),
			deleteBookmark: names(plan.repos.filter((p) => p.rows.some((r) => r.op === 'delete'))),
			setLists: names(plan.repos.filter((p) => has(p, 'setLists'))),
			createLists: [...new Set(plan.repos.flatMap(wanted))],
			tagUpdates: plan.repos.flatMap((p) => p.rows).filter((r) => r.op === 'update' && r.tags)
				.length,
			reviews: plan.reviews.length
		},
		applied: 0,
		deferred: [],
		errors: []
	};
	const finish = () => {
		console.log(JSON.stringify({ event: 'sync_run', at: new Date().toISOString(), ...summary }));
		return summary;
	};

	const removals = plan.repos.filter((p) => !p.target && (p.github.length || p.rows.length));
	if (removals.length > MAX_REMOVALS && !opts.allowRemovals) {
		summary.errors.push(
			`refusing to remove ${removals.length} repos in one run (limit ${MAX_REMOVALS}); rerun with allow_removals=true if intended`
		);
		return finish();
	}
	if (dryRun) return finish();

	// life-data writes are cheap and uncapped
	const rows = await writeRows(env, [...plan.reviews, ...plan.repos.flatMap((p) => p.rows)]);
	summary.errors.push(...rows.errors);
	const ok = new Map<string, boolean>();
	let at = plan.reviews.length;
	for (const p of plan.repos) {
		ok.set(p.id, rows.ok.slice(at, at + p.rows.length).every(Boolean));
		at += p.rows.length;
	}

	// GitHub writes, within the budget; new lists count against it too
	let budget = MAX_GITHUB_WRITES;
	const chosen: RepoPlan[] = [];
	const newLists = new Set<string>();
	for (const p of plan.repos.filter((p) => p.github.length)) {
		const need = wanted(p).filter((n) => !newLists.has(n));
		const cost = p.github.length + need.length;
		if (cost > budget) {
			summary.deferred.push(p.fullName);
			ok.set(p.id, false);
			continue;
		}
		budget -= cost;
		chosen.push(p);
		for (const n of need) newLists.add(n);
	}
	if (newLists.size) {
		const describe = new Map(tags.map((t) => [t.name, t.description]));
		const created = [...newLists];
		const res = await mutate(
			env.GITHUB_TOKEN,
			created.map((name) => ({ kind: 'createList', name, description: describe.get(name) ?? '' }))
		);
		summary.errors.push(...res.errors);
		res.results.forEach((id, i) => typeof id === 'string' && listIds.set(created[i], id));
	}
	const ops: Mutation[] = [];
	const owners: string[] = [];
	for (const p of chosen) {
		for (const o of p.github) {
			if (o.kind !== 'setLists') ops.push({ kind: o.kind, repoId: p.id });
			else if (o.lists.every((n) => listIds.has(n)))
				ops.push({ kind: 'setLists', repoId: p.id, listIds: o.lists.map((n) => listIds.get(n)!) });
			else {
				ok.set(p.id, false); // its list could not be created
				continue;
			}
			owners.push(p.id);
		}
	}
	if (ops.length) {
		const res = await mutate(env.GITHUB_TOKEN, ops);
		summary.errors.push(...res.errors);
		res.results.forEach((r, i) => r === null && ok.set(owners[i], false));
	}

	// Advance the base only for repos whose every op landed; the rest re-plan next run.
	const next: Base = { repos: { ...base.repos } };
	for (const p of plan.repos) {
		if (!ok.get(p.id)) continue;
		if (p.target) next.repos[p.id] = p.target;
		else delete next.repos[p.id];
		summary.applied++;
	}
	await state.save(next);
	return finish();
}

/** The Worker's StateStore: the single `github` instance of the SyncState Durable Object. */
export function syncState(ns: {
	getByName(name: string): { load(): Promise<unknown>; save(b: Base): Promise<unknown> };
}): StateStore {
	const stub = ns.getByName('github');
	return {
		load: async () => (await stub.load()) as Base | null,
		save: async (b) => void (await stub.save(b))
	};
}
