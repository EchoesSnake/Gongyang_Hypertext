const STORAGE_KEY = "gongyang_hypertext_v5";
const LEGACY_STORAGE_KEYS = ["gongyang_hypertext_v4_text", "gongyang_hypertext_v3"];
const STORAGE_BACKUP_KEY = `${STORAGE_KEY}__backup`;
const STORAGE_META_KEY = `${STORAGE_KEY}__meta`;
const APP_VERSION = "2026-06-11.1";

const ANNOTATION_TYPES = ["commentary", "definition", "cross_reference", "historical_note", "interpretation", "citation"];
const ANNOTATION_TYPE_LABELS = {
  commentary: "義例注",
  definition: "訓詁注",
  cross_reference: "參照注",
  historical_note: "史事注",
  interpretation: "義理注",
  citation: "引用注"
};
const ANNOTATION_TYPE_MARKERS = {
  commentary: "注",
  definition: "訓",
  cross_reference: "參",
  historical_note: "史",
  interpretation: "義",
  citation: "引"
};

const EMPTY_CORPUS = {
  metadata: {
    title: "《公羊傳》互動注釋版",
    source: "gongyang-hypertext.json",
    note: "正文與註釋分離的穩定資料結構。點擊正文中彩色標記可查看注釋。"
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
  activeAnnotationId: null,
  activeLinkId: null,
  annotationBackStack: [],
  query: ""
};

const uiState = {
  editor: null,
  pendingSelection: null,
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
  newAnnotationBtn: document.getElementById("newAnnotationBtn"),
  editParagraphBtn: document.getElementById("editParagraphBtn"),
  connectFileBtn: document.getElementById("connectFileBtn"),
  syncFileBtn: document.getElementById("syncFileBtn"),
  reloadProjectBtn: document.getElementById("reloadProjectBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importInput: document.getElementById("importInput"),
  resetBtn: document.getElementById("resetBtn"),
  selectionToolbar: document.getElementById("selectionToolbar"),
  addSelectionAnnotationBtn: document.getElementById("addSelectionAnnotationBtn")
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

/* ================================================================
   Events
   ================================================================ */

function wireEvents() {
  if (refs.searchInput) {
    refs.searchInput.addEventListener("input", (event) => {
      state.query = String(event.target.value || "").trim().toLowerCase();
      renderAll();
    });
  }

  if (refs.newAnnotationBtn) {
    refs.newAnnotationBtn.addEventListener("mousedown", (event) => {
      if (uiState.pendingSelection) {
        event.preventDefault();
      }
    });
    refs.newAnnotationBtn.addEventListener("click", () => {
      if (uiState.pendingSelection) {
        startQuickAnnotationFromSelection();
        return;
      }
      uiState.editor = { type: "annotation", mode: "new", annId: buildNewAnnotationId() };
      renderSidePanel();
    });
  }

  if (refs.textRoot) {
    refs.textRoot.addEventListener("click", (event) => {
      const token = event.target.closest(".ann-token");
      if (!token) return;
      openAnnotation(token.dataset.annId || "", token.dataset.linkId || "");
    });

    refs.textRoot.addEventListener("mouseover", (event) => {
      const token = event.target.closest(".ann-token");
      if (!token) return;
      handleAnnotationTokenHover(token, "enter", event);
    });

    refs.textRoot.addEventListener("mouseout", (event) => {
      const token = event.target.closest(".ann-token");
      if (!token) return;
      handleAnnotationTokenHover(token, "leave", event);
    });

    refs.textRoot.addEventListener("mouseup", () => {
      window.setTimeout(syncSelectionState, 0);
    });
    refs.textRoot.addEventListener("keyup", () => {
      window.setTimeout(syncSelectionState, 0);
    });
  }

  document.addEventListener("selectionchange", () => {
    window.setTimeout(syncSelectionState, 0);
  });

  window.addEventListener("scroll", () => {
    hideSelectionToolbar();
  });

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
    refs.sidePanel.addEventListener("mousedown", (event) => {
      const selectionAction = event.target.closest('[data-action="create-from-selection"]');
      if (selectionAction && uiState.pendingSelection) {
        event.preventDefault();
      }
    });

    refs.sidePanel.addEventListener("click", (event) => {
      const element = event.target.closest("[data-action]");
      if (!element) return;
      const action = element.dataset.action || "";

      if (action === "open-ann") {
        openAnnotation(element.dataset.annId || "", "");
        return;
      }
      if (action === "jump") {
        jumpToParagraph(element.dataset.sectionId || "", element.dataset.paragraphId || "");
        if (element.dataset.linkId) {
          state.activeLinkId = element.dataset.linkId;
          renderText();
        }
        return;
      }
      if (action === "back") {
        navigateBack();
        return;
      }
      if (action === "create-from-selection") {
        startQuickAnnotationFromSelection();
        return;
      }
      if (action === "edit-ann" && state.activeAnnotationId) {
        uiState.editor = { type: "annotation", mode: "edit", annId: state.activeAnnotationId };
        renderSidePanel();
        return;
      }
      if (action === "new-ann") {
        if (uiState.pendingSelection) {
          startQuickAnnotationFromSelection();
          return;
        }
        uiState.editor = { type: "annotation", mode: "new", annId: buildNewAnnotationId() };
        renderSidePanel();
        return;
      }
      if (action === "clear-active") {
        state.activeAnnotationId = null;
        state.activeLinkId = null;
        state.annotationBackStack = [];
        uiState.editor = null;
        renderSidePanel();
        renderText();
        return;
      }
      if (action === "delete-ann" && state.activeAnnotationId) {
        deleteAnnotationInteractive(state.activeAnnotationId);
        return;
      }
      if (action === "cancel-editor") {
        uiState.editor = null;
        renderSidePanel();
        return;
      }
      if (action === "edit-paragraph") {
        const firstSection = state.corpus.sections[0];
        const firstParagraph = firstSection?.paragraphs?.[0];
        uiState.editor = {
          type: "paragraph",
          sectionId: firstSection?.id || "",
          paragraphId: firstParagraph?.id || ""
        };
        renderSidePanel();
        return;
      }
      if (action === "add-section") {
        addSectionInteractive();
        return;
      }
      if (action === "rename-section") {
        const { sectionId } = getParagraphEditorSelection();
        renameSectionInteractive(sectionId);
        return;
      }
      if (action === "delete-section") {
        const { sectionId } = getParagraphEditorSelection();
        deleteSectionInteractive(sectionId);
        return;
      }
      if (action === "add-paragraph") {
        const { sectionId } = getParagraphEditorSelection();
        addParagraphInteractive(sectionId);
        return;
      }
      if (action === "delete-paragraph") {
        const { sectionId, paragraphId } = getParagraphEditorSelection();
        deleteParagraphInteractive(sectionId, paragraphId);
        return;
      }
      if (action === "move-paragraph-up") {
        const { sectionId, paragraphId } = getParagraphEditorSelection();
        moveParagraphInteractive(sectionId, paragraphId, -1);
        return;
      }
      if (action === "move-paragraph-down") {
        const { sectionId, paragraphId } = getParagraphEditorSelection();
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

  }

  if (refs.editParagraphBtn) {
    refs.editParagraphBtn.addEventListener("click", () => {
      const firstSection = state.corpus.sections[0];
      const firstParagraph = firstSection?.paragraphs?.[0];
      uiState.editor = {
        type: "paragraph",
        sectionId: firstSection?.id || "",
        paragraphId: firstParagraph?.id || ""
      };
      renderSidePanel();
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

  if (refs.addSelectionAnnotationBtn) {
    refs.addSelectionAnnotationBtn.addEventListener("click", () => {
      startQuickAnnotationFromSelection();
    });
  }
}

/* ================================================================
   Render: top-level
   ================================================================ */

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

/* ================================================================
   Render: reading pane
   ================================================================ */

function renderText() {
  if (!refs.textRoot) return;
  refs.textRoot.innerHTML = "";
  const occurrences = collectOccurrences(state.corpus);
  const paragraphLinkMap = groupLinksByParagraph(state.corpus.annotationLinks);

  state.corpus.sections.forEach((section) => {
    const visibleParagraphs = section.paragraphs.filter((paragraph) => {
      const links = paragraphLinkMap.get(buildParagraphKey(section.id, paragraph.id)) || [];
      return paragraphMatchesQuery(paragraph, links, occurrences);
    });
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
      const links = paragraphLinkMap.get(buildParagraphKey(section.id, paragraph.id)) || [];

      const p = document.createElement("p");
      p.className = "section-paragraph";
      p.id = buildParagraphAnchor(section.id, paragraph.id);
      p.dataset.sectionId = section.id;
      p.dataset.paragraphId = paragraph.id;
      renderParagraphText(p, paragraph.text, links);
      sectionBlock.appendChild(p);
    });

    refs.textRoot.appendChild(sectionBlock);
  });
}

function renderParagraphText(container, text, links) {
  const normalizedLinks = normalizeRenderableLinks(text, links);
  let cursor = 0;

  normalizedLinks.forEach((link) => {
    if (link.start > cursor) {
      appendTextWithHighlight(container, text.slice(cursor, link.start), state.query);
    }

    const annotation = state.corpus.annotations[link.annId];
    const annType = annotation?.type || "commentary";

    const token = document.createElement("button");
    token.type = "button";
    token.className = `ann-token ann-type-${annType}`;
    token.dataset.annId = link.annId;
    token.dataset.linkId = link.id;
    token.textContent = text.slice(link.start, link.end) || link.quote || "";
    token.title = annotation?.title || link.quote || link.annId;
    token.setAttribute("aria-label", `註釋：${annotation?.title || link.annId}`);
    if (link.annId === state.activeAnnotationId) {
      token.classList.add("active");
    }
    if (link.id === state.activeLinkId) {
      token.classList.add("active");
    }
    if (!annotation) {
      token.classList.add("unresolved");
      token.title = "未定義註釋，點擊後可建立";
    }
    container.appendChild(token);
    cursor = link.end;
  });

  if (cursor < text.length) {
    appendTextWithHighlight(container, text.slice(cursor), state.query);
  }
}

/* ================================================================
   Render: side panel
   ================================================================ */

function renderSidePanel() {
  if (!refs.sidePanel) return;
  refs.sidePanel.innerHTML = "";

  if (uiState.editor?.type === "quick-annotation") {
    refs.sidePanel.appendChild(renderQuickAnnotationEditor(uiState.editor));
    return;
  }

  if (uiState.editor?.type === "annotation") {
    refs.sidePanel.appendChild(renderAnnotationEditor(uiState.editor));
    return;
  }

  if (uiState.editor?.type === "paragraph") {
    refs.sidePanel.appendChild(renderParagraphEditor(uiState.editor.sectionId, uiState.editor.paragraphId));
    return;
  }

  if (!state.activeAnnotationId) {
    refs.sidePanel.appendChild(renderCatalogPanel());
    return;
  }

  const annotation = state.corpus.annotations[state.activeAnnotationId];
  if (!annotation) {
    refs.sidePanel.appendChild(renderMissingAnnotationPanel(state.activeAnnotationId));
    return;
  }

  refs.sidePanel.appendChild(renderAnnotationDetail(annotation));
}

/* ================================================================
   Render: annotation catalog
   ================================================================ */

function renderCatalogPanel() {
  const wrapper = document.createElement("div");
  wrapper.className = "panel-intro";

  const annCount = Object.keys(state.corpus.annotations).length;
  const linkCount = state.corpus.annotationLinks.length;
  const sectionCount = state.corpus.sections.length;
  const paragraphCount = state.corpus.sections.reduce((sum, s) => sum + s.paragraphs.length, 0);

  wrapper.innerHTML = `
    <h2>注釋總覽</h2>
    <p class="hint">正文保持純文本，注釋位置由獨立錨點控制。點擊正文中帶有<a class="ann-token ann-type-commentary" style="cursor:default;pointer-events:none;">彩色底線</a>的詞語可查看詳細注釋。先選中文字，再建立注釋最為穩定。</p>
    <div class="workspace-card">
      <p><strong>統計</strong></p>
      <p>章節：${sectionCount}｜段落：${paragraphCount}｜注釋：${annCount}｜錨點：${linkCount}</p>
    </div>
  `;

  if (uiState.pendingSelection) {
    const quick = document.createElement("div");
    quick.className = "catalog-item catalog-selection";
    quick.innerHTML = `
      <strong>當前選區</strong>
      <p class="small">${escapeHtml(uiState.pendingSelection.selectedText)}</p>
      <button type="button" data-action="create-from-selection">為這段文字建立注釋</button>
    `;
    wrapper.appendChild(quick);
  }

  // Group by type
  const occurrences = collectOccurrences(state.corpus);
  const annotations = Object.values(state.corpus.annotations);
  const filtered = state.query
    ? annotations.filter((annotation) => {
        const haystack = `${annotation.id} ${annotation.title} ${annotation.body} ${(annotation.tags || []).join(" ")}`
          .toLowerCase();
        return haystack.includes(state.query);
      })
    : annotations;

  const grouped = {};
  filtered.forEach((annotation) => {
    const type = annotation.type || "commentary";
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(annotation);
  });

  for (const type of ANNOTATION_TYPES) {
    const typeAnnotations = grouped[type] || [];
    if (!typeAnnotations.length && state.query) continue;
    if (!typeAnnotations.length) continue;

    const typeSection = document.createElement("div");
    typeSection.className = "catalog-type-section";
    typeSection.innerHTML = `
      <h3 class="catalog-type-header">
        <span class="ann-type-badge ${type}">${ANNOTATION_TYPE_LABELS[type]}</span>
        <span class="catalog-type-count">${typeAnnotations.length} 條</span>
      </h3>
    `;

    typeAnnotations.forEach((annotation) => {
      const count = occurrences.get(annotation.id)?.length || 0;
      const item = document.createElement("div");
      item.className = "catalog-item";
      item.innerHTML = `
        <strong>${escapeHtml(annotation.title)}</strong>
        <p class="small">ID: ${escapeHtml(annotation.id)} | 正文命中: ${count}</p>
        <p class="small">${escapeHtml(annotation.body.slice(0, 48))}${annotation.body.length > 48 ? "..." : ""}</p>
        <button type="button" data-action="open-ann" data-ann-id="${escapeAttr(annotation.id)}">打開注釋</button>
      `;
      typeSection.appendChild(item);
    });

    wrapper.appendChild(typeSection);
  }

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "small";
    empty.textContent = "沒有符合搜尋的注釋。";
    wrapper.appendChild(empty);
  }

  return wrapper;
}

/* ================================================================
   Render: annotation detail (Joyce Project style)
   ================================================================ */

function renderAnnotationDetail(annotation) {
  const wrapper = document.createElement("div");
  wrapper.className = "annotation-detail";
  const occurrences = collectOccurrences(state.corpus).get(annotation.id) || [];
  const tags = (annotation.tags || []).map((tag) => `<span class="ann-tag">${escapeHtml(tag)}</span>`).join("");
  const links = (annotation.links || []).filter(Boolean);
  const annType = annotation.type || "commentary";
  const hasBack = state.annotationBackStack.length > 0;

  wrapper.innerHTML = `
    <div class="annotation-detail-head">
      ${hasBack ? '<button type="button" class="back-btn" data-action="back" title="返回上一條注釋">← 返回</button>' : ""}
      <span class="ann-type-badge ${annType}">${ANNOTATION_TYPE_LABELS[annType]}</span>
      <p class="small">注釋 ID: ${escapeHtml(annotation.id)}</p>
    </div>
    <h2 class="annotation-title">${escapeHtml(annotation.title)}</h2>
    <div class="annotation-meta">${tags || "<span class='small'>無標籤</span>"}</div>
    <div class="annotation-body">${escapeHtml(annotation.body)}</div>
    <div class="panel-actions">
      <button type="button" data-action="edit-ann">編輯</button>
      <button type="button" data-action="delete-ann">刪除</button>
      <button type="button" data-action="new-ann">新建</button>
      <button type="button" data-action="clear-active">返回總覽</button>
    </div>
    <h3>關聯注釋</h3>
    <div id="linkedList"></div>
    <h3>正文出現位置 (${occurrences.length})</h3>
    <div id="occurrenceList"></div>
  `;

  const linkedList = wrapper.querySelector("#linkedList");
  if (!links.length) {
    linkedList.innerHTML = `<p class="small">目前沒有關聯注釋。</p>`;
  } else {
    links.forEach((linkedId) => {
      const linked = state.corpus.annotations[linkedId];
      const linkedType = linked?.type || "commentary";
      const item = document.createElement("div");
      item.className = "linked-item";
      item.innerHTML = `
        <span class="ann-type-badge small-badge ${linkedType}">${linked ? ANNOTATION_TYPE_LABELS[linkedType] : "?"}</span>
        <strong>${escapeHtml(linked?.title || linkedId)}</strong>
        <p class="small">${escapeHtml(linkedId)}</p>
        <button type="button" data-action="open-ann" data-ann-id="${escapeAttr(linkedId)}">查看</button>
      `;
      linkedList.appendChild(item);
    });
  }

  const occurrenceList = wrapper.querySelector("#occurrenceList");
  if (!occurrences.length) {
    occurrenceList.innerHTML = `<p class="small">目前正文沒有這條注釋的錨點。</p>`;
  } else {
    occurrences.forEach((occurrence) => {
      const item = document.createElement("div");
      item.className = "occurrence-item";
      item.innerHTML = `
        <strong>${escapeHtml(occurrence.sectionTitle)}</strong>
        <p class="small">摘錄：${escapeHtml(occurrence.quote)}</p>
        <p>${escapeHtml(occurrence.context.slice(0, 80))}${occurrence.context.length > 80 ? "..." : ""}</p>
        <button
          type="button"
          data-action="jump"
          data-link-id="${escapeAttr(occurrence.linkId)}"
          data-section-id="${escapeAttr(occurrence.sectionId)}"
          data-paragraph-id="${escapeAttr(occurrence.paragraphId)}"
        >定位到正文</button>
      `;
      occurrenceList.appendChild(item);
    });
  }

  return wrapper;
}

function renderMissingAnnotationPanel(annotationId) {
  const wrapper = document.createElement("div");
  wrapper.className = "panel-intro";
  wrapper.innerHTML = `
    <h2>缺少注釋資料</h2>
    <p>這個錨點指向 <code>${escapeHtml(annotationId)}</code>，但注釋正文不存在。</p>
    <div class="panel-actions">
      <button type="button" data-action="new-ann">建立注釋</button>
      <button type="button" data-action="clear-active">返回總覽</button>
    </div>
  `;
  return wrapper;
}

/* ================================================================
   Render: annotation editor
   ================================================================ */

function renderAnnotationEditor(editorState) {
  const isNew = editorState.mode === "new";
  const existing = state.corpus.annotations[editorState.annId];
  const annotation = isNew
    ? {
        id: editorState.annId || buildNewAnnotationId(),
        type: "commentary",
        title: "",
        body: "",
        tags: [],
        links: []
      }
    : existing;

  const typeOptions = ANNOTATION_TYPES.map((t) => {
    const sel = t === (annotation.type || "commentary") ? "selected" : "";
    return `<option value="${t}" ${sel}>${ANNOTATION_TYPE_LABELS[t]}</option>`;
  }).join("");

  const wrapper = document.createElement("div");
  wrapper.innerHTML = `
    <h2>${isNew ? "新建注釋" : "編輯注釋"}</h2>
    <p class="hint">這裡只編注釋內容。若要掛到正文，請先在正文選字，再建立注釋。</p>
    <form id="annotationEditorForm" onsubmit="saveAnnotationFromForm(this);return false;">
      <label>
        注釋 ID
        <input name="id" type="text" value="${escapeAttr(annotation.id)}" ${isNew ? "" : "readonly"}>
      </label>
      <label>
        標題
        <input name="title" type="text" value="${escapeAttr(annotation.title || "")}" required>
      </label>
      <label>
        類型
        <select name="type">${typeOptions}</select>
      </label>
      <label>
        標籤（逗號分隔）
        <input name="tags" type="text" value="${escapeAttr((annotation.tags || []).join(", "))}">
      </label>
      <label>
        關聯注釋 ID（逗號分隔）
        <input name="links" type="text" value="${escapeAttr((annotation.links || []).join(", "))}">
      </label>
      <label>
        注釋正文
        <textarea name="body" required>${escapeHtml(annotation.body || "")}</textarea>
      </label>
      <div class="editor-buttons">
        <button type="submit">儲存注釋</button>
        <button type="button" data-action="cancel-editor">取消</button>
      </div>
    </form>
  `;
  return wrapper;
}

function renderQuickAnnotationEditor(editorState) {
  const wrapper = document.createElement("div");
  const defaultId = editorState.annId || buildAnnotationIdFromSelection(editorState.selectedText);
  const location = `${editorState.sectionTitle || editorState.sectionId} / ${editorState.paragraphId}`;
  const typeOptions = ANNOTATION_TYPES.map((t) => {
    const sel = t === "commentary" ? "selected" : "";
    return `<option value="${t}" ${sel}>${ANNOTATION_TYPE_LABELS[t]}</option>`;
  }).join("");

  wrapper.innerHTML = `
    <h2>為選區建立注釋</h2>
    <p class="hint">選取文本：<strong>${escapeHtml(editorState.selectedText)}</strong></p>
    <p class="small">位置：${escapeHtml(location)}</p>
    <form id="quickAnnotationForm" onsubmit="saveQuickAnnotationFromForm(this);return false;">
      <input name="sectionId" type="hidden" value="${escapeAttr(editorState.sectionId)}">
      <input name="paragraphId" type="hidden" value="${escapeAttr(editorState.paragraphId)}">
      <input name="plainStart" type="hidden" value="${escapeAttr(String(editorState.plainStart))}">
      <input name="plainEnd" type="hidden" value="${escapeAttr(String(editorState.plainEnd))}">
      <input name="selectedText" type="hidden" value="${escapeAttr(editorState.selectedText)}">
      <label>
        注釋 ID
        <input name="id" type="text" value="${escapeAttr(defaultId)}" required>
      </label>
      <label>
        標題
        <input name="title" type="text" value="${escapeAttr(editorState.selectedText)}" required>
      </label>
      <label>
        類型
        <select name="type">${typeOptions}</select>
      </label>
      <label>
        標籤（逗號分隔）
        <input name="tags" type="text" value="">
      </label>
      <label>
        關聯注釋 ID（逗號分隔）
        <input name="links" type="text" value="">
      </label>
      <label>
        注釋正文
        <textarea name="body" required></textarea>
      </label>
      <div class="editor-buttons">
        <button type="submit">儲存並掛到正文</button>
        <button type="button" data-action="cancel-editor">取消</button>
      </div>
    </form>
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
  const paragraphLinkCount = countLinksForParagraph(selectedSectionId, selectedParagraphId);

  const sectionSelectOptions = sectionOptions
    .map((option) => {
      const selectedAttr = option.id === selectedSectionId ? "selected" : "";
      return `<option value="${escapeAttr(option.id)}" ${selectedAttr}>${escapeHtml(option.title)}</option>`;
    })
    .join("");

  const paragraphSelectOptions = paragraphOptions
    .map((option) => {
      const selectedAttr = option.sectionId === selectedSectionId && option.paragraphId === selectedParagraphId ? "selected" : "";
      return `<option value="${escapeAttr(option.key)}" ${selectedAttr}>${escapeHtml(option.label)}</option>`;
    })
    .join("");

  wrapper.innerHTML = `
    <h2>編輯正文</h2>
    <p class="hint">正文保持純文本。若改寫段落文本，該段既有注釋錨點會一併清除，避免錯位。</p>
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
    <form id="paragraphEditorForm" onsubmit="saveParagraphFromForm(this);return false;">
      <label>
        章節名稱
        <input name="sectionTitle" type="text" value="${escapeAttr(selectedSection?.title || "")}" required>
      </label>
      <label>
        段落
        <select id="paragraphSelect" name="paragraphRef">${paragraphSelectOptions}</select>
      </label>
      <p class="small">本段注釋錨點：${paragraphLinkCount}</p>
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

/* ================================================================
   Annotation save / delete
   ================================================================ */

function saveAnnotationFromForm(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  const editorMode = uiState.editor?.mode || "edit";
  const annId = sanitizeId(payload.id || "");
  if (!annId) {
    setStatus("注釋 ID 不合法。僅允許英文、數字、下劃線、短橫線。", true);
    return;
  }
  if (!String(payload.title || "").trim() || !String(payload.body || "").trim()) {
    setStatus("標題和注釋正文不可為空。", true);
    return;
  }
  if (!state.corpus.annotations[annId] && editorMode !== "new") {
    setStatus("目標注釋不存在。", true);
    return;
  }
  if (editorMode === "new" && state.corpus.annotations[annId]) {
    setStatus(`注釋 ID ${annId} 已存在，請更換。`, true);
    return;
  }

  const annType = ANNOTATION_TYPES.includes(payload.type) ? payload.type : "commentary";

  let createdLink = null;
  if (editorMode === "new" && uiState.pendingSelection) {
    const result = createAnnotationLinkFromSelection({
      annId,
      sectionId: uiState.pendingSelection.sectionId,
      paragraphId: uiState.pendingSelection.paragraphId,
      plainStart: uiState.pendingSelection.plainStart,
      plainEnd: uiState.pendingSelection.plainEnd,
      selectedText: uiState.pendingSelection.selectedText
    });
    if (!result.ok) {
      setStatus(result.error, true);
      return;
    }
    createdLink = result.link;
  }

  const nextAnnotation = {
    id: annId,
    type: annType,
    title: String(payload.title || "").trim(),
    body: String(payload.body || "").trim(),
    tags: splitCSV(payload.tags),
    links: splitCSV(payload.links).map((value) => sanitizeId(value)).filter(Boolean)
  };

  const previousAnnotation = state.corpus.annotations[annId];
  state.corpus.annotations[annId] = nextAnnotation;
  if (createdLink) {
    state.corpus.annotationLinks.push(createdLink);
  }

  state.activeAnnotationId = annId;
  state.activeLinkId = createdLink?.id || "";
  uiState.editor = null;
  clearPendingSelection();
  hideSelectionToolbar();

  const didPersist = persist();
  if (!didPersist) {
    if (createdLink) {
      state.corpus.annotationLinks = state.corpus.annotationLinks.filter((link) => link.id !== createdLink.id);
    }
    if (previousAnnotation) {
      state.corpus.annotations[annId] = previousAnnotation;
    } else {
      delete state.corpus.annotations[annId];
    }
  }
  renderAll();
  if (!didPersist) return;

  if (createdLink) {
    jumpToParagraph(createdLink.sectionId, createdLink.paragraphId);
    setStatus(`注釋 ${annId} 已儲存並掛到正文。`, false);
    return;
  }

  if (editorMode === "new") {
    setStatus(`注釋 ${annId} 已儲存。這是一條未掛接正文的注釋。`, false);
    return;
  }

  setStatus(`注釋 ${annId} 已更新。`, false);
}

function saveParagraphFromForm(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  const [sectionId, paragraphId] = String(payload.paragraphRef || "").split("::");
  const section = findSectionById(sectionId);
  const paragraph = findParagraphByIds(sectionId, paragraphId);
  if (!section || !paragraph) {
    setStatus("未找到目標段落。", true);
    return;
  }

  const nextSectionTitle = String(payload.sectionTitle || "").trim();
  const nextText = stripAngleBrackets(String(payload.text || "").trim());
  if (!nextSectionTitle) {
    setStatus("章節名稱不可為空。", true);
    return;
  }

  const textChanged = paragraph.text !== nextText;
  section.title = nextSectionTitle;
  paragraph.text = nextText;

  let removedLinks = 0;
  if (textChanged) {
    removedLinks = removeLinksForParagraph(sectionId, paragraphId);
    if (state.activeLinkId && !findLinkById(state.activeLinkId)) {
      state.activeLinkId = null;
    }
  }

  uiState.editor = null;
  const didPersist = persist();
  renderAll();
  if (!didPersist) return;

  if (removedLinks) {
    setStatus(`段落已更新，並清除了本段 ${removedLinks} 個注釋錨點。`, false);
    return;
  }
  setStatus(`段落 ${paragraphId} 已更新。`, false);
}

function getParagraphEditorSelection() {
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

function saveQuickAnnotationFromForm(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  const annId = sanitizeId(payload.id || "");
  if (!annId) {
    setStatus("注釋 ID 不合法。僅允許英文、數字、下劃線、短橫線。", true);
    return;
  }
  if (state.corpus.annotations[annId]) {
    setStatus(`注釋 ID ${annId} 已存在，請更換。`, true);
    return;
  }
  if (!String(payload.title || "").trim() || !String(payload.body || "").trim()) {
    setStatus("標題和注釋正文不可為空。", true);
    return;
  }

  const result = createAnnotationLinkFromSelection({
    annId,
    sectionId: String(payload.sectionId || ""),
    paragraphId: String(payload.paragraphId || ""),
    plainStart: Number.parseInt(String(payload.plainStart || "-1"), 10),
    plainEnd: Number.parseInt(String(payload.plainEnd || "-1"), 10),
    selectedText: String(payload.selectedText || "")
  });
  if (!result.ok) {
    setStatus(result.error, true);
    return;
  }

  const annType = ANNOTATION_TYPES.includes(payload.type) ? payload.type : "commentary";

  state.corpus.annotations[annId] = {
    id: annId,
    type: annType,
    title: String(payload.title || "").trim(),
    body: String(payload.body || "").trim(),
    tags: splitCSV(payload.tags),
    links: splitCSV(payload.links).map((value) => sanitizeId(value)).filter(Boolean)
  };
  state.corpus.annotationLinks.push(result.link);

  state.activeAnnotationId = annId;
  state.activeLinkId = result.link.id;
  uiState.editor = null;
  clearPendingSelection();
  hideSelectionToolbar();

  const didPersist = persist();
  renderAll();
  if (!didPersist) return;

  jumpToParagraph(result.link.sectionId, result.link.paragraphId);
  setStatus(`注釋 ${annId} 已建立並定位。`, false);
}

function deleteAnnotationInteractive(annId) {
  const annotation = state.corpus.annotations[annId];
  if (!annotation) return;
  const occurrenceCount = countOccurrencesForAnnotation(annId);
  const confirmed = window.confirm(`確認刪除注釋 ${annId}？這會一併移除 ${occurrenceCount} 個正文錨點。`);
  if (!confirmed) return;

  delete state.corpus.annotations[annId];
  state.corpus.annotationLinks = state.corpus.annotationLinks.filter((link) => link.annId !== annId);
  state.activeAnnotationId = null;
  state.activeLinkId = null;
  state.annotationBackStack = [];
  uiState.editor = null;

  const didPersist = persist();
  renderAll();
  if (!didPersist) return;
  setStatus(`注釋 ${annId} 已刪除。`, false);
}

/* ================================================================
   Annotation navigation
   ================================================================ */

function openAnnotation(annId, linkId = "") {
  if (state.activeAnnotationId && state.activeAnnotationId !== annId) {
    state.annotationBackStack.push({
      annotationId: state.activeAnnotationId,
      linkId: state.activeLinkId
    });
  }
  state.activeAnnotationId = annId;
  state.activeLinkId = linkId || "";
  uiState.editor = null;
  clearPendingSelection();
  hideSelectionToolbar();
  renderAll();
}

function navigateBack() {
  if (!state.annotationBackStack.length) return;
  const prev = state.annotationBackStack.pop();
  state.activeAnnotationId = prev.annotationId;
  state.activeLinkId = prev.linkId || "";
  uiState.editor = null;
  renderAll();
}

function jumpToParagraph(sectionId, paragraphId) {
  const anchor = document.getElementById(buildParagraphAnchor(sectionId, paragraphId));
  if (!anchor) return;
  anchor.scrollIntoView({ behavior: "smooth", block: "center" });
  anchor.animate(
    [
      { backgroundColor: "rgba(249, 235, 184, 0.95)" },
      { backgroundColor: "rgba(255, 248, 240, 0.75)" }
    ],
    { duration: 1200, easing: "ease-out" }
  );
}

/* ================================================================
   Text selection → annotation
   ================================================================ */

function syncSelectionState() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    hideSelectionToolbar();
    return;
  }

  const range = selection.getRangeAt(0);
  const paragraphEl = findSelectionParagraphElement(range);
  if (!paragraphEl) {
    clearPendingSelection();
    hideSelectionToolbar();
    return;
  }

  if (selectionTouchesAnnotation(range)) {
    clearPendingSelection();
    hideSelectionToolbar();
    return;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText) {
    clearPendingSelection();
    hideSelectionToolbar();
    return;
  }

  const before = range.cloneRange();
  before.selectNodeContents(paragraphEl);
  before.setEnd(range.startContainer, range.startOffset);
  const plainStart = before.toString().length;
  const plainEnd = plainStart + selection.toString().length;

  const sectionId = paragraphEl.dataset.sectionId || "";
  const paragraphId = paragraphEl.dataset.paragraphId || "";
  const paragraph = findParagraphByIds(sectionId, paragraphId);
  if (!paragraph) {
    clearPendingSelection();
    hideSelectionToolbar();
    return;
  }

  if (plainStart < 0 || plainEnd <= plainStart || plainEnd > paragraph.text.length) {
    clearPendingSelection();
    hideSelectionToolbar();
    return;
  }

  const links = getLinksForParagraph(sectionId, paragraphId);
  if (selectionOverlapsAnnotationLinks(links, plainStart, plainEnd)) {
    clearPendingSelection();
    hideSelectionToolbar();
    return;
  }

  const section = findSectionById(sectionId);
  uiState.pendingSelection = {
    sectionId,
    sectionTitle: section?.title || sectionId,
    paragraphId,
    plainStart,
    plainEnd,
    selectedText
  };
  showSelectionToolbar(range);
}

function findSelectionParagraphElement(range) {
  const startElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer
      : range.endContainer.parentElement;
  const startParagraph = startElement?.closest?.(".section-paragraph");
  const endParagraph = endElement?.closest?.(".section-paragraph");
  if (!startParagraph || !endParagraph) return null;
  if (startParagraph !== endParagraph) return null;
  if (!refs.textRoot.contains(startParagraph)) return null;
  return startParagraph;
}

function selectionTouchesAnnotation(range) {
  const startElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
  const endElement =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer
      : range.endContainer.parentElement;
  if (startElement?.closest?.(".ann-token") || endElement?.closest?.(".ann-token")) {
    return true;
  }
  const fragment = range.cloneContents();
  if (typeof fragment.querySelector === "function" && fragment.querySelector(".ann-token")) {
    return true;
  }
  return false;
}

function startQuickAnnotationFromSelection() {
  if (!uiState.pendingSelection) {
    setStatus("請先在正文中選取文字。", true);
    return;
  }
  uiState.editor = {
    type: "quick-annotation",
    ...uiState.pendingSelection,
    annId: buildAnnotationIdFromSelection(uiState.pendingSelection.selectedText)
  };
  hideSelectionToolbar();
  renderSidePanel();
}

function showSelectionToolbar(range) {
  if (!refs.selectionToolbar) return;
  const rect = range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    hideSelectionToolbar();
    return;
  }
  const margin = 12;
  const x = Math.min(window.innerWidth - margin, Math.max(margin, rect.left + rect.width / 2));
  const y = Math.max(margin, rect.top - 8);
  refs.selectionToolbar.style.left = `${x}px`;
  refs.selectionToolbar.style.top = `${y}px`;
  refs.selectionToolbar.hidden = false;
}

function hideSelectionToolbar() {
  if (refs.selectionToolbar) {
    refs.selectionToolbar.hidden = true;
  }
}

function clearPendingSelection() {
  uiState.pendingSelection = null;
}

/* ================================================================
   Hover preview (Joyce Project style)
   ================================================================ */

let hoverTimer = null;
let hoverPreviewEl = null;

function handleAnnotationTokenHover(token, eventType, event) {
  if (eventType === "enter") {
    if (hoverTimer) clearTimeout(hoverTimer);
    const annId = token.dataset.annId || "";
    const annotation = state.corpus.annotations[annId];
    if (!annotation) return;
    hoverTimer = setTimeout(() => {
      const rect = token.getBoundingClientRect();
      showAnnotationPreview(annotation, rect.left + rect.width / 2, rect.bottom + 4);
    }, 300);
  } else {
    if (hoverTimer) clearTimeout(hoverTimer);
    hideAnnotationPreview();
  }
}

function showAnnotationPreview(annotation, x, y) {
  hideAnnotationPreview();
  hoverPreviewEl = document.createElement("div");
  hoverPreviewEl.className = "annotation-preview";
  const annType = annotation.type || "commentary";
  hoverPreviewEl.innerHTML = `
    <span class="ann-type-badge small-badge ${annType}">${ANNOTATION_TYPE_LABELS[annType]}</span>
    <strong>${escapeHtml(annotation.title)}</strong>
    <p>${escapeHtml(annotation.body.slice(0, 100))}${annotation.body.length > 100 ? "..." : ""}</p>
  `;
  hoverPreviewEl.style.left = `${x}px`;
  hoverPreviewEl.style.top = `${y}px`;
  document.body.appendChild(hoverPreviewEl);

  // Adjust if off-screen
  const previewRect = hoverPreviewEl.getBoundingClientRect();
  if (previewRect.right > window.innerWidth - 10) {
    hoverPreviewEl.style.left = `${window.innerWidth - previewRect.width - 10}px`;
  }
  if (previewRect.bottom > window.innerHeight - 10) {
    hoverPreviewEl.style.top = `${y - previewRect.height - 8}px`;
  }
}

function hideAnnotationPreview() {
  if (hoverPreviewEl) {
    hoverPreviewEl.remove();
    hoverPreviewEl = null;
  }
}

/* ================================================================
   Section/paragraph CRUD
   ================================================================ */

function addSectionInteractive() {
  const title = window.prompt("新章節標題", "");
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
  removeLinksForSection(sectionId);
  state.corpus.sections.splice(index, 1);
  if (state.activeAnnotationId && !countOccurrencesForAnnotation(state.activeAnnotationId)) {
    state.activeAnnotationId = null;
    state.activeLinkId = null;
  }
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
  removeLinksForParagraph(sectionId, paragraphId);
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

/* ================================================================
   Search / query matching
   ================================================================ */

function paragraphMatchesQuery(paragraph, paragraphLinks, occurrences) {
  if (!state.query) return true;
  const paragraphText = String(paragraph.text || "").toLowerCase();
  if (paragraphText.includes(state.query)) return true;
  return paragraphLinks.some((link) => {
    const annotation = state.corpus.annotations[link.annId];
    if (!annotation) return false;
    const haystack = `${annotation.id} ${annotation.title} ${annotation.body} ${(annotation.tags || []).join(" ")}`.toLowerCase();
    if (haystack.includes(state.query)) return true;
    return (occurrences.get(link.annId) || []).some((occurrence) => occurrence.paragraphId === paragraph.id);
  });
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

/* ================================================================
   Link helpers
   ================================================================ */

function collectOccurrences(corpus) {
  const occurrences = new Map();
  const sectionTitles = new Map(corpus.sections.map((section) => [section.id, section.title]));
  corpus.annotationLinks.forEach((link) => {
    const paragraph = findParagraphByIds(link.sectionId, link.paragraphId, corpus);
    if (!paragraph) return;
    const quote = paragraph.text.slice(link.start, link.end) || link.quote || "";
    if (!occurrences.has(link.annId)) {
      occurrences.set(link.annId, []);
    }
    occurrences.get(link.annId).push({
      linkId: link.id,
      annId: link.annId,
      sectionId: link.sectionId,
      sectionTitle: sectionTitles.get(link.sectionId) || link.sectionId,
      paragraphId: link.paragraphId,
      context: paragraph.text,
      quote
    });
  });
  return occurrences;
}

function buildParagraphAnchor(sectionId, paragraphId) {
  return `paragraph-${sectionId}-${paragraphId}`;
}

function buildParagraphKey(sectionId, paragraphId) {
  return `${sectionId}::${paragraphId}`;
}

function findSectionById(sectionId, corpus = state.corpus) {
  return corpus.sections.find((section) => section.id === sectionId) || null;
}

function findParagraphByIds(sectionId, paragraphId, corpus = state.corpus) {
  const section = findSectionById(sectionId, corpus);
  if (!section) return null;
  return section.paragraphs.find((paragraph) => paragraph.id === paragraphId) || null;
}

function findLinkById(linkId) {
  return state.corpus.annotationLinks.find((link) => link.id === linkId) || null;
}

function groupLinksByParagraph(links) {
  const map = new Map();
  links.forEach((link) => {
    const key = buildParagraphKey(link.sectionId, link.paragraphId);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(link);
  });
  map.forEach((paragraphLinks) => {
    paragraphLinks.sort((a, b) => a.start - b.start || a.end - b.end);
  });
  return map;
}

function getLinksForParagraph(sectionId, paragraphId) {
  return state.corpus.annotationLinks
    .filter((link) => link.sectionId === sectionId && link.paragraphId === paragraphId)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function normalizeRenderableLinks(text, links) {
  const result = [];
  let lastEnd = -1;
  links.forEach((link) => {
    if (!Number.isInteger(link.start) || !Number.isInteger(link.end)) return;
    if (link.start < 0 || link.end <= link.start || link.end > text.length) return;
    if (link.start < lastEnd) return;
    result.push(link);
    lastEnd = link.end;
  });
  return result;
}

function buildNewAnnotationId() {
  const base = "ann";
  let index = 1;
  let candidate = `${base}_${index}`;
  while (state.corpus.annotations[candidate]) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
}

function buildAnnotationIdFromSelection(selectedText) {
  const compact = String(selectedText || "").trim().toLowerCase().replace(/\s+/g, "_");
  const safeCompact = compact.replace(/[^a-z0-9_-]/g, "");
  const base = safeCompact ? `ann_${safeCompact.slice(0, 20)}` : "ann";
  let index = 1;
  let candidate = `${base}_${index}`;
  while (state.corpus.annotations[candidate]) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
}

function buildAnnotationLinkId() {
  const existing = new Set(state.corpus.annotationLinks.map((link) => link.id));
  let index = 1;
  let candidate = `link_${index}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `link_${index}`;
  }
  return candidate;
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

function createAnnotationLinkFromSelection({ annId, sectionId, paragraphId, plainStart, plainEnd, selectedText }) {
  const paragraph = findParagraphByIds(sectionId, paragraphId);
  if (!paragraph) {
    return { ok: false, error: "未找到目標段落。" };
  }
  if (!Number.isInteger(plainStart) || !Number.isInteger(plainEnd) || plainStart < 0 || plainEnd <= plainStart) {
    return { ok: false, error: "選區資訊無效，請重新選取。" };
  }
  if (plainEnd > paragraph.text.length) {
    return { ok: false, error: "選區超出段落長度，請重新選取。" };
  }
  const paragraphLinks = getLinksForParagraph(sectionId, paragraphId);
  if (selectionOverlapsAnnotationLinks(paragraphLinks, plainStart, plainEnd)) {
    return { ok: false, error: "選區與既有注釋重疊，請改選純正文。" };
  }
  const quote = paragraph.text.slice(plainStart, plainEnd);
  if (!quote) {
    return { ok: false, error: "選取文本為空，無法建立錨點。" };
  }
  const duplicate = paragraphLinks.find(
    (link) => link.annId === annId && link.start === plainStart && link.end === plainEnd
  );
  if (duplicate) {
    return { ok: false, error: "這個位置已經掛接到同一條注釋。" };
  }
  return {
    ok: true,
    link: {
      id: buildAnnotationLinkId(),
      annId,
      sectionId,
      paragraphId,
      start: plainStart,
      end: plainEnd,
      quote
    }
  };
}

function selectionOverlapsAnnotationLinks(links, start, end) {
  return links.some((link) => start < link.end && end > link.start);
}

function countOccurrencesForAnnotation(annId) {
  return state.corpus.annotationLinks.filter((link) => link.annId === annId).length;
}

function countLinksForParagraph(sectionId, paragraphId) {
  return state.corpus.annotationLinks.filter(
    (link) => link.sectionId === sectionId && link.paragraphId === paragraphId
  ).length;
}

function removeLinksForParagraph(sectionId, paragraphId) {
  const before = state.corpus.annotationLinks.length;
  state.corpus.annotationLinks = state.corpus.annotationLinks.filter(
    (link) => !(link.sectionId === sectionId && link.paragraphId === paragraphId)
  );
  return before - state.corpus.annotationLinks.length;
}

function removeLinksForSection(sectionId) {
  state.corpus.annotationLinks = state.corpus.annotationLinks.filter((link) => link.sectionId !== sectionId);
}

/* ================================================================
   Data validation & normalize
   ================================================================ */

function validateCorpusShape(data) {
  if (!data || typeof data !== "object") {
    throw new Error("JSON 頂層結構錯誤。");
  }
  if (!Array.isArray(data.sections) || typeof data.annotations !== "object") {
    throw new Error("缺少 sections 或 annotations。");
  }
  if (data.annotationLinks != null && !Array.isArray(data.annotationLinks)) {
    throw new Error("annotationLinks 必須是陣列。");
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

function sanitizeId(value) {
  const trimmed = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return "";
  return trimmed;
}

function splitCSV(input) {
  return String(input || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

  const migratedLinks = [];

  corpus.sections = corpus.sections.map((section) => {
    const normalizedSection = {
      id: String(section.id || "").trim(),
      title: String(section.title || "").trim() || "未命名章節",
      paragraphs: Array.isArray(section.paragraphs) ? section.paragraphs : []
    };

    normalizedSection.paragraphs = normalizedSection.paragraphs.map((paragraph) => {
      const paragraphId = String(paragraph.id || "").trim();
      const rawText = stripAngleBrackets(String(paragraph.text || ""));
      const migrated = migrateLegacyParagraphMarkup(rawText);
      migrated.links.forEach((link) => {
        migratedLinks.push({
          id: "",
          annId: link.annId,
          sectionId: normalizedSection.id,
          paragraphId,
          start: link.start,
          end: link.end,
          quote: link.quote
        });
      });
      return {
        id: paragraphId,
        text: migrated.text
      };
    });

    return normalizedSection;
  });

  const existingKeys = new Set();
  const normalizedLinks = [];

  corpus.annotationLinks.forEach((link) => {
    const normalized = normalizeLinkRecord(link, corpus);
    if (!normalized) return;
    const key = buildLinkFingerprint(normalized);
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    normalizedLinks.push(normalized);
  });

  migratedLinks.forEach((link) => {
    const normalized = normalizeLinkRecord(link, corpus);
    if (!normalized) return;
    const key = buildLinkFingerprint(normalized);
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    normalizedLinks.push(normalized);
  });

  normalizedLinks.forEach((link, index) => {
    if (!link.id) {
      link.id = `link_${index + 1}`;
    }
  });

  // Ensure all annotations have a type field (migration from v3)
  Object.values(corpus.annotations).forEach((annotation) => {
    if (!annotation.type || !ANNOTATION_TYPES.includes(annotation.type)) {
      annotation.type = "commentary";
    }
  });

  corpus.annotationLinks = normalizedLinks;
  return corpus;
}

function migrateLegacyParagraphMarkup(rawText) {
  const regex = /\[\[([a-zA-Z0-9_-]+)\|(.+?)\]\]/g;
  let cursor = 0;
  let plainText = "";
  let plainCursor = 0;
  let match;
  const links = [];

  while ((match = regex.exec(rawText)) !== null) {
    const before = rawText.slice(cursor, match.index);
    plainText += before;
    plainCursor += before.length;

    const annId = sanitizeId(match[1]);
    const quote = match[2];
    const start = plainCursor;
    plainText += quote;
    plainCursor += quote.length;
    const end = plainCursor;
    if (annId && quote) {
      links.push({ annId, start, end, quote });
    }
    cursor = regex.lastIndex;
  }

  plainText += rawText.slice(cursor);
  return {
    text: plainText,
    links
  };
}

function normalizeLinkRecord(link, corpus = state.corpus) {
  if (!link || typeof link !== "object") return null;
  const annId = sanitizeId(link.annId || "");
  const sectionId = String(link.sectionId || "").trim();
  const paragraphId = String(link.paragraphId || "").trim();
  const start = Number.parseInt(String(link.start), 10);
  const end = Number.parseInt(String(link.end), 10);
  const id = String(link.id || "").trim();
  const quote = String(link.quote || "");

  if (!annId || !sectionId || !paragraphId) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;

  const paragraph = findParagraphByIds(sectionId, paragraphId, corpus);
  if (!paragraph) {
    return null;
  }
  if (end > paragraph.text.length) {
    return null;
  }

  return {
    id,
    annId,
    sectionId,
    paragraphId,
    start,
    end,
    quote
  };
}

function buildLinkFingerprint(link) {
  return `${link.annId}|${link.sectionId}|${link.paragraphId}|${link.start}|${link.end}`;
}

/* ================================================================
   Storage persistence
   ================================================================ */

function getStorageCandidates() {
  const candidates = [];
  try {
    if (typeof localStorage !== "undefined") {
      candidates.push({ name: "localStorage", storage: localStorage });
    }
  } catch (_error) {
    // Ignore
  }
  try {
    if (typeof sessionStorage !== "undefined") {
      candidates.push({ name: "sessionStorage", storage: sessionStorage });
    }
  } catch (_error) {
    // Ignore
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
        // Try next key
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

  const annCount = Object.keys(state.corpus.annotations).length;
  const linkCount = state.corpus.annotationLinks.length;
  setStatus(`v${APP_VERSION}｜已載入${sourceLabel}。注釋：${annCount} 條，錨點：${linkCount} 個。`, false);
}

function setStatus(message, isError = false) {
  if (!refs.statusBar) return;
  refs.statusBar.textContent = message;
  refs.statusBar.classList.toggle("error", isError);
}

/* ================================================================
   File sync
   ================================================================ */

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
    state.activeAnnotationId = null;
    state.activeLinkId = null;
    state.annotationBackStack = [];
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
    const { parsed, baseUrl } = await fetchProjectJsonFromServer();
    validateCorpusShape(parsed);
    const normalized = normalizeCorpus(parsed);
    runtimeState.projectSnapshot = structuredCloneSafe(normalized);

    if (!hydrateIfEmpty) {
      return true;
    }

    state.corpus = structuredCloneSafe(normalized);
    state.activeAnnotationId = null;
    state.activeLinkId = null;
    state.annotationBackStack = [];
    uiState.editor = null;

    const didPersist = persist({ markDirty: false });
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
    state.activeAnnotationId = null;
    state.activeLinkId = null;
    state.annotationBackStack = [];
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
      state.activeAnnotationId = null;
      state.activeLinkId = null;
      state.annotationBackStack = [];
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
  state.activeAnnotationId = null;
  state.activeLinkId = null;
  state.annotationBackStack = [];
  uiState.editor = null;

  const didPersist = persist({ markDirty: false });
  renderAll();
  if (!didPersist) return;

  setStatus("已還原專案資料。", false);
}

/* ================================================================
   Utilities
   ================================================================ */

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
