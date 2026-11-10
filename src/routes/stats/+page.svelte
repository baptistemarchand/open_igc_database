<script lang="ts">
  import { formatDuration, formatEpochDate, formatScore } from '$lib/format';
  import type { PageProps } from './$types';

  const { data }: PageProps = $props();
  const stats = $derived(data.stats);

  const maxCount = $derived(Math.max(1, ...stats.perYear.map((y) => y.count)));
  /** 1,234 -> "1.2k", 14,753 -> "15k"; below 1,000 the number as is. */
  function compact(n: number): string {
    if (n < 1000) return String(n);
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }

  // JSON from the snapshot carries no order: rank by what the chart shows.
  const gliders = $derived([...stats.perGlider].sort((a, b) => b.median - a.median || b.flights - a.flights));
  const maxMedian = $derived(Math.max(1, ...gliders.map((g) => g.median)));

  // Flights are only counted up to the last refresh, so its year is the one that can be partial.
  const partialYear = $derived(String(new Date(stats.computedAt * 1000).getUTCFullYear()));
</script>

<svelte:head>
  <title>Stats · Open IGC Database</title>
</svelte:head>

<h1>Stats</h1>
<p class="muted">Snapshot computed {formatEpochDate(stats.computedAt)}.</p>

<section class="cards">
  <div class="card">
    <div class="label">Flights</div>
    <div class="value">{stats.flightCount.toLocaleString('en')}</div>
  </div>

  {#if stats.longest}
    <a class="card" href="/flight/{stats.longest.id}">
      <div class="label">Longest flight</div>
      <div class="value">{formatDuration(stats.longest.duration_s)}</div>
      <div class="sub">
        {stats.longest.pilot_name ?? 'Unknown pilot'} · {stats.longest.flight_date}
      </div>
    </a>
  {/if}

  {#if stats.highest}
    <a class="card" href="/flight/{stats.highest.id}">
      <div class="label">Highest altitude</div>
      <div class="value">{stats.highest.max_altitude?.toLocaleString('en')} m</div>
      <div class="sub">
        {stats.highest.pilot_name ?? 'Unknown pilot'} · {stats.highest.flight_date}
      </div>
    </a>
  {/if}

  {#if stats.bestXcontest}
    <a class="card" href="/flight/{stats.bestXcontest.id}">
      <div class="label">Best score</div>
      <div class="value">{formatScore(stats.bestXcontest.score_xcontest)}</div>
      <div class="sub">
        {stats.bestXcontest.pilot_name ?? 'Unknown pilot'} · {stats.bestXcontest.flight_date}
      </div>
    </a>
  {/if}
</section>

<h2>Flights per year</h2>
<figure>
  <div class="chart" role="img" aria-label="Bar chart of flights per year">
    {#each stats.perYear as y (y.year)}
      <div class="col" title="{y.year}: {y.count.toLocaleString('en')} flights">
        <span class="count">{compact(y.count)}</span>
        <div class="bar" class:partial={y.year === partialYear} style:height="{(y.count / maxCount) * 100}%"></div>
        <span class="year">{y.year.slice(2)}</span>
      </div>
    {/each}
  </div>
  <figcaption class="muted">The lighter bar is the year of the snapshot, which may be incomplete.</figcaption>
</figure>

{#if gliders.length > 0}
  <h2>Median score by glider</h2>
  <figure>
    <div class="hchart" role="img" aria-label="Bar chart of the median XContest score of the most flown gliders">
      {#each gliders as g (g.slug)}
        <div
          class="hrow"
          title="{g.brand} {g.model}: median {g.median} pts over {g.flights.toLocaleString('en')} flights"
        >
          <span class="hlabel">
            {g.brand}
            {g.model}
            <span class="hsub">{g.flights.toLocaleString('en')} {g.flights === 1 ? 'flight' : 'flights'}</span>
          </span>
          <span class="htrack">
            <span class="hbar" style:width="{(g.median / maxMedian) * 100}%"></span>
            <span class="hvalue">{Math.round(g.median)} pts</span>
          </span>
        </div>
      {/each}
    </div>
    <figcaption class="muted">
      Best median XContest scores among gliders with at least 50 scored flights. A median says as much about who flies a
      glider as about the glider.
    </figcaption>
  </figure>
{/if}

<style>
  .muted {
    color: #777;
    font-size: 0.9rem;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin: 1.5rem 0 2rem;
  }
  .card {
    background: #fff;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    padding: 1rem;
    color: inherit;
    text-decoration: none;
  }
  a.card:hover {
    border-color: #0064c8;
  }
  .label {
    color: #777;
    font-size: 0.85rem;
  }
  .value {
    font-size: 1.8rem;
    font-weight: 700;
  }
  .sub {
    color: #555;
    font-size: 0.9rem;
  }
  figure {
    margin: 0;
  }
  .chart {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 240px;
    padding-top: 1.5rem;
    border-bottom: 1px solid #ccc;
  }
  .col {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    position: relative;
  }
  .bar {
    width: 100%;
    background: #0064c8;
    border-radius: 3px 3px 0 0;
    min-height: 1px;
  }
  .bar.partial {
    opacity: 0.45;
  }
  .count {
    font-size: 0.7rem;
    color: #555;
    margin-bottom: 2px;
  }
  .year {
    position: absolute;
    bottom: -1.4rem;
    font-size: 0.75rem;
    color: #555;
  }
  figcaption {
    margin-top: 2rem;
  }
  figure + h2 {
    margin-top: 2.5rem;
  }
  .hchart {
    display: grid;
    gap: 6px;
    margin-top: 1rem;
  }
  .hrow {
    display: grid;
    grid-template-columns: 13rem 1fr;
    align-items: center;
    gap: 0.75rem;
  }
  .hlabel {
    text-align: right;
    font-size: 0.9rem;
    line-height: 1.2;
  }
  .hsub {
    display: block;
    color: #777;
    font-size: 0.75rem;
  }
  .htrack {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }
  .hbar {
    height: 1.1rem;
    background: #0064c8;
    border-radius: 0 3px 3px 0;
    min-width: 1px;
  }
  .hvalue {
    font-size: 0.8rem;
    color: #555;
    white-space: nowrap;
  }
  .hchart + figcaption {
    margin-top: 1rem;
  }
  /* Too small to read on a phone; the title tooltip still carries the full values. */
  @media (max-width: 600px) {
    .count,
    .year {
      display: none;
    }
    .chart {
      gap: 3px;
    }
    figcaption {
      margin-top: 0.75rem;
    }
    /* Label above its bar: a side column would leave the bars no room. */
    .hrow {
      grid-template-columns: 1fr;
      gap: 2px;
    }
    .hlabel {
      text-align: left;
    }
    .hsub {
      display: inline;
      margin-left: 0.3rem;
    }
  }
</style>
