const STORAGE_KEY = "gongyang_hypertext_v4_text";
const LEGACY_STORAGE_KEYS = ["gongyang_hypertext_v3"];
const STORAGE_BACKUP_KEY = `${STORAGE_KEY}__backup`;
const STORAGE_META_KEY = `${STORAGE_KEY}__meta`;
const APP_VERSION = "2026-05-21.3";

const EMPTY_CORPUS = {
  metadata: {
    title: "《公羊傳》文本工作台",
    source: "gongyang-hypertext.json",
    note: "注釋系統已移除，僅保留正文編輯與資料同步底座。"
  },
  sections: [],
  annotations: {},
  annotationLinks: []
};

const runtimeState = {
  loadSource: "empty",
  loadError: "",
  lastPersistError: "",
  lastPersistBackend: "",
  hasLocalMutations: false,
  projectSnapshot: null
};

const state = {
  corpus: structuredCloneSafe(EMPTY_CORPUS),
  query: ""
};

const uiState = {
  editor: null,
  dragSectionId: ""
};

const fileSyncState = {
  handle: null,
  fileName: ""
};

const refs = {
  sectionNav: document.getElementById("sectionNav"),
  textRoot: document.getElementById("textRoot"),
  sidePanel: document.getElementById("sidePanel"),
  searchInput: document.getElementById("searchInput"),
  statusBar: document.getElementById("statusBar"),
  editParagraphBtn: document.getElementById("editParagraphBtn"),
  connectFileBtn: document.getElementById("connectFileBtn"),
  syncFileBtn: document.getElementById("syncFileBtn"),
  reloadProjectBtn: document.getElementById("reloadProjectBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importInput: document.getElementById("importInput"),
  resetBtn: document.getElementById("resetBtn")
};

void init();

async function init() {
  wireEvents();
  updateFileSyncButtons();

  state.corpus = loadCorpus();
  renderAll();
  announceLoadStatus();

  const shouldHydrate = state.corpus.sections.length === 0;
  await preloadProjectSnapshot({ hydrateIfEmpty: shouldHydrate, showStatus: true });
}

function wireEvents() {
  if (refs.searchInput) {
    refs.searchInput.addEventListener("input", (event) => {
      state.query = String(event.target.value || "").trim().toLowerCase();
      renderAll();
    });
  }

  if (refs.editParagraphBtn) {
    refs.editParagraphBtn.addEventListener("click", () => {
      openEditorAtFirstParagraph();
    });
  }

  if (refs.connectFileBtn) {
    refs.connectFileBtn.addEventListener("click", () => {
      void connectDataFile();
    });
  }

  if (refs.syncFileBtn) {
    refs.syncFileBtn.addEventListener("click", () => {
      void syncConnectedFile({ silent: false, reason: "manual" });
    });
  }

  if (refs.reloadProjectBtn) {
    refs.reloadProjectBtn.addEventListener("click", () => {
      void reconcileWithProjectJson({ force: true, showStatus: true });
    });
  }

  if (refs.exportBtn) {
    refs.exportBtn.addEventListener("click", () => {
      exportCorpus();
    });
  }

  if (refs.importBtn && refs.importInput) {
    refs.importBtn.addEventListener("click", () => {
      refs.importInput.click();
    });
    refs.importInput.addEventListener("change", (event) => {
      importCorpus(event);
    });
  }

  if (refs.resetBtn) {
    refs.resetBtn.addEventListener("click", () => {
      void resetCorpus();
    });
  }

  if (refs.sectionNav) {
    refs.sectionNav.addEventListener("dragstart", (event) => {
      const link = event.target.closest(".section-link");
      if (!link) return;
      uiState.dragSectionId = link.dataset.sectionId || "";
      link.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", uiState.dragSectionId);
      }
    });

    refs.sectionNav.addEventListener("dragover", (event) => {
      const link = event.target.closest(".section-link");
      if (!link || !uiState.dragSectionId) return;
      event.preventDefault();
      clearSectionDragStyles();
      if (link.dataset.sectionId !== uiState.dragSectionId) {
        link.classList.add("drop-target");
      }
    });

    refs.sectionNav.addEventListener("drop", (event) => {
      const link = event.target.closest(".section-link");
      if (!link || !uiState.dragSectionId) return;
      event.preventDefault();
      const sourceId = uiState.dragSectionId;
      const targetId = link.dataset.sectionId || "";
      const rect = link.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      moveSectionInteractiveByDrag(sourceId, targetId, after);
      uiState.dragSectionId = "";
      clearSectionDragStyles();
    });

    refs.sectionNav.addEventListener("dragend", () => {
      uiState.dragSectionId = "";
      clearSectionDragStyles();
    });
  }

  if (refs.sidePanel) {
    refs.sidePanel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action || "";

      if (action === "open-editor") {
        openEditorAtFirstParagraph();
        return;
      }
      if (action === "cancel-editor") {
        uiState.editor = null;
        renderSidePanel();
        return;
      }
      if (action === "add-section") {
        addSectionInteractive();
        return;
      }
      if (action === "rename-section") {
        const { sectionId } = getEditorSelection();
        renameSectionInteractive(sectionId);
        return;
      }
      if (action === "delete-section") {
        const { sectionId } = getEditorSelection();
        deleteSectionInteractive(sectionId);
        return;
      }
      if (action === "add-paragraph") {
        const { sectionId } = getEditorSelection();
        addParagraphInteractive(sectionId);
        return;
      }
      if (action === "delete-paragraph") {
        const { sectionId, paragraphId } = getEditorSelection();
        deleteParagraphInteractive(sectionId, paragraphId);
        return;
      }
      if (action === "move-paragraph-up") {
        const { sectionId, paragraphId } = getEditorSelection();
        moveParagraphInteractive(sectionId, paragraphId, -1);
        return;
      }
      if (action === "move-paragraph-down") {
        const { sectionId, paragraphId } = getEditorSelection();
        moveParagraphInteractive(sectionId, paragraphId, 1);
      }
    });

    refs.sidePanel.addEventListener("change", (event) => {
      const control = event.target;
      if (control.id === "paragraphSelect") {
        const [sectionId, paragraphId] = String(control.value || "").split("::");
        uiState.editor = { type: "paragraph", sectionId, paragraphId };
        renderSidePanel();
        return;
      }
      if (control.id === "sectionSelect") {
        const sectionId = String(control.value || "");
        const section = findSectionById(sectionId);
        uiState.editor = {
          type: "paragraph",
          sectionId,
          paragraphId: section?.paragraphs?.[0]?.id || ""
        };
        renderSidePanel();
      }
    });

    refs.sidePanel.addEventListener("submit", (event) => {
      const form = event.target;
      event.preventDefault();
      if (form.id === "paragraphEditorForm") {
        saveParagraphFromForm(form);
      }
    });
  }
}

