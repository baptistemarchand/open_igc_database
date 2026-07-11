<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';

  let { form }: PageProps = $props();
  let submitting = $state(false);
  let hasFiles = $state(false);
  // Set when the request fails before reaching our action — e.g. Cloudflare
  // rate-limits the edge and returns a 503 that `enhance` can't deserialize.
  let requestError = $state<string | null>(null);
</script>

<svelte:head>
  <title>Upload flights - Open IGC Database</title>
</svelte:head>

<h1 class="mb-5">Upload flights</h1>
<p class="max-w-xl text-gray-700 mb-5">
  Select one or more <code>.igc</code> files. They become publicly available for anyone to download and use for research.
</p>

<form
  method="POST"
  enctype="multipart/form-data"
  class="flex w-max flex-col items-start gap-4 rounded-lg border border-gray-200 p-5"
  use:enhance={() => {
    submitting = true;
    requestError = null;
    return async ({ result, update }) => {
      // A `type: 'error'` result here means the response never made it back as a
      // SvelteKit action result — typically Cloudflare rate-limiting the edge and
      // returning a 503. Show a friendly message instead of the error boundary.
      if (result.type === 'error' || ('status' in result && result.status === 503)) {
        requestError =
          'The server is temporarily overloaded (too many uploads at once). Please wait a few minutes and try again.';
      } else {
        await update();
      }
      submitting = false;
    };
  }}
>
  <input
    type="file"
    name="files"
    accept=".igc,text/plain"
    multiple
    required
    class="block cursor-pointer w-full text-sm text-gray-500
        file:mr-4 file:py-2 file:px-4 file:rounded-md
        file:border-0 file:text-sm file:font-semibold
        file:bg-blue-50 file:text-blue-700
        hover:file:bg-blue-100"
    onchange={(e) => (hasFiles = e.currentTarget.files !== null && e.currentTarget.files.length > 0)}
  />

  <label class="flex items-start gap-2 text-sm text-gray-600">
    <input type="checkbox" name="anonymous" class="mt-0.5" />
    <span>
      Upload anonymously — remove the pilot and other identifying details from the file, and list it as
      &ldquo;Anonymous&rdquo;.
    </span>
  </label>

  <label class="flex items-start gap-2 text-sm text-gray-600">
    <input type="checkbox" required class="mt-0.5" />
    <span>
      I have the right to share these flights, and agree to release them into the public domain (<a
        href="https://creativecommons.org/publicdomain/zero/1.0/"
        target="_blank"
        rel="noreferrer">CC0</a
      >).<span class="text-red-500 ml-1">*</span>
    </span>
  </label>

  {#if hasFiles}
    <button
      type="submit"
      disabled={submitting}
      class="cursor-pointer rounded-lg bg-blue-600 px-6 py-2 text-white disabled:cursor-default disabled:opacity-60"
    >
      {submitting ? 'Uploading…' : 'Upload'}
    </button>
  {/if}
</form>

{#if requestError}
  <p class="mt-4 rounded-md bg-red-50 px-3 py-2 text-red-700">{requestError}</p>
{:else if form?.error}
  <p class="text-red-600">{form.error}</p>
{/if}

{#if form?.results}
  {@const added = form.results.filter((r) => r.status === 'added').length}
  {@const dup = form.results.filter((r) => r.status === 'duplicate').length}
  {@const errs = form.results.filter((r) => r.status === 'error').length}
  <div class="mt-6 mb-3">
    <strong>{added} added</strong>, {dup} already in database, {errs} failed.
  </div>
  <ul class="w-max list-none p-0">
    {#each form.results as r (r.name)}
      <li
        class="mb-1.5 flex justify-between gap-4 rounded-md px-3 py-2 {r.status === 'added'
          ? 'bg-green-50'
          : r.status === 'duplicate'
            ? 'bg-gray-100'
            : 'bg-red-50'}"
      >
        <span class="font-mono text-sm">{r.name}</span>
        {#if r.status === 'added'}
          <a href={`/flight/${r.id}`}>added — view flight</a>
        {:else if r.status === 'duplicate'}
          <a href={`/flight/${r.id}`}>already in database — view</a>
        {:else}
          <span class="text-sm text-red-700">{r.error}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
