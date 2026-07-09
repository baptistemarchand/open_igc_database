<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';

	let { children } = $props();

	const links = [
		{ href: '/browse', label: 'Browse' },
		{ href: '/upload', label: 'Upload' }
	];
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header>
	<nav>
		<a class="brand" href="/">Open IGC Database</a>
		<div class="links">
			{#each links as l (l.href)}
				<a href={l.href} class:active={page.url.pathname.startsWith(l.href)}>{l.label}</a>
			{/each}
		</div>
	</nav>
</header>

<main>
	{@render children()}
</main>

<footer>
	<p>
		An open, public database of paragliding IGC tracklogs for research. Uploaded flights are
		public. Please only upload flights you have the right to share.
	</p>
</footer>

<style>
	:global(body) {
		margin: 0;
		font-family:
			system-ui,
			-apple-system,
			Segoe UI,
			Roboto,
			sans-serif;
		color: #1a1a1a;
		background: #fafafa;
		line-height: 1.5;
	}
	:global(*) {
		box-sizing: border-box;
	}
	header {
		border-bottom: 1px solid #e5e5e5;
		background: #fff;
	}
	nav {
		max-width: 900px;
		margin: 0 auto;
		padding: 0.75rem 1rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.brand {
		font-weight: 700;
		text-decoration: none;
		color: #1a1a1a;
	}
	.links a {
		margin-left: 1rem;
		text-decoration: none;
		color: #555;
	}
	.links a.active {
		color: #0064c8;
		font-weight: 600;
	}
	main {
		max-width: 900px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}
	footer {
		max-width: 900px;
		margin: 0 auto;
		padding: 1rem;
		color: #888;
		font-size: 0.85rem;
	}
</style>
