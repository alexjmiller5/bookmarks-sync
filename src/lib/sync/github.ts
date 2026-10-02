import type { Repo } from './plan';

const API = 'https://api.github.com';

function headers(token: string) {
	return {
		Accept: 'application/vnd.github+json',
		Authorization: `Bearer ${token}`,
		'User-Agent': 'bookmarks-sync'
	};
}

/** Fetch ALL starred repos for the authenticated user, following Link-header pagination. */
export async function fetchStarredRepos(token: string): Promise<Repo[]> {
	const repos: Repo[] = [];
	let url: string | null = `${API}/user/starred?per_page=100`;
	while (url) {
		const res: Response = await fetch(url, { headers: headers(token) });
		if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
		const page = (await res.json()) as Array<{
			node_id: string;
			full_name: string;
			description: string | null;
			html_url: string;
		}>;
		for (const r of page) {
			repos.push({
				id: r.node_id,
				fullName: r.full_name,
				description: r.description,
				url: r.html_url
			});
		}
		url = res.headers.get('Link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
	}
	return repos;
}

interface GraphqlError {
	message: string;
	type?: string;
	path?: string[];
}

async function graphql<T>(token: string, query: string, variables: Record<string, unknown>) {
	const res = await fetch(`${API}/graphql`, {
		method: 'POST',
		headers: { ...headers(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables })
	});
	if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);
	return (await res.json()) as { data: T | null; errors?: GraphqlError[] };
}

async function query<T>(token: string, q: string, variables: Record<string, unknown>): Promise<T> {
	const out = await graphql<T>(token, q, variables);
	if (out.errors?.length)
		throw new Error(`GitHub GraphQL: ${out.errors.map((e) => e.message).join('; ')}`);
	return out.data as T;
}

interface Page<T> {
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
	nodes: T[];
}
const ITEMS =
	'items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on Repository { id } } }';

export interface GithubList {
	id: string;
	name: string;
	itemIds: string[];
}

/** Every list of the authenticated user with the ids of all its repositories. */
export async function fetchLists(token: string): Promise<GithubList[]> {
	const lists: GithubList[] = [];
	let after: string | null = null;
	do {
		const data: {
			viewer: { lists: Page<{ id: string; name: string; items: Page<{ id?: string }> }> };
		} = await query(
			token,
			`query($after: String) { viewer { lists(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id name ${ITEMS.replace('after: $after', 'after: null')} } } } }`,
			after ? { after } : {}
		);
		for (const list of data.viewer.lists.nodes) {
			const itemIds: string[] = [];
			let items = list.items;
			for (;;) {
				for (const n of items.nodes) if (n.id) itemIds.push(n.id);
				if (!items.pageInfo.hasNextPage) break;
				const more: { node: { items: Page<{ id?: string }> } } = await query(
					token,
					`query($id: ID!, $after: String) { node(id: $id) { ... on UserList { ${ITEMS} } } }`,
					{ id: list.id, after: items.pageInfo.endCursor }
				);
				items = more.node.items;
			}
			lists.push({ id: list.id, name: list.name, itemIds });
		}
		after = data.viewer.lists.pageInfo.hasNextPage ? data.viewer.lists.pageInfo.endCursor : null;
	} while (after);
	return lists;
}

const chunk = <T>(xs: T[], n: number) =>
	Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Resolve `owner/repo` keys to repos; null when GitHub has no such repository. */
export async function lookupRepos(
	token: string,
	keys: string[]
): Promise<Record<string, Repo | null>> {
	const out: Record<string, Repo | null> = {};
	for (const batch of chunk(keys, 50)) {
		const vars: Record<string, string> = {};
		const fields = batch.map((key, i) => {
			const [owner, name] = key.split('/');
			vars[`o${i}`] = owner;
			vars[`n${i}`] = name;
			return `r${i}: repository(owner: $o${i}, name: $n${i}) { id url nameWithOwner description }`;
		});
		const params = batch.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(', ');
		const res = await graphql<
			Record<
				string,
				{ id: string; url: string; nameWithOwner: string; description: string | null } | null
			>
		>(token, `query(${params}) { ${fields.join(' ')} }`, vars);
		const fatal = res.errors?.filter((e) => e.type !== 'NOT_FOUND') ?? [];
		if (fatal.length) throw new Error(`GitHub GraphQL: ${fatal.map((e) => e.message).join('; ')}`);
		batch.forEach((key, i) => {
			const r = res.data?.[`r${i}`];
			out[key] = r
				? { id: r.id, url: r.url, fullName: r.nameWithOwner, description: r.description }
				: null;
		});
	}
	return out;
}

export type Mutation =
	| { kind: 'star'; repoId: string }
	| { kind: 'unstar'; repoId: string }
	| { kind: 'createList'; name: string; description: string }
	| { kind: 'setLists'; repoId: string; listIds: string[] };

function shape(m: Mutation): { field: string; type: string; input: unknown; select: string } {
	switch (m.kind) {
		case 'star':
			return {
				field: 'addStar',
				type: 'AddStarInput',
				input: { starrableId: m.repoId },
				select: 'clientMutationId'
			};
		case 'unstar':
			return {
				field: 'removeStar',
				type: 'RemoveStarInput',
				input: { starrableId: m.repoId },
				select: 'clientMutationId'
			};
		case 'createList':
			return {
				field: 'createUserList',
				type: 'CreateUserListInput',
				input: { name: m.name, description: m.description, isPrivate: false },
				select: 'list { id }'
			};
		case 'setLists':
			return {
				field: 'updateUserListsForItem',
				type: 'UpdateUserListsForItemInput',
				input: { itemId: m.repoId, listIds: m.listIds },
				select: 'clientMutationId'
			};
	}
}
const label = (m: Mutation) => `${m.kind} ${'repoId' in m ? m.repoId : m.name}`;

/**
 * Run mutations in aliased batches of 25. results[i] is true (or the new
 * list id for createList) on success, null on failure. The first failed
 * request (rate limit, auth) stops every later batch.
 */
export async function mutate(token: string, ops: Mutation[]) {
	const results: Array<true | string | null> = Array(ops.length).fill(null);
	const errors: string[] = [];
	let offset = 0;
	for (const batch of chunk(ops, 25)) {
		const shapes = batch.map(shape);
		const q = `mutation(${shapes.map((s, i) => `$i${i}: ${s.type}!`).join(', ')}) { ${shapes
			.map((s, i) => `m${i}: ${s.field}(input: $i${i}) { ${s.select} }`)
			.join(' ')} }`;
		const vars = Object.fromEntries(shapes.map((s, i) => [`i${i}`, s.input]));
		let res: Awaited<ReturnType<typeof graphql<Record<string, { list?: { id: string } } | null>>>>;
		try {
			res = await graphql(token, q, vars);
		} catch (e) {
			errors.push(e instanceof Error ? e.message : String(e));
			break;
		}
		batch.forEach((m, i) => {
			const d = res.data?.[`m${i}`];
			if (d) results[offset + i] = m.kind === 'createList' ? (d.list?.id ?? null) : true;
		});
		for (const e of res.errors ?? []) {
			const i = Number(e.path?.[0]?.slice(1));
			errors.push(Number.isInteger(i) ? `${label(batch[i])}: ${e.message}` : e.message);
		}
		offset += batch.length;
	}
	return { results, errors };
}
