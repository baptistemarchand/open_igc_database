<script lang="ts">
  import type { PageProps } from './$types';
  import { isZip, listZipEntries } from '$lib/zip';

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

  /** One `.igc` to send: a picked file, or an entry inflated from a picked zip. */
  interface UploadItem {
    name: string;
    read: () => Promise<ArrayBuffer>;
  }

  const OVERLOADED_MSG = 'The server is temporarily overloaded. Please wait a few minutes and try again.';

  /**
   * Upload one file via the JSON API (POST /flights), which shares the exact same
   * `ingestIgc` pipeline as the form action. One request per file means one worker
   * invocation per file — each gets its own CPU budget instead of parsing the whole
   * batch on a single, CPU-metered invocation.
   */
  async function uploadOne(file: UploadItem, anonymous: boolean, onOverload: () => void): Promise<FileResult> {
    // Read the file up front: when it is passed straight as the body, a file the phone
    // can't read (cloud-backed, not downloaded) fails with the same opaque TypeError as a
    // dropped connection, and the two need different fixes from the user.
    let body: ArrayBuffer;
    try {
      body = await file.read();
    } catch (err) {
      console.error(`Could not read ${file.name}`, err);
      return {
        name: file.name,
        status: 'error',
        error: `Could not read the file on this device (${describeError(err)}). If it is stored in the cloud, download it locally first.`,
      };
    }

    let res: Response;
    try {
      res = await fetch(`/flights${anonymous ? '?anonymous=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
    } catch (err) {
      console.error(`Upload of ${file.name} failed before any response`, err);
      return {
        name: file.name,
        status: 'error',
        error: `Network error: no response from the server (${describeError(err)}). Check your connection and keep this page open while uploading.`,
      };
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const cause = describeHttpError(res.status, text);
      if (cause.overloaded) onOverload();
      console.error(`Upload of ${file.name} failed with ${res.status}`, text.slice(0, 500));
      return { name: file.name, status: 'error', error: cause.message };
    }
    const data = parseJson(text) as { status?: string; id?: string };
    return { name: file.name, status: data.status === 'duplicate' ? 'duplicate' : 'added', id: data.id };
  }

  function parseJson(text: string): Record<string, unknown> {
    try {
      const v: unknown = JSON.parse(text);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Errors come from three places: our ingest (`{ error }`), SvelteKit's `error()`
   * (`{ message }`), or Cloudflare itself when the Worker never answered — an HTML or
   * plain-text page carrying a 4-digit code ("Error 1102" / "error code: 1102"). Only the
   * last kind can be a real overload, so only it may raise the page-level banner.
   */
  function describeHttpError(status: number, text: string): { message: string; overloaded: boolean } {
    const data = parseJson(text);
    const own = data.error ?? data.message;
    if (typeof own === 'string' && own) return { message: own, overloaded: false };

    // Plain text for fetch() ("error code: 1102"), or the HTML page's code span.
    const code = /(?:error code:\s*|cf-error-code[^>]*>\s*|\berror\s+)(\d{4})\b/i.exec(text)?.[1];
    if (code === '1102') {
      return {
        message: 'The server ran out of processing time on this file (Cloudflare error 1102). Retrying may work.',
        overloaded: false,
      };
    }
    if (code)
      return {
        message: `Upload failed (HTTP ${status}, Cloudflare error ${code}).`,
        overloaded: status === 503 || status === 429,
      };
    if (status === 503 || status === 429) {
      return { message: `Server overloaded (HTTP ${status}) — try again shortly.`, overloaded: true };
    }
    return { message: `Upload failed (HTTP ${status}).`, overloaded: false };
  }

  /** Browsers word these differently ("Failed to fetch", "Load failed", …), so show theirs. */
  function describeError(err: unknown): string {
    if (err instanceof Error) return err.name === 'TypeError' ? err.message : `${err.name}: ${err.message}`;
    return String(err);
  }

  /**
   * Zips are opened in the browser so each `.igc` inside still gets its own request (and
   * its own worker CPU budget); shipping the archive to the server would put the whole
   * batch on one invocation again. Entries are inflated lazily, one at a time.
   */
  async function expand(files: File[]): Promise<{ items: UploadItem[]; failed: FileResult[] }> {
    const items: UploadItem[] = [];
    const failed: FileResult[] = [];
    for (const file of files) {
      if (!isZip(file)) {
        items.push({ name: file.name, read: () => file.arrayBuffer() });
        continue;
      }
      try {
        const entries = listZipEntries(await file.arrayBuffer()).filter(
          // macOS "Compress" adds __MACOSX/ and ._ resource-fork twins next to every file.
          (e) => /\.igc$/i.test(e.path) && !/(^|\/)(__MACOSX\/|\._)/.test(e.path),
        );
        if (entries.length === 0) {
          failed.push({ name: file.name, status: 'error', error: 'No .igc files found in this zip.' });
        }
        for (const e of entries) items.push({ name: `${file.name}/${e.path}`, read: e.read });
      } catch (err) {
        console.error(`Could not open ${file.name}`, err);
        failed.push({ name: file.name, status: 'error', error: `Could not open the zip (${describeError(err)}).` });
      }
    }
    return { items, failed };
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
    total = 0;
    let sawOverload = false;

    const { items, failed } = await expand(files);
    total = items.length;

    // One file at a time: with 4 in parallel, some files picked from an app's own storage
    // on Android (XCTrack) failed to read with NotFoundError/NotReadableError, while the
    // same files uploaded fine on their own. The server action still handles the no-JS
    // path as one batch request.
    const CONCURRENCY = 1;
    const queue = [...items];
    const collected: FileResult[] = [...failed];
    results = [...collected];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const r = await uploadOne(file, anonymous, () => (sawOverload = true));
        collected.push(r);
        results = [...collected];
        done += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

    if (sawOverload) requestError = OVERLOADED_MSG;
    submitting = false;
  }
</script>

<svelte:head>
  <title>Upload flights - Open IGC Database</title>
</svelte:head>

<h1 class="mb-5">Upload flights</h1>
<p class="max-w-xl text-gray-700 mb-5">
  Select one or more <code>.igc</code> files, or a <code>.zip</code> containing them. They become publicly available for anyone
  to download and use for research.
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
    accept=".igc,text/plain,.zip,application/zip"
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
