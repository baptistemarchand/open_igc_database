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

<p class="my-4 leading-relaxed">
  Returns one page of flights, newest first. Up to <code class="font-mono">limit</code> flights per response (default
  and max <code class="font-mono">1000</code>); pass <code class="font-mono">offset</code> to skip ahead. Follow the
  <code class="font-mono">next</code> URL in the response, requesting it as-is, until it's
  <code class="font-mono">null</code>, to iterate the whole dataset.
</p>

<p class="my-4 leading-relaxed">
  By default each flight contains only <code class="font-mono">url</code>, a direct link to the
  <code class="font-mono">.igc</code> file. Use <code class="font-mono">fields</code> to ask for more.
</p>

<h3 class="mt-8 mb-3 text-base font-semibold">Query parameters</h3>

<div class="my-5 overflow-x-auto">
  <table class="w-full rounded-lg border border-gray-200 text-sm [&_code]:font-mono [&_code]:text-[0.85em]">
    <thead class="bg-gray-50 text-xs">
      <tr class="[&_th]:border-b [&_th]:border-gray-200 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left">
        <th>Param</th><th>Default</th><th>Description</th>
      </tr>
    </thead>
    <tbody class="[&_td]:border-b [&_td]:border-gray-100 [&_td]:px-2.5 [&_td]:py-1.5">
      <tr
        ><td><code>limit</code></td><td><code>1000</code></td><td
          >Flights to return, <code>1</code>–<code>1000</code></td
        ></tr
      >
      <tr><td><code>offset</code></td><td><code>0</code></td><td>Number of flights to skip</td></tr>
      <tr><td><code>fields</code></td><td><code>url</code></td><td>Which flight fields to return (see below)</td></tr>
    </tbody>
  </table>
</div>

<h3 class="mt-8 mb-3 text-base font-semibold">Choosing fields</h3>

<p class="my-4 leading-relaxed">
  <code class="font-mono">fields</code> takes a comma-separated list of the field names in the table below — for example
  <code class="font-mono">fields=id,flight_date,url</code>. Pass
  <code class="font-mono">fields=all</code> for every field. Only what you ask for is read from the database and sent
  back, so requesting less is faster and cheaper for both of us. An unrecognised field name is an error (<code
    class="font-mono">400</code
  >) rather than being ignored, so typos don't silently return the wrong shape.
</p>

<p class="my-4 leading-relaxed">
  Fields come back in the order listed in the table, whatever order you ask for them in, and
  <code class="font-mono">fields</code> is carried over into the <code class="font-mono">next</code> URL — so paging keeps
  your selection without you re-adding it.
</p>

<p class="my-4 leading-relaxed rounded-lg border border-amber-200 bg-amber-50 p-4">
  <strong class="font-semibold">Changed:</strong> this endpoint used to return every field by default. If you have an
  existing integration that reads anything other than <code class="font-mono">url</code>, add
  <code class="font-mono">?fields=all</code> to restore the old response, or better, list just the fields you use.
</p>

<h3 class="mt-8 mb-3 text-base font-semibold">Examples</h3>

<pre class="my-5 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-5"><code
    class="font-mono text-sm whitespace-pre"
    >curl {`${origin}/flights`}
curl "{`${origin}/flights?fields=id,flight_date,duration_s,url`}"
curl "{`${origin}/flights?fields=all&limit=10`}"</code
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
      <tr><td><code>flights</code></td><td>array</td><td>Flight objects for this page (fields below)</td></tr>
      <tr><td><code>total</code></td><td>number</td><td>Total number of flights in the database</td></tr>
      <tr><td><code>limit</code></td><td>number</td><td>Effective limit used for this page</td></tr>
      <tr><td><code>offset</code></td><td>number</td><td>Effective offset used for this page</td></tr>
      <tr
        ><td><code>next</code></td><td>string | null</td><td
          >URL for the next page, or <code>null</code> if this was the last one</td
        ></tr
      >
    </tbody>
  </table>
</div>

<p class="my-4 leading-relaxed">
  Every name below is a valid <code class="font-mono">fields</code> value. Each object in
  <code class="font-mono">flights</code> contains exactly the ones you selected:
</p>

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
      <tr
        ><td><code>takeoff_hour</code></td><td>number | null</td><td
          >Local hour of day at takeoff, 0–23 (null for flights stored before this field existed)</td
        ></tr
      >
      <tr
        ><td><code>takeoff_tz</code></td><td>string | null</td><td
          >IANA time zone at takeoff, e.g. <code>Europe/Paris</code></td
        ></tr
      >
      <tr
        ><td><code>url</code></td><td>string</td><td
          >Direct link to the <code>.igc</code> file (the default; see note below)</td
        ></tr
      >
    </tbody>
  </table>
