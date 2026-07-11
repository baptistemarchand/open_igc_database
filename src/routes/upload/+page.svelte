<script lang="ts">
  import type { PageProps } from './$types';

  let { form }: PageProps = $props();

  interface FileResult {
    name: string;
    status: 'added' | 'duplicate' | 'error';
    id?: string;
    error?: string;
  }

  let submitting = $state(false);
  let hasFiles = $state(false);
  // Set when a request fails before reaching the ingest — e.g. Cloudflare
  // rate-limits the edge and returns a 503.
  let requestError = $state<string | null>(null);
  // Populated by the JS fan-out path; `form?.results` is the no-JS server-action path.
  let results = $state<FileResult[] | null>(null);
  let done = $state(0);
  let total = $state(0);

  const displayResults = $derived(results ?? form?.results ?? null);
  const added = $derived(displayResults?.filter((r) => r.status === 'added').length ?? 0);
  const dup = $derived(displayResults?.filter((r) => r.status === 'duplicate').length ?? 0);
  const errs = $derived(displayResults?.filter((r) => r.status === 'error').length ?? 0);

  const OVERLOADED_MSG =
    'The server is temporarily overloaded (too many uploads at once). Please wait a few minutes and try again.';

  /**
   * Upload one file via the JSON API (POST /flights), which shares the exact same
   * `ingestIgc` pipeline as the form action. One request per file means one worker
   * invocation per file — each gets its own CPU budget instead of parsing the whole
   * batch on a single, CPU-metered invocation.
   */
  async function uploadOne(file: File, anonymous: boolean, onOverload: () => void): Promise<FileResult> {
    try {
      const res = await fetch(`/flights${anonymous ? '?anonymous=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (res.status === 503) {
        onOverload();
        return { name: file.name, status: 'error', error: 'Server overloaded — try again shortly.' };
      }
      const data = (await res.json().catch(() => ({}))) as { status?: string; id?: string; error?: string };
      if (!res.ok) return { name: file.name, status: 'error', error: data.error ?? `Upload failed (${res.status}).` };
      return { name: file.name, status: data.status === 'duplicate' ? 'duplicate' : 'added', id: data.id };
    } catch {
      return { name: file.name, status: 'error', error: 'Network error.' };
    }
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    const formEl = e.currentTarget as HTMLFormElement;
    const fileInput = formEl.elements.namedItem('files') as HTMLInputElement;
    const files = fileInput.files ? [...fileInput.files].filter((f) => f.size > 0) : [];
    if (files.length === 0) return;
    const anonymous = (formEl.elements.namedItem('anonymous') as HTMLInputElement | null)?.checked ?? false;

    submitting = true;
    requestError = null;
    results = [];
    done = 0;
    total = files.length;
    let sawOverload = false;

    // Fan out a few files at a time so we don't flood the edge, streaming results in as
    // they land. The server action still handles the no-JS path as one batch request.
    const CONCURRENCY = 4;
    const queue = [...files];
    const collected: FileResult[] = [];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const r = await uploadOne(file, anonymous, () => (sawOverload = true));
        collected.push(r);
        results = [...collected];
        done += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

    if (sawOverload) requestError = OVERLOADED_MSG;
    submitting = false;
  }
</script>

<svelte:head>
  <title>Upload flights - Open IGC Database</title>
</svelte:head>

<h1 class="mb-5">Upload flights</h1>
<p class="max-w-xl text-gray-700 mb-5">
  Select one or more <code>.igc</code> files. They become publicly available for anyone to download and use for research.
</p>

<!-- JS path: handleSubmit fans out one request per file. Without JS the form posts
     normally to the server action (single batch request) as a fallback. -->
<form
  method="POST"
  enctype="multipart/form-data"
  class="flex w-max flex-col items-start gap-4 rounded-lg border border-gray-200 p-5"
  onsubmit={handleSubmit}
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
      {submitting ? `Uploading… ${done}/${total}` : 'Upload'}
    </button>
  {/if}
</form>

{#if requestError}
  <p class="mt-4 rounded-md bg-red-50 px-3 py-2 text-red-700">{requestError}</p>
{:else if form?.error}
  <p class="text-red-600">{form.error}</p>
{/if}

{#if displayResults}
  <div class="mt-6 mb-3">
    <strong>{added} added</strong>, {dup} already in database, {errs} failed.
  </div>
  <ul class="w-max list-none p-0">
    {#each displayResults as r (r.name)}
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
