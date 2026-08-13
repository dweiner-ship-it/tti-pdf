// Logic for PDF Editor Page — Annotate + Edit Text (pdf-lib whiteout+redraw)
import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import { formatBytes, downloadFile } from '../utils/helpers.js';
import { makeUniqueFileKey } from '../utils/deduplicate-filename.js';
import { batchDecryptIfNeeded } from '../utils/password-prompt.js';
import { getEditorDisabledCategories } from '../utils/disabled-tools.js';
import {
  mountTextEditLayer,
  applyFindReplace,
  buildEditedPdf,
  hasTextEdits,
  clearTextEdits,
} from '../utils/edit-text-overlay.js';

const embedPdfWasmUrl = new URL(
  'embedpdf-snippet/dist/pdfium.wasm',
  import.meta.url
).href;

import type { EmbedPdfContainer } from 'embedpdf-snippet';
import type { DocManagerPlugin } from '@/types';

let viewerInstance: EmbedPdfContainer | null = null;
let docManagerPlugin: DocManagerPlugin | null = null;
let isViewerInitialized = false;
let currentFileName = 'document.pdf';
const fileEntryMap = new Map<string, HTMLElement>();

// Text-edit state
let textModeActive = false;
let currentPdfBytes: Uint8Array | null = null;
let textLayerMountedFor: string | null = null; // fileName guard

function resetViewer() {
  const pdfWrapper = document.getElementById('embed-pdf-wrapper');
  const pdfContainer = document.getElementById('embed-pdf-container');
  const downloadBtn = document.getElementById('download-edited-pdf');
  const fileDisplayArea = document.getElementById('file-display-area');
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const modeBar = document.getElementById('mode-toggle-bar');
  const textWrapper = document.getElementById('text-edit-wrapper');
  const textContainer = document.getElementById('text-edit-container');
  if (pdfContainer) pdfContainer.textContent = '';
  if (pdfWrapper) pdfWrapper.classList.add('hidden');
  if (downloadBtn) downloadBtn.classList.add('hidden');
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';
  if (fileInput) fileInput.value = '';
  if (modeBar) modeBar.classList.add('hidden');
  if (textWrapper) textWrapper.classList.add('hidden');
  if (textContainer) textContainer.innerHTML = '';
  try {
    clearTextEdits();
  } catch {}
  currentPdfBytes = null;
  textLayerMountedFor = null;
  textModeActive = false;
  viewerInstance = null;
  docManagerPlugin = null;
  isViewerInitialized = false;
  fileEntryMap.clear();
  syncModeButtons();
}

function removeFileEntry(documentId: string) {
  const entry = fileEntryMap.get(documentId);
  if (entry) {
    entry.remove();
    fileEntryMap.delete(documentId);
  }
  if (fileEntryMap.size === 0) {
    resetViewer();
  }
}

function syncModeButtons() {
  const annotateBtn = document.getElementById('mode-annotate-btn');
  const textBtn = document.getElementById('mode-text-btn');
  if (!annotateBtn || !textBtn) return;
  if (textModeActive) {
    textBtn.className =
      'px-3 py-1.5 text-sm font-medium rounded-md bg-[#2c2f76] text-white transition-colors';
    annotateBtn.className =
      'px-3 py-1.5 text-sm font-medium rounded-md text-gray-600 hover:bg-white transition-colors';
  } else {
    annotateBtn.className =
      'px-3 py-1.5 text-sm font-medium rounded-md bg-[#2c2f76] text-white transition-colors';
    textBtn.className =
      'px-3 py-1.5 text-sm font-medium rounded-md text-gray-600 hover:bg-white transition-colors';
  }
}

function setMode(mode: 'annotate' | 'text') {
  textModeActive = mode === 'text';
  const pdfWrapper = document.getElementById('embed-pdf-wrapper');
  const textWrapper = document.getElementById('text-edit-wrapper');
  const downloadBtn = document.getElementById('download-edited-pdf');
  syncModeButtons();
  if (textModeActive) {
    pdfWrapper?.classList.add('hidden');
    downloadBtn?.classList.add('hidden');
    textWrapper?.classList.remove('hidden');
    // lazily mount if we have bytes
    void ensureTextLayer();
  } else {
    textWrapper?.classList.add('hidden');
    if (isViewerInitialized) {
      pdfWrapper?.classList.remove('hidden');
      downloadBtn?.classList.remove('hidden');
    }
  }
}

