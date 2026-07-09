<script lang="ts">
  import { page } from '$app/state';

  const origin = $derived(page.url.origin);
</script>

<svelte:head>
  <title>API — Open IGC Database</title>
</svelte:head>

<h1>API</h1>

<p class="intro">
  Open IGC Database exposes a single public, read-only JSON endpoint. No API key or authentication is required.
</p>

<h2><code>GET /flights</code></h2>

<p>Returns every flight in the database as a JSON array, newest first.</p>

<h3>Example</h3>

<pre><code>curl {`${origin}/flights`}</code></pre>

<h3>Response fields</h3>

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Field</th><th>Type</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>id</code></td><td>string</td><td>SHA-256 of the IGC file (also the file key)</td></tr>
      <tr><td><code>flight_date</code></td><td>string</td><td>Flight date, <code>YYYY-MM-DD</code></td></tr>
      <tr><td><code>pilot_name</code></td><td>string | null</td><td>Pilot name from the IGC header</td></tr>
      <tr><td><code>takeoff_lat</code></td><td>number</td><td>Takeoff latitude</td></tr>
      <tr><td><code>takeoff_lon</code></td><td>number</td><td>Takeoff longitude</td></tr>
      <tr><td><code>landing_lat</code></td><td>number</td><td>Landing latitude</td></tr>
      <tr><td><code>landing_lon</code></td><td>number</td><td>Landing longitude</td></tr>
      <tr><td><code>duration_s</code></td><td>number</td><td>Flight duration in seconds</td></tr>
      <tr><td><code>max_altitude</code></td><td>number | null</td><td>Max altitude in metres</td></tr>
      <tr><td><code>point_count</code></td><td>number</td><td>Number of GPS fixes</td></tr>
      <tr><td><code>glider_type</code></td><td>string | null</td><td>Glider model from the IGC header</td></tr>
      <tr><td><code>size_bytes</code></td><td>number</td><td>Size of the IGC file in bytes</td></tr>
      <tr><td><code>uploaded_at</code></td><td>number</td><td>Upload time, epoch seconds</td></tr>
      <tr><td><code>url</code></td><td>string</td><td>Direct link to the raw <code>.igc</code> file</td></tr>
    </tbody>
  </table>
</div>

<h3>Sample response</h3>

<pre><code
    >{`[
  {
    "id": "a1b2c3…",
    "flight_date": "2024-06-15",
    "pilot_name": "Jane Doe",
    "takeoff_lat": 45.9237,
    "takeoff_lon": 6.8694,
    "landing_lat": 45.8992,
    "landing_lon": 6.1294,
    "duration_s": 5432,
    "max_altitude": 2850,
    "point_count": 5431,
    "glider_type": "Ozone Zeno 2",
    "size_bytes": 184320,
    "uploaded_at": 1718460000,
    "url": "https://…/a1b2c3….igc"
  }
]`}</code
  ></pre>

<style>
  .intro {
    color: #444;
  }
  h2 {
    margin-top: 2rem;
  }
  h2 code {
    background: none;
    padding: 0;
    font-size: inherit;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    background: #f0f0f0;
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
  }
  pre {
    background: #f7f7f7;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    padding: 0.9rem 1rem;
    overflow-x: auto;
  }
  pre code {
    background: none;
    padding: 0;
    white-space: pre;
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
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid #eee;
  }
  th {
    background: #f7f7f7;
    font-size: 0.85rem;
  }
</style>
