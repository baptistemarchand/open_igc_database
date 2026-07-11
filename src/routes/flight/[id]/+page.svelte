<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageProps } from './$types';
  import { formatDuration, formatCoord, formatBytes, formatEpochDate } from '$lib/format';

  let { data }: PageProps = $props();
  const f = $derived(data.flight);

  let mapEl: HTMLDivElement | undefined = $state();

  onMount(() => {
    if (!mapEl || data.track.length < 2) return;

    let map: import('leaflet').Map | undefined;
    // Leaflet touches window/DOM, so load it only in the browser (never during SSR).
    (async () => {
      const L = (await import('leaflet')).default;
      await import('leaflet/dist/leaflet.css');
      if (!mapEl) return;

      map = L.map(mapEl, { attributionControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }).addTo(map);

      const line = L.polyline(data.track, { color: '#2563eb', weight: 3 }).addTo(map);
      map.fitBounds(line.getBounds(), { padding: [20, 20] });

      const dot = (color: string) => ({ radius: 5, color, fillColor: color, fillOpacity: 1, weight: 1 }) as const;
      L.circleMarker(data.track[0], dot('#16a34a')).addTo(map); // takeoff
      L.circleMarker(data.track[data.track.length - 1], dot('#dc2626')).addTo(map); // landing
    })();

    return () => map?.remove();
  });
</script>

<svelte:head>
  <title>Flight {f.flight_date}{f.pilot_name ? ` — ${f.pilot_name}` : ''} — Open IGC Database</title>
</svelte:head>

<p class="text-sm"><a href="/browse">← Back to browse</a></p>

<h1 class="my-5">Flight — {f.flight_date}</h1>

<div class="flex flex-col md:flex-row gap-4">
  {#if data.track.length > 1}
    <div bind:this={mapEl} class="w-full h-64 md:h-auto rounded-lg border border-gray-200"></div>
  {/if}

  <table
    class="w-full max-w-md rounded-lg border border-gray-200 [&_td]:border-b [&_td]:border-gray-100 [&_td]:px-3.5 [&_td]:py-2 [&_th]:w-2/5 [&_th]:border-b [&_th]:border-gray-100 [&_th]:bg-gray-50 [&_th]:px-3.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-gray-500"
  >
    <tbody>
      <tr><th>Date</th><td>{f.flight_date}</td></tr>
      <tr><th>Pilot</th><td>{f.pilot_name ?? '—'}</td></tr>
      <tr><th>Glider</th><td>{f.glider_type ?? '—'}</td></tr>
      <tr><th>Duration</th><td>{formatDuration(f.duration_s)}</td></tr>
      <tr><th>Max altitude</th><td>{f.max_altitude != null ? `${f.max_altitude} m` : '—'}</td></tr>
      <tr><th>Takeoff</th><td>{formatCoord(f.takeoff_lat, f.takeoff_lon)}</td></tr>
      <tr><th>Landing</th><td>{formatCoord(f.landing_lat, f.landing_lon)}</td></tr>
      <tr><th>GPS fixes</th><td>{f.point_count.toLocaleString()}</td></tr>
      <tr><th>File size</th><td>{formatBytes(f.size_bytes)}</td></tr>
      <tr><th>Uploaded</th><td>{formatEpochDate(f.uploaded_at)}</td></tr>
    </tbody>
  </table>
</div>

<a class="mt-5 inline-block rounded-lg bg-blue-600 px-6 py-2 text-white" href={data.downloadUrl} download
  >Download .igc</a
>
