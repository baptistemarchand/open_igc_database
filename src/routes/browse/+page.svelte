<script lang="ts">
  import { goto } from '$app/navigation';
  import { formatDuration } from '$lib/format';
  import type { PageProps } from './$types';

  const { data }: PageProps = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));

  let pilot = $state(data.filters.pilot ?? '');
  let glider = $state(data.filters.glider ?? '');
  let from = $state(data.filters.from ?? '');
  let to = $state(data.filters.to ?? '');

  const hasFilter = $derived(pilot.trim() !== '' || glider.trim() !== '' || from !== '' || to !== '');

  function clearFilters() {
    pilot = '';
    glider = '';
    from = '';
    to = '';
    goto('/browse');
  }

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

<h1 class="mb-5">Browse flights</h1>

<form method="GET" class="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4">
  <label class="flex flex-col gap-1 text-xs text-gray-500">
    Pilot <input class="rounded-md border border-gray-300 p-1.5" name="pilot" bind:value={pilot} placeholder="name" />
  </label>
  <label class="flex flex-col gap-1 text-xs text-gray-500">
    Glider <input
      class="rounded-md border border-gray-300 p-1.5"
      name="glider"
      bind:value={glider}
      placeholder="model"
    />
  </label>
  <label class="flex flex-col gap-1 text-xs text-gray-500">
    From <input class="rounded-md border border-gray-300 p-1.5" type="date" name="from" bind:value={from} />
  </label>
  <label class="flex flex-col gap-1 text-xs text-gray-500">
    To <input class="rounded-md border border-gray-300 p-1.5" type="date" name="to" bind:value={to} />
  </label>
  <input type="hidden" name="sort" value={data.sort} />
  <input type="hidden" name="dir" value={data.dir} />
  <button
    class="rounded-md bg-blue-600 px-4 py-1.5 text-white disabled:cursor-not-allowed disabled:bg-blue-300"
    type="submit"
    disabled={!hasFilter}>Search</button
  >
  <button class="self-center text-sm text-gray-500" type="button" onclick={clearFilters}>Clear</button>
</form>

<p class="text-sm text-gray-500">{data.total} flight{data.total === 1 ? '' : 's'}</p>

{#if data.flights.length === 0}
  <p>No flights match. <a href="/upload">Upload the first one?</a></p>
{:else}
  <div class="overflow-x-auto">
    <table class="w-full rounded-lg border border-gray-200 [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
      <thead class="bg-gray-50 text-sm [&_a]:text-gray-800">
        <tr class="[&_th]:border-b [&_th]:border-gray-200 [&_th]:p-2 [&_th]:text-left">
          <th><a href={sortLink('date')}>Date{sortArrow('date')}</a></th>
          <th>Pilot</th>
          <th>Glider</th>
          <th class="text-right!"><a href={sortLink('duration')}>Duration{sortArrow('duration')}</a></th>
          <th class="text-right!"><a href={sortLink('altitude')}>Max alt{sortArrow('altitude')}</a></th>
          <th></th>
        </tr>
      </thead>
      <tbody class="[&_td]:border-b [&_td]:border-gray-100 [&_td]:p-2">
        {#each data.flights as f (f.id)}
          <tr class="hover:bg-blue-50">
            <td>{f.flight_date}</td>
            <td>{f.pilot_name ?? '—'}</td>
            <td>{f.glider_type ?? '—'}</td>
            <td class="text-right">{formatDuration(f.duration_s)}</td>
            <td class="text-right">{f.max_altitude != null ? `${f.max_altitude} m` : '—'}</td>
            <td><a href={`/flight/${f.id}`}>view</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if totalPages > 1}
    <nav class="mt-4 flex items-center gap-4 text-gray-500">
      {#if data.page > 1}<a href={link({ page: data.page - 1 })}>← Prev</a>{/if}
      <span>Page {data.page} of {totalPages}</span>
      {#if data.page < totalPages}<a href={link({ page: data.page + 1 })}>Next →</a>{/if}
    </nav>
  {/if}
{/if}