function renderAll() {
  renderNav();
  renderText();
  renderSidePanel();
}

function renderNav() {
  if (!refs.sectionNav) return;
  refs.sectionNav.innerHTML = "";

  state.corpus.sections.forEach((section) => {
    const link = document.createElement("a");
    link.href = `#section-${section.id}`;
    link.className = "section-link";
    link.dataset.sectionId = section.id;
    link.draggable = true;
    link.textContent = `${section.title} (${section.paragraphs.length})`;
    refs.sectionNav.appendChild(link);
  });
}

function renderText() {
  if (!refs.textRoot) return;
  refs.textRoot.innerHTML = "";

  state.corpus.sections.forEach((section) => {
    const visibleParagraphs = section.paragraphs.filter((paragraph) => paragraphMatchesQuery(section, paragraph));
    if (state.query && !visibleParagraphs.length && !String(section.title || "").toLowerCase().includes(state.query)) {
      return;
    }

    const sectionBlock = document.createElement("section");
    sectionBlock.className = "section-block";
    sectionBlock.id = `section-${section.id}`;

    const title = document.createElement("h3");
    title.className = "section-title";
    title.textContent = section.title;
    sectionBlock.appendChild(title);

    visibleParagraphs.forEach((paragraph) => {
      const p = document.createElement("p");
      p.className = "section-paragraph";
      p.id = buildParagraphAnchor(section.id, paragraph.id);
      p.dataset.sectionId = section.id;
      p.dataset.paragraphId = paragraph.id;
      appendTextWithHighlight(p, paragraph.text, state.query);
      sectionBlock.appendChild(p);
    });

    refs.textRoot.appendChild(sectionBlock);
  });
}

function renderSidePanel() {
  if (!refs.sidePanel) return;
  refs.sidePanel.innerHTML = "";

  if (uiState.editor?.type === "paragraph") {
    refs.sidePanel.appendChild(renderParagraphEditor(uiState.editor.sectionId, uiState.editor.paragraphId));
    return;
  }

  refs.sidePanel.appendChild(renderWorkspacePanel());
}

