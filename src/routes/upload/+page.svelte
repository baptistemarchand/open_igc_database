<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Upload flights — Open IGC Database</title>
	{#if data.turnstileSiteKey}
		<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
	{/if}
</svelte:head>

<h1>Upload flights</h1>
<p class="lead">
	Select one or more <code>.igc</code> files. They become publicly available for anyone to
	download and use for research.
</p>

<form
	method="POST"
	enctype="multipart/form-data"
	use:enhance={() => {
		submitting = true;
		return async ({ update }) => {
			await update();
			submitting = false;
		};
	}}
>
	<input type="file" name="files" accept=".igc,text/plain" multiple required />

	{#if data.turnstileSiteKey}
		<div class="cf-turnstile" data-sitekey={data.turnstileSiteKey}></div>
	{/if}

	<label class="consent">
		<input type="checkbox" required />
		I have the right to share these flights, and agree to release them into the public domain
		(<a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer"
			>CC0</a
		>).
	</label>

	<button type="submit" disabled={submitting}>
		{submitting ? 'Uploading…' : 'Upload'}
	</button>
</form>

{#if form?.error}
	<p class="err">{form.error}</p>
{/if}

{#if form?.results}
	{@const added = form.results.filter((r) => r.status === 'added').length}
	{@const dup = form.results.filter((r) => r.status === 'duplicate').length}
	{@const errs = form.results.filter((r) => r.status === 'error').length}
	<div class="summary">
		<strong>{added} added</strong>, {dup} already in database, {errs} failed.
	</div>
	<ul class="results">
		{#each form.results as r (r.name)}
			<li class={r.status}>
				<span class="fname">{r.name}</span>
				{#if r.status === 'added'}
					<a href={`/flight/${r.id}`}>added — view flight</a>
				{:else if r.status === 'duplicate'}
					<a href={`/flight/${r.id}`}>already in database — view</a>
				{:else}
					<span class="reason">{r.error}</span>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.lead {
		color: #444;
		max-width: 40rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		align-items: flex-start;
		max-width: 40rem;
		padding: 1.25rem;
		border: 1px solid #e5e5e5;
		border-radius: 10px;
		background: #fff;
	}
	.consent {
		font-size: 0.9rem;
		color: #555;
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}
	button {
		padding: 0.55rem 1.5rem;
		border: none;
		border-radius: 8px;
		background: #0064c8;
		color: #fff;
		font-size: 1rem;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.err {
		color: #c00;
	}
	.summary {
		margin-top: 1.5rem;
	}
	.results {
		list-style: none;
		padding: 0;
		max-width: 40rem;
	}
	.results li {
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		margin-bottom: 0.35rem;
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}
	.results li.added {
		background: #eaf6ea;
	}
	.results li.duplicate {
		background: #f3f3f3;
	}
	.results li.error {
		background: #fbeaea;
	}
	.fname {
		font-family: monospace;
		font-size: 0.9rem;
	}
	.reason {
		color: #a00;
		font-size: 0.9rem;
	}
</style>
