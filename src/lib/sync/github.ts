export interface StarredRepo {
	fullName: string;
	description: string | null;
	htmlUrl: string;
}

/** Fetch ALL starred repos for the authenticated user, following Link-header pagination. */
export async function fetchStarredRepos(token: string): Promise<StarredRepo[]> {
	const repos: StarredRepo[] = [];
	let url: string | null = 'https://api.github.com/user/starred?per_page=100';
	while (url) {
		const res: Response = await fetch(url, {
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${token}`,
				'User-Agent': 'bookmarks-sync'
			}
		});
		if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
		const page = (await res.json()) as Array<{
			full_name: string;
			description: string | null;
			html_url: string;
		}>;
		for (const r of page) {
			repos.push({ fullName: r.full_name, description: r.description, htmlUrl: r.html_url });
		}
		url = res.headers.get('Link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
	}
	return repos;
}