</div>

<p class="my-4 leading-relaxed">
  The file behind <code class="font-mono">url</code> is stored and served gzip-compressed (<code class="font-mono"
    >Content-Encoding: gzip</code
  >). Browsers and <code class="font-mono">fetch</code>
  decode this automatically; with <code class="font-mono">curl</code> or <code class="font-mono">wget</code>
  add <code class="font-mono">--compressed</code> or you'll get the raw gzip bytes:
</p>

<pre class="my-5 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-5"><code
    class="font-mono text-sm whitespace-pre">curl --compressed -o flight.igc "https://…/a1b2c3….igc"</code
  ></pre>

<h3 class="mt-8 mb-3 text-base font-semibold">Sample response</h3>

<p class="my-4 leading-relaxed">Default (<code class="font-mono">GET /flights</code>):</p>

<pre class="my-5 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-5"><code
    class="font-mono text-sm whitespace-pre"
    >{`{
  "flights": [
    { "url": "https://…/a1b2c3….igc" },
    { "url": "https://…/d4e5f6….igc" }
  ],
  "total": 4213,
  "limit": 1000,
  "offset": 0,
  "next": "https://…/flights?limit=1000&offset=1000"
}`}</code
  ></pre>

<p class="my-4 leading-relaxed">
  With <code class="font-mono">?fields=all</code> (the <code class="font-mono">flights</code> array only, other fields unchanged):
</p>

<pre class="my-5 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-5"><code
    class="font-mono text-sm whitespace-pre"
    >{`  "flights": [
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
      "takeoff_hour": 14,
      "takeoff_tz": "Europe/Paris",
      "url": "https://…/a1b2c3….igc"
    }
  ],`}</code
  ></pre>

<h2 class="mt-16 mb-4 text-xl font-semibold">
  <code class="font-mono">POST /flights</code>
</h2>

<p class="my-4 leading-relaxed">
  Upload a single <code class="font-mono">.igc</code> file, sent as the raw request body. The file is parsed, validated and
  stored. Flights are deduplicated by content, so re-uploading the same track is safe.
</p>

<p class="my-4 leading-relaxed">
  Add <code class="font-mono">?anonymous=1</code> to strip identifying headers (pilot, crew, glider registration,
  competition id) before storing and list the pilot as
  <code class="font-mono">Anonymous</code>.
</p>

<h3 class="mt-8 mb-3 text-base font-semibold">Example</h3>

<pre class="my-5 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-5"><code
    class="font-mono text-sm whitespace-pre"
    >curl --data-binary @flight.igc -H "Content-Type: application/octet-stream" {`${origin}/flights`}</code
  ></pre>

<h3 class="mt-8 mb-3 text-base font-semibold">Responses</h3>

<div class="my-5 overflow-x-auto">
  <table class="w-full rounded-lg border border-gray-200 text-sm [&_code]:font-mono [&_code]:text-[0.85em]">
    <thead class="bg-gray-50 text-xs">
      <tr class="[&_th]:border-b [&_th]:border-gray-200 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left">
        <th>Status</th><th>Meaning</th>
      </tr>
    </thead>
    <tbody class="[&_td]:border-b [&_td]:border-gray-100 [&_td]:px-2.5 [&_td]:py-1.5">
      <tr><td><code>201</code></td><td>Flight added</td></tr>
      <tr><td><code>200</code></td><td>Duplicate — this track was already stored</td></tr>
      <tr><td><code>400</code></td><td>Empty body or not a valid IGC track (see <code>error</code>)</td></tr>
    </tbody>
  </table>
</div>

<p class="my-4 leading-relaxed">
  On success the response is the full flight object — every field listed above, as with
  <code class="font-mono">?fields=all</code> — plus a <code class="font-mono">status</code> field of
  <code class="font-mono">"added"</code> or <code class="font-mono">"duplicate"</code>. There is no
  <code class="font-mono">fields</code> param here; it's a single row, so it's always sent in full.
</p>

<h3 class="mt-8 mb-3 text-base font-semibold">Sample response</h3>

<pre class="my-5 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-5"><code
    class="font-mono text-sm whitespace-pre"
    >{`{
  "status": "added",
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
  "takeoff_hour": 14,
  "takeoff_tz": "Europe/Paris",
  "url": "https://…/a1b2c3….igc"
}`}</code
  ></pre>