function renderWorkspacePanel() {
  const wrapper = document.createElement("div");
  const sectionCount = state.corpus.sections.length;
  const paragraphCount = state.corpus.sections.reduce((sum, section) => sum + section.paragraphs.length, 0);
  const ignoredAnnotationCount = Object.keys(state.corpus.annotations || {}).length;
  const ignoredLinkCount = Array.isArray(state.corpus.annotationLinks) ? state.corpus.annotationLinks.length : 0;

  wrapper.innerHTML = `
    <h2>文本工作台</h2>
    <p class="hint">注釋相關前端代碼已移除。現在只保留正文瀏覽、搜索、章節排序、段落編輯與 JSON 同步。</p>
    <div class="workspace-card">
      <p><strong>標題</strong></p>
      <p>${escapeHtml(state.corpus.metadata?.title || "未命名專案")}</p>
    </div>
    <div class="workspace-card">
      <p><strong>統計</strong></p>
      <p>章節：${sectionCount}</p>
      <p>段落：${paragraphCount}</p>
    </div>
    <div class="workspace-card">
      <p><strong>資料說明</strong></p>
      <p>JSON 中原有註釋資料仍會保留，但目前前端不讀取它們。</p>
      <p>保留的註釋數：${ignoredAnnotationCount}</p>
      <p>保留的錨點數：${ignoredLinkCount}</p>
    </div>
    <div class="panel-actions">
      <button type="button" data-action="open-editor">編輯正文</button>
    </div>
  `;

  return wrapper;
}

function renderParagraphEditor(selectedSectionId, selectedParagraphId) {
  const wrapper = document.createElement("div");
  const sectionOptions = [];
  const paragraphOptions = [];
  let selectedSection = null;
  let selectedParagraph = null;
  let paragraphIndex = -1;

  state.corpus.sections.forEach((section) => {
    sectionOptions.push({ id: section.id, title: section.title });
    section.paragraphs.forEach((paragraph, index) => {
      paragraphOptions.push({
        key: `${section.id}::${paragraph.id}`,
        label: `${section.title} / ${paragraph.id}`,
        sectionId: section.id,
        paragraphId: paragraph.id
      });
      if (section.id === selectedSectionId && paragraph.id === selectedParagraphId) {
        selectedSection = section;
        selectedParagraph = paragraph;
        paragraphIndex = index;
      }
    });
  });

  if (!selectedParagraph && paragraphOptions.length) {
    const fallback = paragraphOptions[0];
    selectedSectionId = fallback.sectionId;
    selectedParagraphId = fallback.paragraphId;
    selectedSection = findSectionById(selectedSectionId);
    selectedParagraph = findParagraphByIds(selectedSectionId, selectedParagraphId);
    paragraphIndex = selectedSection?.paragraphs?.findIndex((item) => item.id === selectedParagraphId) ?? -1;
  }

  const canMoveParagraphUp = paragraphIndex > 0;
  const canMoveParagraphDown =
    Boolean(selectedSection) && paragraphIndex > -1 && paragraphIndex < selectedSection.paragraphs.length - 1;

  const sectionSelectOptions = sectionOptions
    .map((option) => {
      const selectedAttr = option.id === selectedSectionId ? "selected" : "";
      return `<option value="${escapeAttr(option.id)}" ${selectedAttr}>${escapeHtml(option.title)}</option>`;
    })
    .join("");

  const paragraphSelectOptions = paragraphOptions
    .map((option) => {
      const selectedAttr =
        option.sectionId === selectedSectionId && option.paragraphId === selectedParagraphId ? "selected" : "";
      return `<option value="${escapeAttr(option.key)}" ${selectedAttr}>${escapeHtml(option.label)}</option>`;
    })
    .join("");

  wrapper.innerHTML = `
    <h2>編輯正文</h2>
    <p class="hint">正文現在只處理純文本，不再附帶註釋掛接邏輯。</p>
    <label>
      章節
      <select id="sectionSelect" name="sectionRef">${sectionSelectOptions}</select>
    </label>
    <div class="panel-actions wrap">
      <button type="button" data-action="add-section">新增章節</button>
      <button type="button" data-action="rename-section">更改章節名稱</button>
      <button type="button" data-action="delete-section">刪除目前章節</button>
      <button type="button" data-action="add-paragraph">新增段落</button>
      <button type="button" data-action="delete-paragraph">刪除目前段落</button>
      <button type="button" data-action="move-paragraph-up" ${canMoveParagraphUp ? "" : "disabled"}>段落上移</button>
      <button type="button" data-action="move-paragraph-down" ${canMoveParagraphDown ? "" : "disabled"}>段落下移</button>
    </div>
    <form id="paragraphEditorForm">
      <label>
        章節名稱
        <input name="sectionTitle" type="text" value="${escapeAttr(selectedSection?.title || "")}" required>
      </label>
      <label>
        段落
        <select id="paragraphSelect" name="paragraphRef">${paragraphSelectOptions}</select>
      </label>
      <label>
        段落內容
        <textarea name="text" required>${escapeHtml(selectedParagraph?.text || "")}</textarea>
      </label>
      <div class="editor-buttons">
        <button type="submit">儲存段落</button>
        <button type="button" data-action="cancel-editor">關閉編輯器</button>
      </div>
    </form>
  `;

  return wrapper;
}