async function ensureTextLayer() {
  if (!currentPdfBytes) return;
  const container = document.getElementById(
    'text-edit-container'
  ) as HTMLElement | null;
  if (!container) return;
  // avoid remounting same file repeatedly
  const guard = currentFileName + ':' + currentPdfBytes.byteLength;
  if (textLayerMountedFor === guard && container.childElementCount > 0) return;
  showLoader('Preparing text layer…');
  try {
    await mountTextEditLayer(currentPdfBytes, container, 1.5);
    textLayerMountedFor = guard;
  } catch (err) {
    console.error('mountTextEditLayer failed', err);
    showAlert('Error', 'Failed to prepare text editing layer.');
  } finally {
    hideLoader();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage() {
  createIcons({ icons });

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');

  if (fileInput) {
    fileInput.addEventListener('change', handleFileUpload);
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-indigo-500');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-indigo-500');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-indigo-500');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleFiles(files);
      }
    });

    fileInput?.addEventListener('click', () => {
      if (fileInput) fileInput.value = '';
    });
  }

  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });

  // Mode toggle
  document
    .getElementById('mode-annotate-btn')
    ?.addEventListener('click', () => setMode('annotate'));
  document
    .getElementById('mode-text-btn')
    ?.addEventListener('click', () => setMode('text'));

  // Find/Replace
  document.getElementById('replace-all-btn')?.addEventListener('click', () => {
    const container = document.getElementById(
      'text-edit-container'
    ) as HTMLElement | null;
    const find =
      (document.getElementById('find-input') as HTMLInputElement)?.value || '';
    const replace =
      (document.getElementById('replace-input') as HTMLInputElement)?.value ||
      '';
    const matchCase =
      (document.getElementById('match-case') as HTMLInputElement)?.checked ||
      false;
    if (!container) return;
    if (!find) {
      showAlert('Find', 'Enter text to find.');
      return;
    }
    const n = applyFindReplace(container, find, replace, matchCase);
    if (n === 0) showAlert('Replace', 'No matches found.');
  });

  // Download edited (text mode)
  document
    .getElementById('download-text-edits')
    ?.addEventListener('click', async () => {
      if (!currentPdfBytes) {
        showAlert('No file', 'Upload a PDF first.');
        return;
      }
      if (!hasTextEdits()) {
        showAlert('No changes', 'Edit some text first (amber highlights).');
        return;
      }
      showLoader('Building edited PDF…');
      try {
        const out = await buildEditedPdf(currentPdfBytes);
        const blob = new Blob([out as BlobPart], { type: 'application/pdf' });
        const base = currentFileName.replace(/\.pdf$/i, '');
        downloadFile(blob, base + '_edited.pdf');
      } catch (err) {
        console.error('buildEditedPdf failed', err);
        showAlert('Error', 'Failed to build edited PDF.');
      } finally {
        hideLoader();
      }
    });
}

async function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    await handleFiles(input.files);
  }
}

