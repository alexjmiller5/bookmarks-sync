import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server';
import { runSync, syncState } from '$lib/sync/run';

vi.mock('$lib/sync/run', () => ({ runSync: vi.fn(), syncState: vi.fn(() => 'state') }));

function event(opts: { token?: string; env?: Record<string, unknown>; url?: string }) {
	const headers = new Headers(opts.token ? { authorization: `Bearer ${opts.token}` } : {});
	return {
		request: new Request(opts.url ?? 'https://x.test/api/sync', { method: 'POST', headers }),
		platform: {
			env: opts.env ?? { SYNC_TOKEN: 'sekrit', GITHUB_TOKEN: 'gh', SYNC_STATE: 'ns' }
		}
		// ponytail: cast — the real RequestEvent carries far more than the handler reads
	} as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/sync', () => {
	it('rejects a missing token with 401 and never runs the sync', async () => {
		await expect(POST(event({}))).rejects.toMatchObject({ status: 401 });
		expect(runSync).not.toHaveBeenCalled();
	});

	it('rejects a wrong token with 401', async () => {
		await expect(POST(event({ token: 'nope' }))).rejects.toMatchObject({ status: 401 });
		expect(runSync).not.toHaveBeenCalled();
	});

	it('500s when SYNC_TOKEN is not configured (never open by default)', async () => {
		await expect(POST(event({ token: 'sekrit', env: {} }))).rejects.toMatchObject({
			status: 500
		});
	});

	it('runs the sync and returns the summary for a valid token', async () => {
		vi.mocked(runSync).mockResolvedValue({ created: 1 } as never);
		const res = await POST(event({ token: 'sekrit' }));
		expect(await res.json()).toMatchObject({ created: 1 });
		expect(syncState).toHaveBeenCalledWith('ns');
		expect(runSync).toHaveBeenCalledWith(
			expect.objectContaining({ GITHUB_TOKEN: 'gh' }),
			'state',
			expect.objectContaining({ trigger: 'manual', dryRun: false, allowRemovals: false })
		);
	});

	it('passes dry_run and allow_removals through', async () => {
		vi.mocked(runSync).mockResolvedValue({} as never);
		await POST(
			event({ token: 'sekrit', url: 'https://x.test/api/sync?dry_run=true&allow_removals=true' })
		);
		expect(runSync).toHaveBeenCalledWith(
			expect.anything(),
			'state',
			expect.objectContaining({ dryRun: true, allowRemovals: true })
		);
	});
});
