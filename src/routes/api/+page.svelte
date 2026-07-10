<script lang="ts">
  import { page } from '$app/state';

  const origin = $derived(page.url.origin);
</script>

<svelte:head>
  <title>API — Open IGC Database</title>
</svelte:head>

<h1 class="mb-4">API</h1>

<p class="mb-10 text-gray-600">No API key or authentication is required.</p>

<h2 class="mt-12 mb-4 text-xl font-semibold">
  <code class="font-mono">GET /flights</code>
</h2>

<p class="my-4 leading-relaxed">Returns every flight in the database as a JSON array, newest first.</p>

<h3 class="mt-8 mb-3 text-base font-semibold">Example</h3>

<pre class="my-5 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-5"><code
    class="font-mono text-sm whitespace-pre">curl {`${origin}/flights`}</code
  ></pre>

<h3 class="mt-8 mb-3 text-base font-semibold">Response fields</h3>

<div class="my-5 overflow-x-auto">
  <table class="w-full rounded-lg border border-gray-200 text-sm [&_code]:font-mono [&_code]:text-[0.85em]">
    <thead class="bg-gray-50 text-xs">
      <tr class="[&_th]:border-b [&_th]:border-gray-200 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left">
        <th>Field</th><th>Type</th><th>Description</th>
      </tr>
    </thead>
    <tbody class="[&_td]:border-b [&_td]:border-gray-100 [&_td]:px-2.5 [&_td]:py-1.5">
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

<h3 class="mt-8 mb-3 text-base font-semibold">Sample response</h3>

<pre class="my-5 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-5"><code
    class="font-mono text-sm whitespace-pre"
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