async function handleFiles(files: FileList) {
  const pdfFiles = Array.from(files).filter(
    (f) => f.type === 'application/pdf'
  );
  if (pdfFiles.length === 0) {
    showAlert('Invalid File', 'Please upload a valid PDF file.');
    return;
  }

  showLoader('Loading PDF Editor...');

  try {
    const pdfWrapper = document.getElementById('embed-pdf-wrapper');
    const pdfContainer = document.getElementById('embed-pdf-container');
    const fileDisplayArea = document.getElementById('file-display-area');
    const modeBar = document.getElementById('mode-toggle-bar');

    if (!pdfWrapper || !pdfContainer || !fileDisplayArea) return;

    hideLoader();
    const decryptedFiles = await batchDecryptIfNeeded(pdfFiles);
    showLoader('Loading PDF Editor...');

    if (decryptedFiles.length === 0) {
      hideLoader();
      return;
    }

    // Keep bytes for text-edit mode (first file)
    const firstFileForText = decryptedFiles[0];
    currentFileName = firstFileForText.name;
    const firstArrayBuf = await firstFileForText.arrayBuffer();
    currentPdfBytes = new Uint8Array(firstArrayBuf.slice(0));
    textLayerMountedFor = null;
    // Use a fresh copy for embed viewer as well
    const firstBufferForViewer = firstArrayBuf;

    modeBar?.classList.remove('hidden');
    syncModeButtons();

    if (!isViewerInitialized) {
      pdfContainer.textContent = '';
      pdfWrapper.classList.remove('hidden');

      const { default: EmbedPDF } = await import('embedpdf-snippet');
      const disabledCategories = getEditorDisabledCategories();
      viewerInstance = EmbedPDF.init({
        disabledCategories,
        type: 'container',
        target: pdfContainer,
        worker: true,
        wasmUrl: embedPdfWasmUrl,
        export: {
          defaultFileName: firstFileForText.name,
        },
        documentManager: {
          maxDocuments: 10,
        },
        tabBar: 'always',
      });

      const registry = await viewerInstance.registry;
      docManagerPlugin = registry
        .getPlugin('document-manager')
        .provides() as unknown as DocManagerPlugin;

      docManagerPlugin.onDocumentClosed((data: { id?: string }) => {
        const docId = data?.id || '';
        removeFileEntry(docId);
      });

      docManagerPlugin.onDocumentOpened(
        (data: { id?: string; name?: string }) => {
          const docId = data?.id;
          const docKey = data?.name;
          if (!docId) return;
          const pendingEntry = fileDisplayArea.querySelector(
            `[data-pending-name="${CSS.escape(docKey || '')}"]`
          ) as HTMLElement;
          if (pendingEntry) {
            pendingEntry.removeAttribute('data-pending-name');
            fileEntryMap.set(docId, pendingEntry);
            const removeBtn = pendingEntry.querySelector(
              '[data-remove-btn]'
            ) as HTMLElement;
            if (removeBtn) {
              removeBtn.onclick = () => {
                docManagerPlugin!.closeDocument(docId);
              };
            }
          }
        }
      );

      addFileEntries(fileDisplayArea, decryptedFiles);

      docManagerPlugin.openDocumentBuffer({
        buffer: firstBufferForViewer,
        name: makeUniqueFileKey(0, firstFileForText.name),
        autoActivate: true,
      });

      for (let i = 1; i < decryptedFiles.length; i++) {
        const buffer = await decryptedFiles[i].arrayBuffer();
        docManagerPlugin.openDocumentBuffer({
          buffer,
          name: makeUniqueFileKey(i, decryptedFiles[i].name),
          autoActivate: false,
        });
      }

      isViewerInitialized = true;

      let downloadBtn = document.getElementById('download-edited-pdf');
      if (!downloadBtn) {
        downloadBtn = document.createElement('button');
        downloadBtn.id = 'download-edited-pdf';
        downloadBtn.className = 'btn-gradient w-full mt-6';
        downloadBtn.textContent = 'Download Edited PDF';
        pdfWrapper.appendChild(downloadBtn);
      }
      downloadBtn.classList.remove('hidden');

      downloadBtn.onclick = async () => {
        try {
          const exportPlugin = registry.getPlugin('export').provides();
          const arrayBuffer = await exportPlugin.saveAsCopy().toPromise();
          const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
          downloadFile(blob, currentFileName);
        } catch (err) {
          console.error('Error downloading PDF:', err);
          showAlert('Error', 'Failed to download the edited PDF.');
        }
      };

      const backBtn = document.getElementById('back-to-tools');
      if (backBtn) {
        const newBackBtn = backBtn.cloneNode(true);
        backBtn.parentNode?.replaceChild(newBackBtn, backBtn);

        newBackBtn.addEventListener('click', () => {
          window.location.href = import.meta.env.BASE_URL;
        });
      }
      // default to annotate mode
      setMode('annotate');
    } else {
      addFileEntries(fileDisplayArea, decryptedFiles);

      for (let i = 0; i < decryptedFiles.length; i++) {
        const buffer = await decryptedFiles[i].arrayBuffer();
        // keep currentPdfBytes as first of newest batch only if user wants; don't overwrite unless single
        docManagerPlugin!.openDocumentBuffer({
          buffer,
          name: makeUniqueFileKey(i, decryptedFiles[i].name),
          autoActivate: true,
        });
      }
      // if text mode was active, remount with new current file
      if (textModeActive) await ensureTextLayer();
    }
  } catch (error) {
    console.error('Error loading PDF Editor:', error);
    showAlert('Error', 'Failed to load the PDF Editor.');
  } finally {
    hideLoader();
  }
}

function addFileEntries(fileDisplayArea: HTMLElement, files: File[]) {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileDiv = document.createElement('div');
    fileDiv.className =
      'flex items-center justify-between bg-white p-3 rounded-lg border border-gray-200';
    fileDiv.setAttribute('data-pending-name', makeUniqueFileKey(i, file.name));

    const infoContainer = document.createElement('div');
    infoContainer.className = 'flex flex-col flex-1 min-w-0';

    const nameSpan = document.createElement('div');
    nameSpan.className = 'truncate font-medium text-gray-900 text-sm mb-1';
    nameSpan.textContent = file.name;

    const metaSpan = document.createElement('div');
    metaSpan.className = 'text-xs text-gray-500';
    metaSpan.textContent = formatBytes(file.size);

    infoContainer.append(nameSpan, metaSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'ml-4 text-red-500 hover:text-red-600 flex-shrink-0';
    removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
    removeBtn.setAttribute('data-remove-btn', 'true');
    removeBtn.onclick = () => {
      fileDiv.remove();
      if (fileDisplayArea.children.length === 0) {
        resetViewer();
      }
    };

    fileDiv.append(infoContainer, removeBtn);
    fileDisplayArea.appendChild(fileDiv);
  }

  createIcons({ icons });
}
