<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageProps } from './$types';
  import { suspiciousReasons } from '$lib/suspicious';
  import { formatDuration, formatCoord, formatBytes, formatEpochDate, formatHour } from '$lib/format';

  let { data }: PageProps = $props();
  const f = $derived(data.flight);
  const reasons = $derived(suspiciousReasons(f.suspicious));

  let mapEl: HTMLDivElement | undefined = $state();
  // Optimistically show the map box; hidden if the track can't be fetched/parsed.
  let showMap = $state(true);
  let altitude: [number, number][] = $state([]);

  /**
   * Parse valid fixes straight from IGC B-records, client-side. Only lat/lon, time and
   * altitude are needed, so this avoids both a worker-side parse and pulling the full
   * `igc-parser` into the browser bundle. Matches igc-parser's decoding: DDMMmmm /
   * DDDMMmmm minutes-in-thousandths, N/S/E/W sign, and the 'A' (valid) fix-validity flag.
   * Altitude is GPS altitude, falling back to pressure altitude when the logger left GPS at 0.
   */
  function parseTrack(text: string): { coords: [number, number][]; alt: [number, number][] } {
    const coords: [number, number][] = [];
    const alt: [number, number][] = [];
    let day = 0;
    let prev = -1;
    for (const line of text.split('\n')) {
      if (line[0] !== 'B' || line.length < 35 || line[24] !== 'A') continue;
      const lat = (+line.slice(7, 9) + +line.slice(9, 14) / 60000) * (line[14] === 'S' ? -1 : 1);
      const lon = (+line.slice(15, 18) + +line.slice(18, 23) / 60000) * (line[23] === 'W' ? -1 : 1);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      coords.push([lat, lon]);

      // B-record time is UTC time-of-day only: a flight crossing midnight wraps back to 0.
      const tod = +line.slice(1, 3) * 3600 + +line.slice(3, 5) * 60 + +line.slice(5, 7);
      if (prev >= 0 && tod < prev - 3600) day++;
      prev = tod;
      const gps = +line.slice(30, 35);
      const a = gps !== 0 ? gps : +line.slice(25, 30);
      if (Number.isFinite(tod) && Number.isFinite(a)) alt.push([tod + day * 86400, a]);
    }
    return { coords, alt };
  }

  const CHART = { w: 800, h: 220, l: 48, r: 12, t: 12, b: 28 };
  const MAX_CHART_POINTS = 1500;

  /** Round a span up to a "nice" tick step (1/2/5 × 10^n) aiming for ~`n` ticks. */
  function niceStep(span: number, n: number): number {
    const raw = span / n;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const m = raw / pow;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
  }

  // Altitude profile in chart pixel space, plus the axis ticks.
  const chart = $derived.by(() => {
    if (altitude.length < 2) return null;
    const stride = Math.ceil(altitude.length / MAX_CHART_POINTS);
    const pts = altitude.filter((_, i) => i % stride === 0 || i === altitude.length - 1);
    const t0 = pts[0][0];
    const tSpan = Math.max(pts[pts.length - 1][0] - t0, 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, a] of pts) {
      if (a < lo) lo = a;
      if (a > hi) hi = a;
    }
    const aStep = niceStep(Math.max(hi - lo, 1), 4);
    const aMin = Math.floor(lo / aStep) * aStep;
    const aMax = Math.max(Math.ceil(hi / aStep) * aStep, aMin + aStep);
    const x = (t: number) => CHART.l + ((t - t0) / tSpan) * (CHART.w - CHART.l - CHART.r);
    const y = (a: number) => CHART.t + (1 - (a - aMin) / (aMax - aMin)) * (CHART.h - CHART.t - CHART.b);
    const yTicks: { y: number; label: string }[] = [];
    for (let a = aMin; a <= aMax + 1e-9; a += aStep) yTicks.push({ y: y(a), label: `${a}` });
    // Label with local clock time (the takeoff zone) rather than elapsed duration. B-record
    // times are UTC time-of-day, anchored to the flight's UTC date.
    const base = Date.parse(`${f.flight_date}T00:00:00Z`) / 1000;
    const tz = f.takeoff_tz ?? 'UTC';
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date((base + t0) * 1000));
    const p = Object.fromEntries(parts.map((x) => [x.type, +x.value]));
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - (base + t0);
    // Tick on round local times: pick the first step (in seconds) giving at most ~7 ticks.
    const tStep = [300, 600, 900, 1800, 3600, 7200, 10800].find((st) => tSpan / st <= 7) ?? 21600;
    const xTicks: { x: number; label: string }[] = [];
    for (let abs = Math.ceil((base + t0 + offset) / tStep) * tStep - offset; abs <= base + t0 + tSpan; abs += tStep) {
      xTicks.push({ x: x(abs - base), label: fmt.format(new Date(abs * 1000)) });
    }
    return { path: pts.map(([t, a]) => `${x(t).toFixed(1)},${y(a).toFixed(1)}`).join(' '), yTicks, xTicks };
  });

  onMount(() => {
    let map: import('leaflet').Map | undefined;
    // Leaflet touches window/DOM, so load it only in the browser (never during SSR).
    (async () => {
      // Fetch the raw .igc from R2 (or the /f dev fallback) and parse it here, off the
      // worker. Cross-origin R2 reads need a CORS rule allowing this site's origin.
      let track: [number, number][] = [];
      try {
        const res = await fetch(data.downloadUrl);
        if (res.ok) {
          const parsed = parseTrack(await res.text());
          track = parsed.coords;
          altitude = parsed.alt;
        }
      } catch {
        /* leave track empty — map is just omitted */
      }
      if (track.length < 2) {
        showMap = false;
        return;
      }
      if (!mapEl) return;

      const L = (await import('leaflet')).default;
      await import('leaflet/dist/leaflet.css');
      if (!mapEl) return;

      map = L.map(mapEl, { attributionControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      }).addTo(map);

      const line = L.polyline(track, { color: '#2563eb', weight: 3 }).addTo(map);
      map.fitBounds(line.getBounds(), { padding: [20, 20] });

      const dot = (color: string) => ({ radius: 5, color, fillColor: color, fillOpacity: 1, weight: 1 }) as const;
      L.circleMarker(track[0], dot('#16a34a')).addTo(map); // takeoff
      L.circleMarker(track[track.length - 1], dot('#dc2626')).addTo(map); // landing
    })();

    return () => map?.remove();
  });
