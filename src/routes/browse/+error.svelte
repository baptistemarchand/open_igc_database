<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head>
  <title>Browse flights — Open IGC Database</title>
</svelte:head>

<h1 class="mb-5">Browse flights</h1>

{#if page.status === 503}
  <!-- Cloudflare rate-limits the edge (or the DB is briefly unavailable) and returns
       a 503. Show a friendly message instead of the raw error boundary. -->
  <p class="rounded-md bg-red-50 px-3 py-2 text-red-700">
    The server is temporarily overloaded. Please wait a few minutes and try again.
  </p>
{:else}
  <p class="rounded-md bg-red-50 px-3 py-2 text-red-700">
    {page.error?.message ?? 'Something went wrong.'}
  </p>
{/if}

<p class="mt-4"><a href="/browse">Retry</a></p>
