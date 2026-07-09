<script lang="ts">
  import type { PageProps } from './$types';
  import { formatDuration, formatCoord, formatBytes, formatEpochDate } from '$lib/format';

  let { data }: PageProps = $props();
  const f = $derived(data.flight);
</script>

<svelte:head>
  <title>Flight {f.flight_date}{f.pilot_name ? ` — ${f.pilot_name}` : ''} — Open IGC Database</title>
</svelte:head>

<p class="back"><a href="/browse">← Back to browse</a></p>

<h1>Flight — {f.flight_date}</h1>

<table class="meta">
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

<a class="download" href={data.downloadUrl} download>Download .igc</a>

<style>
  .back {
    font-size: 0.9rem;
  }
  table.meta {
    border-collapse: collapse;
    background: #fff;
    border: 1px solid #e5e5e5;
    border-radius: 10px;
    overflow: hidden;
    max-width: 30rem;
    width: 100%;
  }
  th,
  td {
    padding: 0.55rem 0.9rem;
    text-align: left;
    border-bottom: 1px solid #eee;
  }
  th {
    width: 40%;
    color: #666;
    font-weight: 500;
    background: #fafafa;
  }
  .download {
    display: inline-block;
    margin-top: 1.25rem;
    padding: 0.55rem 1.5rem;
    border-radius: 8px;
    background: #0064c8;
    color: #fff;
    text-decoration: none;
  }
</style>