function saveParagraphFromForm(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  const [sectionId, paragraphId] = String(payload.paragraphRef || "").split("::");
  const section = findSectionById(sectionId);
  const paragraph = findParagraphByIds(sectionId, paragraphId);
  if (!section || !paragraph) {
    setStatus("找不到目標段落。", true);
    return;
  }

  const nextSectionTitle = String(payload.sectionTitle || "").trim();
  const nextText = stripAngleBrackets(String(payload.text || "").trim());
  if (!nextSectionTitle) {
    setStatus("章節名稱不可為空。", true);
    return;
  }

  section.title = nextSectionTitle;
  paragraph.text = nextText;

  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`段落 ${paragraphId} 已更新。`, false);
}

function openEditorAtFirstParagraph() {
  const firstSection = state.corpus.sections[0];
  uiState.editor = {
    type: "paragraph",
    sectionId: firstSection?.id || "",
    paragraphId: firstSection?.paragraphs?.[0]?.id || ""
  };
  renderSidePanel();
}

function getEditorSelection() {
  const editor = uiState.editor?.type === "paragraph" ? uiState.editor : null;
  if (!editor) {
    const firstSection = state.corpus.sections[0];
    return {
      sectionId: firstSection?.id || "",
      paragraphId: firstSection?.paragraphs?.[0]?.id || ""
    };
  }
  return {
    sectionId: editor.sectionId,
    paragraphId: editor.paragraphId
  };
}

function addSectionInteractive() {
  const title = window.prompt("新增章節名稱", "");
  if (!title || !title.trim()) return;
  const sectionId = buildNewSectionId();
  const paragraphId = buildNewParagraphId(sectionId, []);
  state.corpus.sections.push({
    id: sectionId,
    title: title.trim(),
    paragraphs: [{ id: paragraphId, text: "" }]
  });
  uiState.editor = { type: "paragraph", sectionId, paragraphId };
  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`已新增章節 ${title.trim()}。`, false);
}

function renameSectionInteractive(sectionId) {
  const section = findSectionById(sectionId);
  if (!section) return;
  const nextTitle = window.prompt("更改章節名稱", section.title);
  if (!nextTitle || !nextTitle.trim() || nextTitle.trim() === section.title) return;
  section.title = nextTitle.trim();
  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`章節已更名為 ${section.title}。`, false);
}

function deleteSectionInteractive(sectionId) {
  const index = state.corpus.sections.findIndex((section) => section.id === sectionId);
  if (index === -1) return;
  if (state.corpus.sections.length <= 1) {
    setStatus("至少需保留一個章節。", true);
    return;
  }

  const section = state.corpus.sections[index];
  const confirmed = window.confirm(`確認刪除章節「${section.title}」？`);
  if (!confirmed) return;

  state.corpus.sections.splice(index, 1);
  const fallback = state.corpus.sections[Math.max(0, index - 1)] || state.corpus.sections[0];
  uiState.editor = {
    type: "paragraph",
    sectionId: fallback?.id || "",
    paragraphId: fallback?.paragraphs?.[0]?.id || ""
  };
  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`已刪除章節「${section.title}」。`, false);
}

function addParagraphInteractive(sectionId) {
  const section = findSectionById(sectionId);
  if (!section) return;
  const paragraphId = buildNewParagraphId(sectionId, section.paragraphs || []);
  section.paragraphs.push({ id: paragraphId, text: "" });
  uiState.editor = { type: "paragraph", sectionId, paragraphId };
  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`已新增段落 ${paragraphId}。`, false);
}

function deleteParagraphInteractive(sectionId, paragraphId) {
  const section = findSectionById(sectionId);
  if (!section) return;
  const index = section.paragraphs.findIndex((paragraph) => paragraph.id === paragraphId);
  if (index === -1) return;
  if (section.paragraphs.length <= 1) {
    setStatus("至少需保留一個段落。", true);
    return;
  }

  const confirmed = window.confirm(`確認刪除段落 ${paragraphId}？`);
  if (!confirmed) return;

  section.paragraphs.splice(index, 1);
  const fallback = section.paragraphs[Math.max(0, index - 1)] || section.paragraphs[0];
  uiState.editor = {
    type: "paragraph",
    sectionId,
    paragraphId: fallback?.id || ""
  };
  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`已刪除段落 ${paragraphId}。`, false);
}

