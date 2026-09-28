import type { StarredRepo } from './github';

export interface Bookmark {
	id: string;
	url: string;
}

export interface HubEnv {
	LIFE_HUB_URL: string;
	LIFE_HUB_TOKEN: string;
}

function headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
		'User-Agent': 'bookmarks-sync'
	};
}

async function hub<T>(env: HubEnv, path: string, body: unknown): Promise<T> {
	const res = await fetch(`${env.LIFE_HUB_URL.replace(/\/$/, '')}${path}`, {
		method: 'POST',
		headers: headers(env.LIFE_HUB_TOKEN),
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`life-data ${path} ${res.status}: ${await res.text()}`);
	return (await res.json()) as T;
}

/** All live Github-tagged rows of the life-data `bookmarks` table. Rows without a url are skipped. */
export async function fetchGithubBookmarks(env: HubEnv): Promise<Bookmark[]> {
	const data = await hub<{
		rows: Array<{ id: string; url: string | null; tags: string | null; deleted_at: string | null }>;
	}>(env, '/v1/rows/pull', {
		table: 'bookmarks',
		columns: ['id', 'url', 'tags', 'deleted_at'],
		since: ''
	});
	return data.rows
		.filter(
			(r) => !r.deleted_at && r.url && (JSON.parse(r.tags ?? '[]') as string[]).includes('Github')
		)
		.map((r) => ({ id: r.id, url: r.url as string }));
}

/**
 * Field mapping: description = repo
 * description (no trailing period - the catalog rejects one), title =
 * "owner/repo: description", url = html_url, tags = ["Github"] (the catalog
 * requires it on a github.com url). Repos with no description use fullName.
 */
export async function createBookmark(env: HubEnv, repo: StarredRepo): Promise<void> {
	const id = crypto.randomUUID().replace(/-/g, '');
	const row = {
		id,
		url: repo.htmlUrl,
		title: repo.description ? `${repo.fullName}: ${repo.description}` : repo.fullName,
		description: (repo.description ?? repo.fullName).replace(/\.+$/, ''),
		tags: ['Github'],
		updated_at: new Date().toISOString()
	};
	const out = await hub<{ rejected?: Array<{ col?: string; message?: string }> }>(
		env,
		'/v1/rows/push',
		{
			table: 'bookmarks',
			columns: Object.keys(row),
			rows: [row]
		}
	);
	if (out.rejected?.length) {
		throw new Error(`life-data rejected ${repo.fullName}: ${out.rejected[0].message}`);
	}
}
