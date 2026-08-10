"use strict";

(function sceneManagerApp() {
  const params = new URLSearchParams(window.location.search);
  const demoMode = params.get("demo") === "1";
  const runtimeId = params.get("runtimeId") || "7f59e2d67dde1743";
  const nodeRedBaseUrl = (params.get("nodeRed") || "http://127.0.0.1:1880").replace(/\/$/, "");
  const apiBaseUrl = (params.get("api") || nodeRedBaseUrl).replace(/\/$/, "");
  const apiPrefix = `${apiBaseUrl}/aiban-scenes/${encodeURIComponent(runtimeId)}`;
  const demoStorageKey = "aiban.scene-manager.demo.v2";
  const operator = params.get("operator") || "scene-manager-ui";

  const els = {
    modeBanner: byId("modeBanner"),
    groupList: byId("groupList"),
    sceneList: byId("sceneList"),
    summary: byId("summary"),
    groupBadge: byId("groupBadge"),
    sceneCount: byId("sceneCount"),
    registryJson: byId("registryJson"),
    selectMsg: byId("selectMsg"),
    jumpTarget: byId("jumpTarget"),
    diagramScene: byId("diagramScene"),
    toast: byId("toast"),
    form: byId("sceneForm"),
    sceneName: byId("sceneName"),
    sceneId: byId("sceneId"),
    sceneMode: byId("sceneMode"),
    nodeRedTabId: byId("nodeRedTabId"),
    sceneDesc: byId("sceneDesc"),
    saveButton: document.querySelector("#sceneForm button[type=submit]"),
  };

  const state = {
    groups: [],
    scenes: new Map(),
    selections: new Map(),
    activeGroupId: null,
    activeSceneKey: "",
    editingKey: "",
    loading: false,
  };

  els.sceneDesc.closest(".field").style.display = "none";
  els.sceneDesc.required = false;
  byId("openNodeRedBtn").addEventListener("click", () => openNodeRed(activeScene()));
  byId("copyRegistryBtn").addEventListener("click", copyRegistry);
  byId("resetFormBtn").addEventListener("click", resetForm);
  els.sceneName.addEventListener("input", fillSceneId);
  els.sceneId.addEventListener("input", () => {
    els.sceneId.dataset.manual = "1";
  });
  els.form.addEventListener("submit", saveScene);

  start();

  async function start() {
    setModeBanner();
    try {
      await refreshAll();
    } catch (error) {
      state.loading = false;
      render();
      showError(error);
    }
  }

  async function refreshAll() {
    state.loading = true;
    render();
    if (demoMode) {
      loadDemo();
    } else {
      const metadata = await apiRequest("/metadata");
      state.groups = (metadata.groups || []).map(normalizeGroup);
      if (state.groups.length === 0) {
        throw new ClientError(
          "METADATA_UNAVAILABLE",
          "Runtime 尚未提供分组元数据；请先确认 aiban-runtime 已 READY。"
        );
      }
      await Promise.all(state.groups.map((group) => loadGroup(group.group_id)));
    }
    if (!state.groups.some((group) => group.group_id === state.activeGroupId)) {
      state.activeGroupId = state.groups[0]?.group_id ?? null;
    }
    selectFirstIfNeeded();
    state.loading = false;
    setModeBanner();
    render();
  }

  async function loadGroup(groupId) {
    const [scenes, selection] = await Promise.all([
      apiRequest(`/groups/${groupId}/scenes`),
      apiRequest(`/groups/${groupId}/current`),
    ]);
    state.scenes.set(groupId, scenes || []);
    state.selections.set(groupId, selection || emptySelection(groupId));
  }

  function loadDemo() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(demoStorageKey) || "null");
    } catch (_) {
      saved = null;
    }
    const data = saved || {
      groups: [{
        group_id: 1,
        group_name: "group/1",
        enabled: true,
        sources: [1],
        models: [0],
      }],
      scenes: {
        1: [{
          group_id: 1,
          scene_id: "plug-sequence",
          name: "插接顺序检测",
          mode: "exclusive",
          workflow_id: "group/1/scene/plug-sequence",
          node_red_tab_id: "tab-group1-plug-sequence",
          enabled: true,
          revision: 1,
        }],
      },
      selections: {
        1: {
          group_id: 1,
          scene_id: "plug-sequence",
          revision: 1,
        },
      },
    };
    state.groups = data.groups.map(normalizeGroup);
    state.scenes = new Map(Object.entries(data.scenes).map(
      ([groupId, scenes]) => [Number(groupId), scenes]
    ));
    state.selections = new Map(Object.entries(data.selections).map(
      ([groupId, selection]) => [Number(groupId), selection]
    ));
  }

  function persistDemo() {
    if (!demoMode) return;
    localStorage.setItem(demoStorageKey, JSON.stringify({
      groups: state.groups,
      scenes: Object.fromEntries(state.scenes),
      selections: Object.fromEntries(state.selections),
    }));
  }

  function setModeBanner(error = null) {
    els.modeBanner.className = "mode-banner";
    if (error) {
      els.modeBanner.classList.add("error");
      els.modeBanner.textContent = `连接失败 · ${error.code}: ${error.message}`;
    } else if (demoMode) {
      els.modeBanner.classList.add("demo");
      els.modeBanner.textContent = "演示模式（?demo=1）· 数据仅保存在本浏览器 localStorage，不会写入 Scene Registry";
    } else {
      els.modeBanner.textContent = state.loading
        ? `真实 Registry 模式 · 正在读取 Runtime ${runtimeId}`
        : `真实 Registry 模式 · Runtime ${runtimeId} · 数据持久化到服务端 SQLite`;
    }
  }

  function render() {
    renderGroups();
    renderScenes();
    renderDetails();
  }

  function renderGroups() {
    els.groupList.innerHTML = "";
    if (state.loading && state.groups.length === 0) {
      els.groupList.innerHTML = '<p class="muted">正在读取 Runtime 分组…</p>';
      return;
    }
    state.groups.forEach((group) => {
      const item = document.createElement("div");
      item.className = `group${group.group_id === state.activeGroupId ? " active" : ""}`;
      item.innerHTML = `
        <div class="group-title">
          <strong>${html(group.group_name)}</strong>
          <span class="badge ${group.enabled ? "" : "amber"}">
            分组${group.enabled ? "启用" : "停用"}
          </span>
        </div>
        <p class="muted" style="margin-top:7px;">
          group_id=${group.group_id} · source=${group.sources.length} · model=${group.models.length}
        </p>`;
      item.addEventListener("click", () => {
        state.activeGroupId = group.group_id;
        selectFirstIfNeeded(true);
        render();
      });
      els.groupList.appendChild(item);
    });
  }

  function renderScenes() {
    const scenes = scenesForGroup(state.activeGroupId);
    const selection = selectionForGroup(state.activeGroupId);
    els.sceneCount.textContent = `${scenes.length} 个场景`;
    els.sceneList.innerHTML = "";
    if (scenes.length === 0) {
      els.sceneList.innerHTML = '<p class="muted">当前分组尚未定义场景。</p>';
      return;
    }

    scenes.forEach((scene) => {
      const current = scene.mode === "exclusive"
        && selection.scene_id === scene.scene_id;
      const card = document.createElement("article");
      card.className = `card${sceneKey(scene) === state.activeSceneKey ? " active" : ""}`;
      card.innerHTML = `
        <div class="card-title">
          <strong>${html(scene.name)}</strong>
          <span>
            <span class="badge ${scene.mode === "parallel" ? "blue" : ""}">${scene.mode}</span>
            <span class="badge ${scene.enabled ? "" : "red"}">场景${scene.enabled ? "启用" : "停用"}</span>
            ${current ? '<span class="badge blue">当前互斥场景</span>' : ""}
          </span>
        </div>
        <p class="muted">${html(scene.workflow_id)}</p>
        <div class="meta">
          <div class="kv"><div class="label">scene_id / revision</div>
            <div class="value">${html(scene.scene_id)} / ${scene.revision}</div></div>
          <div class="kv"><div class="label">Node-RED Tab</div>
            <div class="value">${html(scene.node_red_tab_id || "未绑定")}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn primary" data-action="open" type="button">进入编排</button>
          <button class="btn" data-action="select" type="button"
            ${scene.mode !== "exclusive" || !scene.enabled || current ? "disabled" : ""}>设为当前</button>
          <button class="btn" data-action="toggle" type="button">${scene.enabled ? "停用" : "启用"}</button>
          <button class="btn" data-action="edit" type="button">编辑</button>
          <button class="btn danger" data-action="delete" type="button">删除</button>
        </div>`;
      card.addEventListener("click", (event) => {
        if (!event.target.closest("button")) {
          state.activeSceneKey = sceneKey(scene);
          render();
        }
      });
      card.querySelector('[data-action="open"]').addEventListener("click", () => openNodeRed(scene));
      card.querySelector('[data-action="select"]').addEventListener("click", () => selectScene(scene));
      card.querySelector('[data-action="toggle"]').addEventListener("click", () => toggleScene(scene));
      card.querySelector('[data-action="edit"]').addEventListener("click", () => editScene(scene));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteScene(scene));
      els.sceneList.appendChild(card);
    });
  }

  function renderDetails() {
    const group = activeGroup();
    const scene = activeScene();
    if (!group) {
      els.groupBadge.textContent = "无 Runtime 分组";
      els.summary.textContent = state.loading ? "正在加载…" : "Runtime 未返回分组";
      els.registryJson.textContent = "{}";
      els.selectMsg.textContent = "{}";
      els.jumpTarget.textContent = "{}";
      return;
    }
    els.groupBadge.textContent = `${group.group_name} / group_id=${group.group_id}`;
    els.summary.textContent = scene
      ? `当前查看：${scene.name}；分组、场景启用和当前互斥场景为三个独立状态。`
      : `当前分组：${group.group_name}；尚未定义场景。`;
    els.diagramScene.textContent = scene ? scene.workflow_id : `${group.group_name}/未选择`;
    els.registryJson.textContent = JSON.stringify(registryView(), null, 2);
    els.selectMsg.textContent = JSON.stringify({
      method: "POST",
      url: scene
        ? `${apiPrefix}/groups/${scene.group_id}/current`
        : "",
      body: scene ? {
        scene_id: scene.scene_id,
        selection_revision: selectionForGroup(scene.group_id).revision,
        operator,
      } : {},
    }, null, 2);
    els.jumpTarget.textContent = JSON.stringify(jumpInfo(scene), null, 2);
  }

  async function saveScene(event) {
    event.preventDefault();
    const groupId = state.activeGroupId;
    const id = slug(els.sceneId.value);
    const existing = state.editingKey
      ? scenesForGroup(groupId).find((scene) => sceneKey(scene) === state.editingKey)
      : null;
    const body = {
      scene_id: id,
      name: els.sceneName.value.trim(),
      mode: els.sceneMode.value,
      workflow_id: existing?.workflow_id || `group/${groupId}/scene/${id}`,
      node_red_tab_id: els.nodeRedTabId.value.trim() || null,
      operator,
    };
    if (!body.scene_id || !body.name) {
      notify("场景名称和 scene_id 不能为空");
      return;
    }

    await mutate(async () => {
      if (demoMode) {
        demoSave(existing, body);
      } else if (existing) {
        await apiRequest(
          `/groups/${groupId}/scenes/${encodeURIComponent(existing.scene_id)}`,
          {
            method: "PUT",
            body: { ...body, revision: existing.revision },
          }
        );
      } else {
        await apiRequest(`/groups/${groupId}/scenes`, {
          method: "POST",
          body,
        });
      }
      state.activeSceneKey = `${groupId}:${body.scene_id}`;
      resetForm();
      notify(existing ? "场景已更新" : "场景已创建（默认停用）");
    }, groupId);
  }

  function demoSave(existing, body) {
    const scenes = scenesForGroup(state.activeGroupId);
    const next = {
      group_id: state.activeGroupId,
      ...body,
      enabled: existing?.enabled || false,
      revision: (existing?.revision || 0) + 1,
    };
    delete next.operator;
    const index = scenes.findIndex((scene) => sceneKey(scene) === state.editingKey);
    if (index >= 0) scenes[index] = next;
    else scenes.push(next);
    state.scenes.set(state.activeGroupId, scenes);
  }

  async function toggleScene(scene) {
    const wasEnabled = scene.enabled;
    await mutate(async () => {
      if (demoMode) {
        scene.enabled = !scene.enabled;
        scene.revision++;
        if (!scene.enabled && selectionForGroup(scene.group_id).scene_id === scene.scene_id) {
          const selection = selectionForGroup(scene.group_id);
          selection.scene_id = null;
          selection.revision++;
        }
      } else {
        await apiRequest(
          `/groups/${scene.group_id}/scenes/${encodeURIComponent(scene.scene_id)}/${scene.enabled ? "disable" : "enable"}`,
          { method: "POST", body: { revision: scene.revision, operator } }
        );
      }
      notify(wasEnabled ? "场景已停用；Runtime 保持运行" : "场景已启用；Runtime 状态未改变");
    }, scene.group_id);
  }

  async function selectScene(scene) {
    const selection = selectionForGroup(scene.group_id);
    await mutate(async () => {
      if (demoMode) {
        selection.scene_id = scene.scene_id;
        selection.revision++;
      } else {
        await apiRequest(`/groups/${scene.group_id}/current`, {
          method: "POST",
          body: {
            scene_id: scene.scene_id,
            selection_revision: selection.revision,
            operator,
          },
        });
      }
      state.activeSceneKey = sceneKey(scene);
      notify("当前互斥场景已切换；Runtime 未重启");
    }, scene.group_id);
  }

  async function deleteScene(scene) {
    if (!window.confirm(`确认删除场景 ${scene.name}？`)) return;
    await mutate(async () => {
      if (demoMode) {
        state.scenes.set(
          scene.group_id,
          scenesForGroup(scene.group_id).filter((item) => sceneKey(item) !== sceneKey(scene))
        );
      } else {
        await apiRequest(
          `/groups/${scene.group_id}/scenes/${encodeURIComponent(scene.scene_id)}`,
          { method: "DELETE", body: { revision: scene.revision, operator } }
        );
      }
      state.activeSceneKey = "";
      notify("场景已删除");
    }, scene.group_id);
  }

  async function mutate(operation, groupId) {
    try {
      await operation();
      if (demoMode) {
        persistDemo();
      } else {
        await loadGroup(groupId);
      }
      selectFirstIfNeeded();
      setModeBanner();
      render();
    } catch (error) {
      if (error.code === "CONFLICT" && !demoMode) {
        await loadGroup(groupId).catch(() => {});
        render();
      }
      showError(error);
    }
  }

  async function apiRequest(path, options = {}) {
    const requestId = crypto.randomUUID
      ? crypto.randomUUID()
      : `scene-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const init = {
      method: options.method || "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    };
    if (options.body) {
      init.headers["Content-Type"] = "application/json";
      init.headers["X-Request-Id"] = requestId;
      init.body = JSON.stringify({ ...options.body, request_id: requestId });
    }
    let response;
    try {
      response = await fetch(`${apiPrefix}${path}`, init);
    } catch (cause) {
      throw new ClientError(
        "NETWORK_ERROR",
        `无法连接 Scene Registry (${apiBaseUrl})`,
        { cause }
      );
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch (_) {
      throw new ClientError("INVALID_RESPONSE", `服务返回了非 JSON 响应（HTTP ${response.status}）`);
    }
    if (!response.ok || envelope.success === false) {
      throw new ClientError(
        envelope.error_code || `HTTP_${response.status}`,
        envelope.message || "Scene Registry 请求失败",
        envelope.details
      );
    }
    return envelope.data;
  }

  function showError(error) {
    const code = error.code || "UNKNOWN_ERROR";
    const hints = {
      CONFLICT: "数据已被其他用户修改，列表已刷新，请确认后重试。",
      FORBIDDEN: "当前 Node-RED 用户没有对应的 Scene Registry 权限。",
      NETWORK_ERROR: "请确认 Node-RED 已启动、地址正确且浏览器允许访问。",
      METADATA_UNAVAILABLE: "Runtime READY 后刷新页面。",
    };
    const message = `${code}: ${error.message}${hints[code] ? `；${hints[code]}` : ""}`;
    setModeBanner({ code, message: error.message });
    notify(message, 5200);
  }

  function editScene(scene) {
    state.activeSceneKey = sceneKey(scene);
    state.editingKey = sceneKey(scene);
    els.sceneName.value = scene.name;
    els.sceneId.value = scene.scene_id;
    els.sceneId.readOnly = true;
    els.sceneId.dataset.manual = "1";
    els.sceneMode.value = scene.mode;
    els.nodeRedTabId.value = scene.node_red_tab_id || "";
    els.saveButton.textContent = `保存 revision ${scene.revision}`;
    render();
  }

  function resetForm() {
    els.form.reset();
    state.editingKey = "";
    els.sceneId.readOnly = false;
    els.sceneId.dataset.manual = "0";
    els.saveButton.textContent = "保存场景";
  }

  function fillSceneId() {
    if (els.sceneId.dataset.manual === "1") return;
    els.sceneId.value = slug(els.sceneName.value);
  }

  function openNodeRed(scene) {
    if (!scene) {
      notify("请先选择或创建场景");
      return;
    }
    state.activeSceneKey = sceneKey(scene);
    render();
    if (!scene.node_red_tab_id) {
      notify("该场景尚未绑定 Node-RED Tab；请先在 Registry 中填写 node_red_tab_id。", 5200);
      return;
    }
    window.open(
      `${nodeRedBaseUrl}/#flow/${encodeURIComponent(scene.node_red_tab_id)}`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  function jumpInfo(scene) {
    if (!scene) return { url: null, warning: "未选择场景" };
    if (!scene.node_red_tab_id) {
      return {
        url: null,
        node_red_tab_id: null,
        workflow_id: scene.workflow_id,
        warning: "未绑定 Node-RED Tab，禁止按 workflow_id 猜测跳转。",
      };
    }
    return {
      url: `${nodeRedBaseUrl}/#flow/${encodeURIComponent(scene.node_red_tab_id)}`,
      node_red_tab_id: scene.node_red_tab_id,
      workflow_id: scene.workflow_id,
    };
  }

  function registryView() {
    return {
      mode: demoMode ? "DEMO_LOCALSTORAGE" : "SCENE_REGISTRY_API",
      runtime_id: runtimeId,
      groups: state.groups,
      scenes: [...state.scenes.values()].flat(),
      selections: [...state.selections.values()],
    };
  }

  function activeGroup() {
    return state.groups.find((group) => group.group_id === state.activeGroupId) || null;
  }

  function activeScene() {
    return [...state.scenes.values()].flat().find(
      (scene) => sceneKey(scene) === state.activeSceneKey
    ) || scenesForGroup(state.activeGroupId)[0] || null;
  }

  function scenesForGroup(groupId) {
    return state.scenes.get(Number(groupId)) || [];
  }

  function selectionForGroup(groupId) {
    return state.selections.get(Number(groupId)) || emptySelection(Number(groupId));
  }

  function selectFirstIfNeeded(force = false) {
    const current = activeScene();
    if (!current || force) {
      const first = scenesForGroup(state.activeGroupId)[0];
      state.activeSceneKey = first ? sceneKey(first) : "";
    }
  }

  function normalizeGroup(group) {
    const groupId = Number(group.group_id);
    return {
      ...group,
      group_id: groupId,
      group_name: group.group_name || group.name || `group/${groupId}`,
      enabled: group.enabled !== false,
      sources: Array.isArray(group.sources)
        ? group.sources
        : Array.isArray(group.source_ids)
          ? group.source_ids
          : [],
      models: Array.isArray(group.models)
        ? group.models
        : Array.isArray(group.model_ids)
          ? group.model_ids
          : [],
    };
  }

  function emptySelection(groupId) {
    return {
      group_id: groupId,
      scene_id: null,
      revision: 0,
    };
  }

  function sceneKey(scene) {
    return `${scene.group_id}:${scene.scene_id}`;
  }

  function slug(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function html(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function copyRegistry() {
    copyText(JSON.stringify(registryView(), null, 2), "场景注册表已复制");
  }

  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      notify(message);
    } catch (_) {
      notify("浏览器未允许复制，请手动复制 JSON 内容。");
    }
  }

  function notify(message, duration = 2600) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => els.toast.classList.remove("show"), duration);
  }

  function byId(id) {
    return document.getElementById(id);
  }

  class ClientError extends Error {
    constructor(code, message, details = null) {
      super(message);
      this.name = "ClientError";
      this.code = code;
      this.details = details;
    }
  }
})();
