<!-- ponytail: static page — a live last-run summary needs storage (R2/KV) or a
     GET that re-runs the whole GitHub+Notion diff per page view; skipped for MVP.
     Run history lives in `just logs` (structured sync_run lines) instead. -->
<main class="mx-auto max-w-md p-8">
	<h1 class="text-2xl font-semibold">bookmarks-sync</h1>
	<p class="mt-2 opacity-60">One-way sync: GitHub starred repos → Notion Bookmarks DB.</p>
	<p class="mt-4">Runs daily at 06:00 UTC (CF cron), or on demand via POST /api/sync.</p>
	<p class="mt-2 opacity-60"><code>just logs</code> shows run history (sync_run lines).</p>
</main>