function moveParagraphInteractive(sectionId, paragraphId, direction) {
  const section = findSectionById(sectionId);
  if (!section) return;
  const index = section.paragraphs.findIndex((paragraph) => paragraph.id === paragraphId);
  if (index === -1) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= section.paragraphs.length) return;

  const [moved] = section.paragraphs.splice(index, 1);
  section.paragraphs.splice(targetIndex, 0, moved);
  uiState.editor = { type: "paragraph", sectionId, paragraphId };
  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`已移動段落 ${paragraphId}。`, false);
}

function clearSectionDragStyles() {
  if (!refs.sectionNav) return;
  refs.sectionNav.querySelectorAll(".section-link").forEach((node) => {
    node.classList.remove("dragging");
    node.classList.remove("drop-target");
  });
}

function moveSectionInteractiveByDrag(sourceId, targetId, after = false) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const sourceIndex = state.corpus.sections.findIndex((section) => section.id === sourceId);
  const targetIndexRaw = state.corpus.sections.findIndex((section) => section.id === targetId);
  if (sourceIndex === -1 || targetIndexRaw === -1) return;

  const [moved] = state.corpus.sections.splice(sourceIndex, 1);
  let targetIndex = targetIndexRaw;
  if (sourceIndex < targetIndexRaw) {
    targetIndex -= 1;
  }
  const insertIndex = Math.max(0, Math.min(state.corpus.sections.length, targetIndex + (after ? 1 : 0)));
  state.corpus.sections.splice(insertIndex, 0, moved);

  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`已調整章節順序：${moved.title}。`, false);
}

function paragraphMatchesQuery(section, paragraph) {
  if (!state.query) return true;
  const sectionText = String(section.title || "").toLowerCase();
  const paragraphText = String(paragraph.text || "").toLowerCase();
  return sectionText.includes(state.query) || paragraphText.includes(state.query);
}

function appendTextWithHighlight(container, text, query) {
  if (!query) {
    container.appendChild(document.createTextNode(text));
    return;
  }

  let cursor = 0;
  const lower = text.toLowerCase();
  let index = lower.indexOf(query, cursor);
  while (index !== -1) {
    if (index > cursor) {
      container.appendChild(document.createTextNode(text.slice(cursor, index)));
    }
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + query.length);
    container.appendChild(mark);
    cursor = index + query.length;
    index = lower.indexOf(query, cursor);
  }

  if (cursor < text.length) {
    container.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

function buildParagraphAnchor(sectionId, paragraphId) {
  return `paragraph-${sectionId}-${paragraphId}`;
}

function findSectionById(sectionId, corpus = state.corpus) {
  return corpus.sections.find((section) => section.id === sectionId) || null;
}

function findParagraphByIds(sectionId, paragraphId, corpus = state.corpus) {
  const section = findSectionById(sectionId, corpus);
  if (!section) return null;
  return section.paragraphs.find((paragraph) => paragraph.id === paragraphId) || null;
}

function buildNewSectionId() {
  const base = "sec_new";
  const existing = new Set(state.corpus.sections.map((section) => section.id));
  let index = 1;
  let candidate = `${base}_${index}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
}

function buildNewParagraphId(sectionId, paragraphs) {
  const base = `${sectionId}_p`;
  const existing = new Set((paragraphs || []).map((paragraph) => paragraph.id));
  let index = 1;
  let candidate = `${base}${String(index).padStart(2, "0")}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `${base}${String(index).padStart(2, "0")}`;
  }
  return candidate;
}

function updateFileSyncButtons() {
  const connected = Boolean(fileSyncState.handle);
  if (refs.syncFileBtn) {
    refs.syncFileBtn.disabled = !connected;
  }
  if (refs.connectFileBtn) {
    refs.connectFileBtn.textContent = connected ? `已連接：${fileSyncState.fileName}` : "連接資料檔";
  }
}