</script>

<svelte:head>
  <title>Flight {f.flight_date}{f.pilot_name ? ` — ${f.pilot_name}` : ''} — Open IGC Database</title>
</svelte:head>

{#if reasons.length}
  <div class="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-900" role="alert">
    <p class="font-medium">This flight's data looks suspicious and is excluded from the stats.</p>
    <ul class="mt-1 list-disc pl-5">
      {#each reasons as reason (reason)}
        <li>{reason}</li>
      {/each}
    </ul>
  </div>
{/if}

<p class="text-sm"><a href="/browse">← Back to browse</a></p>

<h1 class="my-5">Flight — {f.flight_date}</h1>

<div class="flex flex-col md:flex-row gap-4">
  {#if showMap}
    <div bind:this={mapEl} class="w-full h-64 md:h-auto rounded-lg border border-gray-200"></div>
  {/if}

  <table
    class="w-full max-w-md rounded-lg border border-gray-200 [&_td]:border-b [&_td]:border-gray-100 [&_td]:px-3.5 [&_td]:py-2 [&_th]:w-2/5 [&_th]:border-b [&_th]:border-gray-100 [&_th]:bg-gray-50 [&_th]:px-3.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_th]:text-gray-500"
  >
    <tbody>
      <tr><th>Date</th><td>{f.flight_date}</td></tr>
      <tr><th>Takeoff time</th><td>{formatHour(f.takeoff_hour)}{f.takeoff_tz ? ` (${f.takeoff_tz})` : ''}</td></tr>
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

{#if chart}
  <figure class="mt-4 rounded-lg border border-gray-200 p-3">
    <figcaption class="mb-1 text-sm font-medium text-gray-500">Altitude (m)</figcaption>
    <svg viewBox="0 0 {CHART.w} {CHART.h}" class="w-full" role="img" aria-label="Altitude profile of the flight">
      {#each chart.yTicks as tick (tick.y)}
        <line x1={CHART.l} x2={CHART.w - CHART.r} y1={tick.y} y2={tick.y} stroke="#e5e7eb" />
        <text x={CHART.l - 6} y={tick.y} text-anchor="end" dominant-baseline="middle" font-size="11" fill="#6b7280"
          >{tick.label}</text
        >
      {/each}
      {#each chart.xTicks as tick (tick.x)}
        <text x={tick.x} y={CHART.h - 8} text-anchor="middle" font-size="11" fill="#6b7280">{tick.label}</text>
      {/each}
      <polyline points={chart.path} fill="none" stroke="#2563eb" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
  </figure>
{/if}

<a class="mt-5 inline-block rounded-lg bg-blue-600 px-6 py-2 text-white" href={data.downloadUrl} download
  >Download .igc</a
>
