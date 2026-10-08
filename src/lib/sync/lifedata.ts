import { repoKey, type Bookmark, type RowOp } from './plan';

export interface HubEnv {
	LIFE_HUB_URL: string;
	LIFE_HUB_TOKEN: string;
	/** Service binding to the hub Worker; a plain fetch is used when absent (tests, local dev). */
	LIFE_HUB?: { fetch: typeof fetch };
}

async function hub<T>(env: HubEnv, path: string, body?: unknown): Promise<T> {
	// Call through the binding object: a detached `fetch` throws Illegal invocation.
	const res = await (env.LIFE_HUB ?? globalThis).fetch(
		`${env.LIFE_HUB_URL.replace(/\/$/, '')}${path}`,
		{
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				Authorization: `Bearer ${env.LIFE_HUB_TOKEN}`,
				'Content-Type': 'application/json',
				'User-Agent': 'bookmarks-sync'
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		}
	);
	if (!res.ok) throw new Error(`life-data ${path} ${res.status}: ${await res.text()}`);
	return (await res.json()) as T;
}

type BookmarkRow = {
	id: string;
	url: string | null;
	tags: string | null;
	needs_review: string | null;
	deleted_at: string | null;
};

/** GitHub repository bookmarks, including tombstones so intentional deletions survive first sync. */
export async function fetchBookmarks(env: HubEnv): Promise<Bookmark[]> {
	// A table-scoped token gets at most 200 rows per pull: walk every page.
	const rows: BookmarkRow[] = [];
	let after: string | undefined;
	do {
		const page = await hub<{ rows: BookmarkRow[]; next_cursor?: string | null }>(
			env,
			'/v1/rows/pull',
			{
				table: 'bookmarks',
				columns: ['id', 'url', 'tags', 'needs_review', 'deleted_at'],
				limit: 200,
				...(after ? { after } : {})
			}
		);
		rows.push(...page.rows);
		after = page.next_cursor ?? undefined;
	} while (after);
	return rows
		.filter((r) => r.url && repoKey(r.url))
		.map((r) => ({
			id: r.id,
			url: r.url as string,
			tags: JSON.parse(r.tags ?? '[]') as string[],
			needsReview: r.needs_review,
			deletedAt: r.deleted_at
		}));
}

/** The bookmarks tag vocabulary that mirrors GitHub lists: every tag except Github. */
export async function fetchListTags(
	env: HubEnv
): Promise<Array<{ name: string; description: string }>> {
	const { options } = await hub<{ options?: Array<{ v: string; d?: string }> }>(
		env,
		'/v1/catalog/options?table=bookmarks&column=tags'
	);
	if (!options?.length) throw new Error('life-data catalog has no bookmarks.tags options');
	return options
		.filter((o) => o.v !== 'Github')
		.map((o) => ({ name: o.v, description: o.d ?? '' }));
}

function toRow(op: RowOp, now: string): Record<string, unknown> {
	switch (op.op) {
		case 'create': {
			const { repo } = op;
			return {
				id: crypto.randomUUID().replace(/-/g, ''),
				url: repo.url,
				title: repo.description ? `${repo.fullName}: ${repo.description}` : repo.fullName,
				// the catalog rejects a trailing period
				description: (repo.description ?? repo.fullName).replace(/\.+$/, ''),
				tags: op.tags,
				needs_review: op.needsReview,
				updated_at: now
			};
		}
		case 'delete':
			return { id: op.bookmarkId, deleted_at: now, updated_at: now };
		case 'update':
			return {
				id: op.bookmarkId,
				...(op.tags ? { tags: op.tags } : {}),
				...(op.needsReview !== undefined ? { needs_review: op.needsReview } : {}),
				updated_at: now
			};
	}
}

/** Push row ops, one request per column set. ok[i] says whether ops[i] landed. */
export async function writeRows(env: HubEnv, ops: RowOp[]) {
	const now = new Date().toISOString();
	const ok: boolean[] = Array(ops.length).fill(false);
	const errors: string[] = [];
	const groups = new Map<string, Array<{ i: number; row: Record<string, unknown> }>>();
	ops.forEach((op, i) => {
		const row = toRow(op, now);
		const cols = Object.keys(row).join(',');
		groups.set(cols, [...(groups.get(cols) ?? []), { i, row }]);
	});
	for (const [cols, items] of groups) {
		try {
			const out = await hub<{ rejected?: Array<{ id?: string; message?: string }> }>(
				env,
				'/v1/rows/push',
				{
					table: 'bookmarks',
					columns: cols.split(','),
					rows: items.map((x) => x.row)
				}
			);
			const rejected = new Map((out.rejected ?? []).map((r) => [r.id, r.message]));
			for (const { i, row } of items) {
				if (rejected.has(row.id as string))
					errors.push(`${row.id}: ${rejected.get(row.id as string)}`);
				else ok[i] = true;
			}
		} catch (e) {
			errors.push(e instanceof Error ? e.message : String(e));
		}
	}
	return { ok, errors };
}
