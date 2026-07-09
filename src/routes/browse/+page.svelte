<script lang="ts">
	import type { PageProps } from './$types';
	import { formatDuration } from '$lib/format';

	let { data }: PageProps = $props();

	const totalPages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));

	/** Build a URL preserving current filters but overriding some params. */
	function link(overrides: Record<string, string | number>): string {
		const p = new URLSearchParams();
		if (data.filters.pilot) p.set('pilot', data.filters.pilot);
		if (data.filters.glider) p.set('glider', data.filters.glider);
		if (data.filters.from) p.set('from', data.filters.from);
		if (data.filters.to) p.set('to', data.filters.to);
		p.set('sort', data.sort);
		p.set('dir', data.dir);
		p.set('page', String(data.page));
		for (const [k, v] of Object.entries(overrides)) p.set(k, String(v));
		return `?${p.toString()}`;
	}

	function sortLink(key: 'date' | 'duration' | 'altitude') {
		const dir = data.sort === key && data.dir === 'desc' ? 'asc' : 'desc';
		return link({ sort: key, dir, page: 1 });
	}

	function sortArrow(key: string) {
		if (data.sort !== key) return '';
		return data.dir === 'desc' ? ' ▼' : ' ▲';
	}
</script>

<svelte:head>
	<title>Browse flights — Open IGC Database</title>
</svelte:head>

<h1>Browse flights</h1>

<form method="GET" class="filters">
	<label>Pilot <input name="pilot" value={data.filters.pilot ?? ''} placeholder="name" /></label>
	<label>Glider <input name="glider" value={data.filters.glider ?? ''} placeholder="model" /></label>
	<label>From <input type="date" name="from" value={data.filters.from ?? ''} /></label>
	<label>To <input type="date" name="to" value={data.filters.to ?? ''} /></label>
	<input type="hidden" name="sort" value={data.sort} />
	<input type="hidden" name="dir" value={data.dir} />
	<button type="submit">Search</button>
	<a class="clear" href="/browse">Clear</a>
</form>

<p class="count">{data.total} flight{data.total === 1 ? '' : 's'}</p>

{#if data.flights.length === 0}
	<p class="empty">No flights match. <a href="/upload">Upload the first one?</a></p>
{:else}
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th><a href={sortLink('date')}>Date{sortArrow('date')}</a></th>
					<th>Pilot</th>
					<th>Glider</th>
					<th class="num"><a href={sortLink('duration')}>Duration{sortArrow('duration')}</a></th>
					<th class="num"><a href={sortLink('altitude')}>Max alt{sortArrow('altitude')}</a></th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each data.flights as f (f.id)}
					<tr>
						<td>{f.flight_date}</td>
						<td>{f.pilot_name ?? '—'}</td>
						<td>{f.glider_type ?? '—'}</td>
						<td class="num">{formatDuration(f.duration_s)}</td>
						<td class="num">{f.max_altitude != null ? `${f.max_altitude} m` : '—'}</td>
						<td><a href={`/flight/${f.id}`}>view</a></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	{#if totalPages > 1}
		<nav class="pager">
			{#if data.page > 1}<a href={link({ page: data.page - 1 })}>← Prev</a>{/if}
			<span>Page {data.page} of {totalPages}</span>
			{#if data.page < totalPages}<a href={link({ page: data.page + 1 })}>Next →</a>{/if}
		</nav>
	{/if}
{/if}

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: flex-end;
		padding: 1rem;
		border: 1px solid #e5e5e5;
		border-radius: 10px;
		background: #fff;
		margin-bottom: 1rem;
	}
	.filters label {
		display: flex;
		flex-direction: column;
		font-size: 0.8rem;
		color: #666;
		gap: 0.2rem;
	}
	.filters input {
		padding: 0.4rem;
		border: 1px solid #ccc;
		border-radius: 6px;
	}
	.filters button {
		padding: 0.45rem 1.1rem;
		border: none;
		border-radius: 6px;
		background: #0064c8;
		color: #fff;
		cursor: pointer;
	}
	.clear {
		font-size: 0.85rem;
		color: #888;
		align-self: center;
	}
	.count {
		color: #666;
		font-size: 0.9rem;
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		background: #fff;
		border: 1px solid #e5e5e5;
		border-radius: 10px;
		overflow: hidden;
	}
	th,
	td {
		padding: 0.55rem 0.75rem;
		text-align: left;
		border-bottom: 1px solid #eee;
		white-space: nowrap;
	}
	th {
		background: #f7f7f7;
		font-size: 0.85rem;
	}
	th a {
		color: #333;
		text-decoration: none;
	}
	.num {
		text-align: right;
	}
	tbody tr:hover {
		background: #f5f9ff;
	}
	.pager {
		display: flex;
		gap: 1rem;
		align-items: center;
		margin-top: 1rem;
		color: #666;
	}
</style>
