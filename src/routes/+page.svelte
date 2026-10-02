<!-- ponytail: static page; a live last-run summary would need the Durable Object
     exposed over GET. Run history lives in `just logs` (structured sync_run lines). -->
<main class="mx-auto max-w-md p-8">
	<h1 class="text-2xl font-semibold">bookmarks-sync</h1>
	<p class="mt-2 opacity-60">
		Two-way sync: GitHub stars and lists with the life-data bookmarks table and its tags.
	</p>
	<p class="mt-4">Runs hourly (CF cron), or on demand via POST /api/sync.</p>
	<p class="mt-2 opacity-60"><code>just logs</code> shows run history (sync_run lines).</p>
</main>