async function connectDataFile() {
  if (!window.showOpenFilePicker) {
    setStatus("目前瀏覽器不支援直接回寫本地檔案，請改用匯入/匯出 JSON。", true);
    return;
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: false,
      types: [
        {
          description: "JSON",
          accept: { "application/json": [".json"] }
        }
      ]
    });

    const file = await handle.getFile();
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    validateCorpusShape(parsed);

    const normalized = normalizeCorpus(parsed);
    fileSyncState.handle = handle;
    fileSyncState.fileName = file.name;
    runtimeState.projectSnapshot = structuredCloneSafe(normalized);
    state.corpus = normalized;
    uiState.editor = null;

    const didPersist = persist({ markDirty: false });
    renderAll();
    updateFileSyncButtons();
    if (!didPersist) return;

    setStatus(`已連接資料檔 ${file.name}，後續儲存會自動同步。`, false);
  } catch (error) {
    if (error?.name === "AbortError") return;
    setStatus(`連接資料檔失敗：${error.message}`, true);
  }
}

async function syncConnectedFile({ silent = true, reason = "auto" } = {}) {
  if (!fileSyncState.handle) {
    if (!silent) {
      setStatus("尚未連接資料檔。", true);
    }
    return false;
  }

  try {
    const writable = await fileSyncState.handle.createWritable();
    await writable.write(JSON.stringify(state.corpus, null, 2));
    await writable.close();
    if (!silent) {
      setStatus(reason === "manual" ? "已同步到資料檔。" : "已自動同步到資料檔。", false);
    }
    return true;
  } catch (error) {
    setStatus(`同步資料檔失敗：${error.message}`, true);
    return false;
  }
}

function scheduleAutoFileSync() {
  void syncConnectedFile({ silent: true, reason: "auto" });
}

