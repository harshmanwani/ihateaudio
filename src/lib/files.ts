/** File input, drag and drop, and saving. Browser-only. */

/** Extensions we accept. Anything not decodable natively routes through ffmpeg. */
export const AUDIO_EXTENSIONS = [
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff',
  'aif', 'aifc', 'amr', 'caf', 'weba', 'webm', '3gp', 'ac3', 'ape', 'm4b',
];

export const VIDEO_EXTENSIONS = [
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'mpg', 'mpeg',
];

export const AUDIO_ACCEPT = `audio/*,${AUDIO_EXTENSIONS.map((e) => `.${e}`).join(',')}`;
export const MEDIA_ACCEPT = `audio/*,video/*,${[...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]
  .map((e) => `.${e}`)
  .join(',')}`;

export function isProbablyMedia(file: File): boolean {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true;
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext) || VIDEO_EXTENSIONS.includes(ext);
}

/** Triggers a download. Revoking on a timeout is required for Safari. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari aborts the download if the object URL is revoked immediately.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export interface DropHandlers {
  onFiles: (files: File[]) => void;
  /** Reject extra files when a tool only handles one. */
  multiple?: boolean;
}

/**
 * Wires a dropzone: click, keyboard, drag/drop, paste, and a page-wide drag
 * overlay so a file dropped anywhere on the page still lands.
 */
export function attachDropzone(
  zone: HTMLElement,
  input: HTMLInputElement,
  handlers: DropHandlers
): () => void {
  const { onFiles, multiple = false } = handlers;
  let depth = 0;

  const take = (list: FileList | null | undefined): void => {
    if (!list || list.length === 0) return;
    const files = Array.from(list).filter(isProbablyMedia);
    if (files.length === 0) return;
    onFiles(multiple ? files : [files[0]]);
  };

  const onChange = (): void => {
    take(input.files);
    // Reset so selecting the same file twice still fires.
    input.value = '';
  };

  const onClick = (event: MouseEvent): void => {
    // Let real controls inside the zone work normally.
    if ((event.target as HTMLElement).closest('button, a, label, input')) return;
    input.click();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  };

  const onDragOver = (event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const onZoneDrop = (event: DragEvent): void => {
    event.preventDefault();
    depth = 0;
    zone.dataset.armed = 'false';
    document.body.dataset.dragging = 'false';
    take(event.dataTransfer?.files);
  };

  const onZoneEnter = (): void => {
    zone.dataset.armed = 'true';
  };

  const onZoneLeave = (event: DragEvent): void => {
    if (zone.contains(event.relatedTarget as Node)) return;
    zone.dataset.armed = 'false';
  };

  // Page-level tracking. Counting enter/leave avoids the flicker caused by
  // dragenter firing on every child element.
  const onWindowEnter = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    depth += 1;
    document.body.dataset.dragging = 'true';
  };

  const onWindowLeave = (): void => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) document.body.dataset.dragging = 'false';
  };

  const onWindowDrop = (event: DragEvent): void => {
    event.preventDefault();
    depth = 0;
    document.body.dataset.dragging = 'false';
    zone.dataset.armed = 'false';
    take(event.dataTransfer?.files);
  };

  const onPaste = (event: ClipboardEvent): void => {
    const files = event.clipboardData?.files;
    if (files && files.length > 0) take(files);
  };

  input.addEventListener('change', onChange);
  zone.addEventListener('click', onClick);
  zone.addEventListener('keydown', onKey);
  zone.addEventListener('dragover', onDragOver);
  zone.addEventListener('dragenter', onZoneEnter);
  zone.addEventListener('dragleave', onZoneLeave);
  zone.addEventListener('drop', onZoneDrop);

  window.addEventListener('dragenter', onWindowEnter);
  window.addEventListener('dragleave', onWindowLeave);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onWindowDrop);
  window.addEventListener('paste', onPaste);

  return () => {
    input.removeEventListener('change', onChange);
    zone.removeEventListener('click', onClick);
    zone.removeEventListener('keydown', onKey);
    zone.removeEventListener('dragover', onDragOver);
    zone.removeEventListener('dragenter', onZoneEnter);
    zone.removeEventListener('dragleave', onZoneLeave);
    zone.removeEventListener('drop', onZoneDrop);
    window.removeEventListener('dragenter', onWindowEnter);
    window.removeEventListener('dragleave', onWindowLeave);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('drop', onWindowDrop);
    window.removeEventListener('paste', onPaste);
    document.body.dataset.dragging = 'false';
  };
}

/**
 * Hands a result to the next tool without a re-upload.
 *
 * The blob goes into IndexedDB under a token, and the token into sessionStorage.
 * Both survive a full page load on this origin, which is what following a link
 * is. A module-level map keeps the same-document fast path. Nothing here leaves
 * the browser: the next page claims the entry and deletes it.
 */
const handoff = new Map<string, { blob: Blob; name: string }>();
const HANDOFF_KEY = 'iha:handoff';
const HANDOFF_DB = 'iha-handoff';
const HANDOFF_STORE = 'files';

function openHandoffDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(HANDOFF_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDOFF_STORE)) {
        request.result.createObjectStore(HANDOFF_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'));
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openHandoffDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(HANDOFF_STORE, mode);
        const request = run(tx.objectStore(HANDOFF_STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB transaction failed'));
        };
      })
  );
}

/** Resolves once the entry is durable; navigate only after it does. */
export async function stashForNextTool(blob: Blob, name: string): Promise<void> {
  const token = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  handoff.set(token, { blob, name });
  (window as unknown as { __ihaHandoff?: typeof handoff }).__ihaHandoff = handoff;
  try {
    sessionStorage.setItem(HANDOFF_KEY, token);
  } catch {
    /* Private mode can block sessionStorage; chaining degrades to re-upload. */
  }
  try {
    await withStore('readwrite', (store) => store.put({ blob, name, at: Date.now() }, token));
  } catch {
    /* Without IndexedDB the in-memory copy still serves a same-document navigation. */
  }
}

export async function claimHandoff(): Promise<File | null> {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(HANDOFF_KEY);
    if (token) sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!token) return null;

  const store =
    (window as unknown as { __ihaHandoff?: typeof handoff }).__ihaHandoff ?? handoff;
  let entry = store.get(token) ?? null;
  store.delete(token);

  if (!entry) {
    try {
      entry =
        (await withStore<{ blob: Blob; name: string } | undefined>('readonly', (s) => s.get(token!))) ??
        null;
      if (entry) await withStore('readwrite', (s) => s.delete(token!));
    } catch {
      entry = null;
    }
  }
  if (!entry) return null;

  return new File([entry.blob], entry.name, { type: entry.blob.type });
}
