import { fetchStarredRepos } from './github';
import { fetchGithubBookmarks, createBookmark } from './lifedata';
import { diffStars } from './diff';

export interface SyncEnv {
	GITHUB_TOKEN: string;
	LIFE_HUB_URL: string;
	LIFE_HUB_TOKEN: string;
}

export interface SyncSummary {
	trigger: string;
	dryRun: boolean;
	starred: number;
	created: number;
	skipped: number;
	toCreate: string[]; // repo fullNames not yet in life-data
	unstarred: string[]; // bookmark URLs no longer starred — reported, never deleted
	errors: string[];
}

/** Full sync run: fetch stars + bookmarks, diff, create the missing ones. */
export async function runSync(
	env: SyncEnv,
	opts: { trigger: string; dryRun?: boolean }
): Promise<SyncSummary> {
	const dryRun = opts.dryRun ?? false;
	const [starred, existing] = await Promise.all([
		fetchStarredRepos(env.GITHUB_TOKEN),
		fetchGithubBookmarks(env)
	]);
	const diff = diffStars(starred, existing);

	let created = 0;
	const errors: string[] = [];
	if (!dryRun) {
		// ponytail: sequential pushes - one row per request keeps a rejection attributable
		for (const repo of diff.toCreate) {
			try {
				await createBookmark(env, repo);
				created++;
			} catch (e) {
				errors.push(`${repo.fullName}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	const summary: SyncSummary = {
		trigger: opts.trigger,
		dryRun,
		starred: starred.length,
		created,
		skipped: diff.alreadySynced.length,
		toCreate: diff.toCreate.map((r) => r.fullName),
		unstarred: diff.unstarred.map((b) => b.url),
		errors
	};
	console.log(JSON.stringify({ event: 'sync_run', at: new Date().toISOString(), ...summary }));
	return summary;
}