async function fetchProjectJsonFromServer() {
  if (window.location.protocol === "file:") {
    throw new Error("目前是 file:// 開啟，無法直接抓取專案 JSON。請改用 http://localhost。");
  }

  const candidates = [];
  candidates.push(new URL("gongyang-hypertext.json", window.location.href).toString());
  if (window.location.origin && /^https?:/i.test(window.location.origin)) {
    candidates.push(`${window.location.origin}/gongyang-hypertext.json`);
  }

  const failures = [];
  for (const baseUrl of [...new Set(candidates)]) {
    const requestUrl = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    try {
      const response = await fetch(requestUrl, { cache: "no-store" });
      if (!response.ok) {
        failures.push(`${baseUrl} -> HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      return { parsed, response, baseUrl };
    } catch (error) {
      failures.push(`${baseUrl} -> ${error.message}`);
    }
  }

  throw new Error(`找不到專案 JSON。嘗試：${failures.join(" | ")}`);
}

async function preloadProjectSnapshot({ hydrateIfEmpty = false, showStatus = false } = {}) {
  try {
    const { parsed, response, baseUrl } = await fetchProjectJsonFromServer();
    validateCorpusShape(parsed);
    const normalized = normalizeCorpus(parsed);
    runtimeState.projectSnapshot = structuredCloneSafe(normalized);

    if (!hydrateIfEmpty) {
      return true;
    }

    const headerValue = response.headers.get("Last-Modified");
    const savedAt = headerValue ? Date.parse(headerValue) : Date.now();
    state.corpus = structuredCloneSafe(normalized);
    uiState.editor = null;

    const didPersist = persist({ savedAt, markDirty: false });
    renderAll();
    if (!didPersist) return false;

    runtimeState.loadSource = "serverJson";
    if (showStatus) {
      setStatus(`已從專案 JSON 載入：${baseUrl}`, false);
    }
    return true;
  } catch (error) {
    if (showStatus && hydrateIfEmpty) {
      setStatus(`載入專案 JSON 失敗：${error.message}`, true);
    }
    return false;
  }
}

async function reconcileWithProjectJson({ force = false, showStatus = false } = {}) {
  try {
    const { parsed, response, baseUrl } = await fetchProjectJsonFromServer();
    validateCorpusShape(parsed);
    const normalized = normalizeCorpus(parsed);
    runtimeState.projectSnapshot = structuredCloneSafe(normalized);

    const localMeta = readLocalMeta();
    const localSavedAt = Number(localMeta.savedAt || 0);
    const headerValue = response.headers.get("Last-Modified");
    const serverSavedAt = headerValue ? Date.parse(headerValue) : 0;
    const keepLocal = !force && runtimeState.hasLocalMutations;
    const shouldUseServer =
      !keepLocal &&
      (force || !localSavedAt || runtimeState.loadSource === "empty" || (serverSavedAt && serverSavedAt >= localSavedAt));

    if (!shouldUseServer) {
      if (showStatus) {
        setStatus("已保留瀏覽器版本（本地編輯較新）。", false);
      }
      return true;
    }

    state.corpus = normalized;
    uiState.editor = null;

    const didPersist = persist({ savedAt: serverSavedAt || Date.now(), markDirty: false });
    renderAll();
    if (!didPersist) return false;

    runtimeState.loadSource = "serverJson";
    runtimeState.loadError = "";
    if (showStatus) {
      setStatus(`已重載專案 JSON：${baseUrl}`, false);
    }
    return true;
  } catch (error) {
    if (showStatus) {
      setStatus(`重載專案 JSON 失敗：${error.message}`, true);
    }
    return false;
  }
}

function exportCorpus() {
  const blob = new Blob([JSON.stringify(state.corpus, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "gongyang-hypertext.json";
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus("已匯出 JSON。", false);
}

function importCorpus(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      validateCorpusShape(parsed);
      const normalized = normalizeCorpus(parsed);
      runtimeState.projectSnapshot = structuredCloneSafe(normalized);
      state.corpus = normalized;
      uiState.editor = null;

      const didPersist = persist();
      renderAll();
      if (!didPersist) return;

      setStatus("匯入成功。", false);
    } catch (error) {
      setStatus(`匯入失敗：${error.message}`, true);
    } finally {
      refs.importInput.value = "";
    }
  };
  reader.readAsText(file, "utf-8");
}

async function resetCorpus() {
  const confirmed = window.confirm("確認還原專案資料？這會覆蓋目前本地編輯內容。");
  if (!confirmed) return;

  if (!runtimeState.projectSnapshot) {
    const ok = await preloadProjectSnapshot({ hydrateIfEmpty: false, showStatus: false });
    if (!ok || !runtimeState.projectSnapshot) {
      setStatus("尚未取得專案快照，無法還原。", true);
      return;
    }
  }

  state.corpus = structuredCloneSafe(runtimeState.projectSnapshot);
  uiState.editor = null;

  const didPersist = persist({ markDirty: false });
  renderAll();
  if (!didPersist) return;

  setStatus("已還原專案資料。", false);
}

function validateCorpusShape(data) {
  if (!data || typeof data !== "object") {
    throw new Error("JSON 頂層結構錯誤。");
  }
  if (!Array.isArray(data.sections)) {
    throw new Error("缺少 sections。");
  }
  data.sections.forEach((section) => {
    if (typeof section.id !== "string" || !Array.isArray(section.paragraphs)) {
      throw new Error("sections 結構不合法。");
    }
    section.paragraphs.forEach((paragraph) => {
      if (typeof paragraph.id !== "string" || typeof paragraph.text !== "string") {
        throw new Error("paragraph 結構不合法。");
      }
    });
  });
}

function stripAngleBrackets(text) {
  return String(text || "").replaceAll("〈", "").replaceAll("〉", "");
}

function normalizeCorpus(source) {
  const corpus = structuredCloneSafe(source || EMPTY_CORPUS);
  corpus.metadata = typeof corpus.metadata === "object" && corpus.metadata ? corpus.metadata : {};
  corpus.sections = Array.isArray(corpus.sections) ? corpus.sections : [];
  corpus.annotations = typeof corpus.annotations === "object" && corpus.annotations ? corpus.annotations : {};
  corpus.annotationLinks = Array.isArray(corpus.annotationLinks) ? corpus.annotationLinks : [];

  corpus.sections = corpus.sections.map((section) => ({
    id: String(section.id || "").trim(),
    title: String(section.title || "").trim() || "未命名章節",
    paragraphs: (Array.isArray(section.paragraphs) ? section.paragraphs : []).map((paragraph) => ({
      id: String(paragraph.id || "").trim(),
      text: stripAngleBrackets(String(paragraph.text || ""))
    }))
  }));

  return corpus;
}

function getStorageCandidates() {
  const candidates = [];
  try {
    if (typeof localStorage !== "undefined") {
      candidates.push({ name: "localStorage", storage: localStorage });
    }
  } catch (_error) {
    // Ignore and fallback to next backend.
  }
  try {
    if (typeof sessionStorage !== "undefined") {
      candidates.push({ name: "sessionStorage", storage: sessionStorage });
    }
  } catch (_error) {
    // Ignore and fallback to next backend.
  }
  return candidates;
}

function writeToStorage(target, key, backupKey, metaKey, serialized, savedAt) {
  target.storage.setItem(key, serialized);
  target.storage.setItem(backupKey, serialized);
  target.storage.setItem(metaKey, JSON.stringify({ savedAt }));
}

function persist(options = {}) {
  const serialized = JSON.stringify(state.corpus);
  const savedAt =
    typeof options.savedAt === "number" && Number.isFinite(options.savedAt)
      ? options.savedAt
      : Date.now();
  const markDirty = options.markDirty !== false;
  const errors = [];

  let writeTarget = null;
  for (const target of getStorageCandidates()) {
    try {
      writeToStorage(target, STORAGE_KEY, STORAGE_BACKUP_KEY, STORAGE_META_KEY, serialized, savedAt);
      writeTarget = target;
      break;
    } catch (error) {
      errors.push(`${target.name}: ${error.message}`);
    }
  }

  if (!writeTarget) {
    runtimeState.lastPersistBackend = "";
    runtimeState.lastPersistError = errors.join(" | ") || "unknown error";
    setStatus(`儲存失敗：${runtimeState.lastPersistError}。請連接資料檔後編輯。`, true);
    scheduleAutoFileSync();
    return false;
  }

  runtimeState.lastPersistBackend = writeTarget.name;
  runtimeState.lastPersistError = "";
  runtimeState.hasLocalMutations = markDirty;
  scheduleAutoFileSync();
  return true;
}

function loadCorpus() {
  const errors = [];

  for (const target of getStorageCandidates()) {
    const keyChain = [
      {
        key: STORAGE_KEY,
        backupKey: STORAGE_BACKUP_KEY,
        metaKey: STORAGE_META_KEY,
        sourceName: target.name
      },
      ...LEGACY_STORAGE_KEYS.map((legacyKey) => ({
        key: legacyKey,
        backupKey: `${legacyKey}__backup`,
        metaKey: `${legacyKey}__meta`,
        sourceName: `${target.name}:${legacyKey}`
      }))
    ];

    for (const item of keyChain) {
      let raw = null;
      try {
        raw = target.storage.getItem(item.key);
      } catch (error) {
        errors.push(`${item.sourceName} 讀取失敗：${error.message}`);
      }

      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          validateCorpusShape(parsed);
          runtimeState.loadSource = item.sourceName;
          runtimeState.loadError = "";
          return normalizeCorpus(parsed);
        } catch (error) {
          errors.push(`${item.sourceName} 主資料損壞：${error.message}`);
        }
      }

      let backupRaw = null;
      try {
        backupRaw = target.storage.getItem(item.backupKey);
      } catch (error) {
        errors.push(`${item.sourceName} 備援讀取失敗：${error.message}`);
      }

      if (backupRaw) {
        try {
          const parsed = JSON.parse(backupRaw);
          validateCorpusShape(parsed);
          runtimeState.loadSource = `${item.sourceName}:backup`;
          runtimeState.loadError = errors.join("；");
          return normalizeCorpus(parsed);
        } catch (error) {
          errors.push(`${item.sourceName} 備援資料損壞：${error.message}`);
        }
      }
    }
  }

  runtimeState.loadSource = "empty";
  runtimeState.loadError = errors.join("；");
  return structuredCloneSafe(EMPTY_CORPUS);
}

function readLocalMeta() {
  for (const target of getStorageCandidates()) {
    const keys = [STORAGE_META_KEY, ...LEGACY_STORAGE_KEYS.map((key) => `${key}__meta`)];
    for (const key of keys) {
      try {
        const raw = target.storage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") continue;
        return parsed;
      } catch (_error) {
        // Try next key.
      }
    }
  }
  return {};
}

function announceLoadStatus() {
  const sourceLabel =
    runtimeState.loadSource === "localStorage" || runtimeState.loadSource.startsWith("localStorage:")
      ? "瀏覽器儲存"
      : runtimeState.loadSource === "sessionStorage" || runtimeState.loadSource.startsWith("sessionStorage:")
      ? "分頁儲存"
      : runtimeState.loadSource === "empty"
      ? "空白狀態"
      : runtimeState.loadSource;

  if (runtimeState.loadError) {
    setStatus(`v${APP_VERSION}｜已載入${sourceLabel}。警告：${runtimeState.loadError}`, true);
    return;
  }

  if (runtimeState.loadSource === "empty") {
    setStatus(`v${APP_VERSION}｜目前沒有本地資料，將嘗試載入專案 JSON。`, false);
    return;
  }

  setStatus(`v${APP_VERSION}｜已載入${sourceLabel}。註釋前端已移除，現為純文本工作台。`, false);
}

function setStatus(message, isError = false) {
  if (!refs.statusBar) return;
  refs.statusBar.textContent = message;
  refs.statusBar.classList.toggle("error", isError);
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(input) {
  return escapeHtml(input).replaceAll("'", "&#39;");
}

function structuredCloneSafe(obj) {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}
