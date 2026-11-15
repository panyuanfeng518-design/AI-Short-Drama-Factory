
(() => {
  "use strict";

  // ==========================================
  // AI短剧工厂 · 人物演员管理 V2
  // 保留原有 IndexedDB 和人物图片
  // ==========================================

  const DB_NAME = "AIShortDramaStage2DB";
  const DB_VERSION = 1;
  const STORE = "people";

  const $ = id => document.getElementById(id);

  const FIELDS = [
    "age", "gender", "height", "identity",
    "mood", "look", "hair", "clothes",
    "props", "extra"
  ];

  const FIELD_LABELS = {
    age: "年龄",
    gender: "性别",
    height: "身高",
    identity: "人物身份",
    mood: "性格气质",
    look: "外貌特征",
    hair: "发型",
    clothes: "服装",
    props: "道具配饰",
    extra: "其他特征"
  };

  let db = null;
  let importedCharacters = [];

  // ==========================================
  // IndexedDB
  // ==========================================

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onerror = () => reject(request.error);
    });
  }

  async function getAllPeople() {
    const database = db || await openDB();

    return new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async function getPerson(id) {
    const database = db || await openDB();

    return new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function savePersonRecord(person) {
    const database = db || await openDB();

    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, "readwrite");

      tx.objectStore(STORE).put(person);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ==========================================
  // 工具
  // ==========================================

  function uid() {
    return "ai_" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 9);
  }

  function normalizeName(name) {
    return String(name || "")
      .normalize("NFKC")
      .replace(/[\s\u3000]+/g, "")
      .toLowerCase();
  }

  function isLocked(person) {
    return !!person.locked ||
      person.reviewStatus === "locked";
  }

  function getStatus(person) {
    if (isLocked(person)) return "locked";

    if (person.reviewStatus === "confirmed") {
      return "confirmed";
    }

    return "pending";
  }

  function statusLabel(person) {
    const s = getStatus(person);

    if (s === "locked") return "🔒 演员已锁定";
    if (s === "confirmed") return "✓ 资料已确认";

    return "⏳ 待确认";
  }

  function safeText(value, max = 1000) {
    return String(value || "").trim().slice(0, max);
  }

  function setStatus(message, type = "") {
    const el = $("v2Status");

    if (!el) return;

    el.textContent = message;
    el.className = "status " + type;
  }

  // ==========================================
  // 样式
  // ==========================================

  function installStyles() {
    if ($("characterV2Styles")) return;

    const style = document.createElement("style");
    style.id = "characterV2Styles";

    style.textContent = `
      .v2-toolbar {
        display:flex;
        flex-wrap:wrap;
        gap:8px;
        margin:12px 0;
      }

      .v2-toolbar button {
        flex:1;
        min-width:100px;
      }

      .v2-person-card {
        background:#0d1426;
        border:1px solid #34405f;
        border-radius:13px;
        padding:13px;
        min-width:0;
      }

      .v2-person-card h3 {
        margin:0 0 8px;
        font-size:16px;
      }

      .v2-person-card p {
        color:#9eabc9;
        font-size:12px;
        white-space:pre-wrap;
        overflow-wrap:anywhere;
      }

      .v2-person-card .actions button {
        flex:1;
        min-width:90px;
      }

      .v2-status {
        display:inline-block;
        padding:4px 9px;
        border-radius:7px;
        font-size:12px;
        margin:4px 0;
        background:#263451;
        color:#dbe4ff;
      }

      .v2-status.pending {
        background:#49391f;
        color:#ffd99a;
      }

      .v2-status.confirmed {
        background:#183c3b;
        color:#8ee9d7;
      }

      .v2-status.locked {
        background:#243c2d;
        color:#a8efb9;
      }

      .v2-filter {
        margin:12px 0;
      }

      .v2-warning {
        padding:10px;
        border-radius:9px;
        background:#392b1c;
        color:#ffd99a;
        font-size:12px;
        margin-top:8px;
      }
    `;

    document.head.append(style);
  }

  // ==========================================
  // 创建管理面板
  // ==========================================

  function createPanel() {
    if ($("characterV2Panel")) return;

    const panel = document.createElement("div");

    panel.id = "characterV2Panel";
    panel.className = "card";

    const title = document.createElement("h2");
    title.textContent = "🎭 人物演员管理 V2";

    const desc = document.createElement("p");
    desc.className = "muted";
    desc.textContent =
      "集中管理所有人物，审核AI资料、编辑演员档案、锁定正式演员。";

    const status = document.createElement("div");
    status.id = "v2Status";
    status.className = "status";
    status.textContent = "正在初始化人物管理系统……";

    const stats = document.createElement("div");
    stats.id = "v2Stats";
    stats.className = "note";

    const filter = document.createElement("select");
    filter.id = "v2Filter";
    filter.className = "v2-filter";

    [
      ["all", "全部人物"],
      ["pending", "待确认"],
      ["confirmed", "已确认"],
      ["locked", "已锁定"]
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      filter.append(option);
    });

    filter.onchange = renderAll;

    const refresh = document.createElement("button");
    refresh.className = "secondary";
    refresh.textContent = "刷新人物列表";
    refresh.onclick = renderAll;

    const toolbar = document.createElement("div");
    toolbar.className = "v2-toolbar";
    toolbar.append(refresh);

    const list = document.createElement("div");
    list.id = "v2PeopleList";
    list.className = "items";

    panel.append(title, desc, stats, status, filter, toolbar, list);

    // 放在人物档案库顶部
    const library = $("library");

    if (library) {
      const firstCard = library.querySelector(".card");

      if (firstCard) {
        library.insertBefore(panel, firstCard);
      } else {
        library.append(panel);
      }
    }

    // 剧本页显示自动入库提示
    createAutoImportPanel();
  }

  function createAutoImportPanel() {
    if ($("autoCharacterPanel")) return;

    const panel = document.createElement("div");
    panel.id = "autoCharacterPanel";
    panel.className = "card";

    const title = document.createElement("h2");
    title.textContent = "AI人物自动入库";

    const desc = document.createElement("p");
    desc.className = "muted";
    desc.textContent =
      "剧本生成后，AI识别的人物会自动进入人物档案。新人物默认待确认。";

    const status = document.createElement("div");
    status.id = "autoCharacterStatus";
    status.className = "status";
    status.textContent = "等待生成剧本。";

    panel.append(title, desc, status);

    const output = $("scriptOutput");

    if (output) {
      output.insertAdjacentElement("afterend", panel);
    }
  }

  // ==========================================
  // 人物管理统计
  // ==========================================

  function renderStats(people) {
    const total = people.length;

    const pending = people.filter(
      p => getStatus(p) === "pending"
    ).length;

    const confirmed = people.filter(
      p => getStatus(p) === "confirmed"
    ).length;

    const locked = people.filter(
      p => getStatus(p) === "locked"
    ).length;

    $("v2Stats").textContent =
      `人物总数：${total} 人 ｜ ` +
      `待确认：${pending} 人 ｜ ` +
      `已确认：${confirmed} 人 ｜ ` +
      `已锁定：${locked} 人`;
  }

  // ==========================================
  // 人物卡片
  // ==========================================

  function createPersonCard(person) {
    const card = document.createElement("div");
    card.className = "v2-person-card";

    const title = document.createElement("h3");
    title.textContent = person.name || "未命名人物";

    const status = document.createElement("span");
    const state = getStatus(person);

    status.className = "v2-status " + state;
    status.textContent = statusLabel(person);

    const info = document.createElement("p");

    info.textContent =
      `${person.age || "年龄未设定"} · ` +
      `${person.gender || "性别未设定"}\n` +
      `${person.identity || "身份待补充"}\n` +
      `主档案：${person.masterBoard ? "已保存" : "未保存"}\n` +
      `辅助视图：${Object.keys(person.images || {}).length}/8`;

    card.append(title, status, info);

    if (person.duplicateWarning) {
      const warning = document.createElement("div");
      warning.className = "v2-warning";
      warning.textContent = "存在同名人物，请人工核对身份，不要直接合并。";
      card.append(warning);
    }

    const actions = document.createElement("div");
    actions.className = "actions";

    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.textContent = "编辑资料";

    edit.onclick = () => {
      if (typeof window.fillPerson === "function") {
        window.fillPerson(person);

        const tab = document.querySelector(
          '[data-tab="people"]'
        );

        if (tab) tab.click();
      } else {
        alert("没有找到原人物编辑功能。");
      }
    };

    actions.append(edit);

    if (state === "pending") {
      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "确认资料";

      confirmBtn.onclick = () => {
        confirmPerson(person.id);
      };

      actions.append(confirmBtn);
    }

    if (state === "confirmed") {
      const lockBtn = document.createElement("button");
      lockBtn.textContent = "🔒 锁定演员";

      lockBtn.onclick = () => {
        lockPerson(person.id);
      };

      actions.append(lockBtn);
    }

    if (state === "locked") {
      const unlockBtn = document.createElement("button");
      unlockBtn.className = "secondary";
      unlockBtn.textContent = "解除锁定";

      unlockBtn.onclick = () => {
        unlockPerson(person.id);
      };

      actions.append(unlockBtn);
    }

    card.append(actions);

    return card;
  }

  // ==========================================
  // 刷新全部人物
  // ==========================================

  async function renderAll() {
    try {
      createPanel();

      const people = await getAllPeople();

      renderStats(people);

      const filter = $("v2Filter")?.value || "all";

      const filtered = people.filter(person => {
        return filter === "all" ||
          getStatus(person) === filter;
      });

      const list = $("v2PeopleList");
      list.replaceChildren();

      if (!filtered.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "当前没有符合条件的人物。";
        list.append(empty);
      }

      filtered.forEach(person => {
        list.append(createPersonCard(person));
      });

      setStatus("人物演员管理已更新。", "ok");

      // 同步原有档案库
      if (
        typeof window.renderLibrary === "function" &&
        !window.__v2RenderingLibrary
      ) {
        window.__v2RenderingLibrary = true;

        try {
          await window.renderLibrary();
        } finally {
          window.__v2RenderingLibrary = false;
        }
      }

    } catch (error) {
      setStatus("读取人物失败：" + error.message, "err");
    }
  }

  // ==========================================
  // 状态修改
  // ==========================================

  async function confirmPerson(id) {
    try {
      const person = await getPerson(id);

      if (!person) throw new Error("人物不存在");

      if (isLocked(person)) {
        throw new Error("人物已经锁定");
      }

      person.reviewStatus = "confirmed";
      person.locked = false;
      person.updatedAt = new Date().toISOString();

      await savePersonRecord(person);

      setStatus("人物资料已确认：" + person.name, "ok");

      await renderAll();

    } catch (error) {
      setStatus("确认失败：" + error.message, "err");
    }
  }

  async function lockPerson(id) {
    try {
      const person = await getPerson(id);

      if (!person) throw new Error("人物不存在");

      if (person.reviewStatus !== "confirmed") {
        alert("请先确认人物资料，再锁定演员。");
        return;
      }

      if (!confirm(
        `确定将「${person.name}」锁定为正式演员吗？\n\n锁定后，AI不会覆盖其人物资料和图片。`
      )) return;

      person.locked = true;
      person.reviewStatus = "locked";
      person.updatedAt = new Date().toISOString();

      await savePersonRecord(person);

      setStatus("演员已正式锁定：" + person.name, "ok");

      await renderAll();

    } catch (error) {
      setStatus("锁定失败：" + error.message, "err");
    }
  }

  async function unlockPerson(id) {
    try {
      const person = await getPerson(id);

      if (!person) throw new Error("人物不存在");

      if (!confirm(
        `确定解除「${person.name}」的演员锁定吗？\n\n解除后，仍然保留现有资料和图片，但允许补充空白字段。`
      )) return;

      person.locked = false;
      person.reviewStatus = "confirmed";
      person.updatedAt = new Date().toISOString();

      await savePersonRecord(person);

      setStatus("演员锁定已解除：" + person.name, "ok");

      await renderAll();

    } catch (error) {
      setStatus("解除锁定失败：" + error.message, "err");
    }
  }

  // ==========================================
  // AI人物自动入库
  // ==========================================

  async function importCharacters(characters) {
    if (!Array.isArray(characters)) return;

    const people = await getAllPeople();

    let created = 0;
    let updated = 0;
    let protectedCount = 0;
    let duplicateCount = 0;

    const imported = [];

    for (const raw of characters) {
      const name = safeText(raw.name, 80);

      if (!name) continue;

      const normalized = normalizeName(name);

      const matches = people.filter(p =>
        normalizeName(p.name) === normalized
      );

      // 同名多条记录：不自动合并
      if (matches.length > 1) {
        duplicateCount++;
        continue;
      }

      const existing = matches[0];

      if (existing) {
        if (isLocked(existing)) {
          protectedCount++;
          imported.push(existing);
          continue;
        }

        let changed = false;

        // 只填补空白字段
        for (const field of FIELDS) {
          const value = safeText(raw[field], 1000);

          if (
            value &&
            !String(existing[field] || "").trim()
          ) {
            existing[field] = value;
            changed = true;
          }
        }

        // 保留原人物图片和定妆档案
        if (!existing.images) {
          existing.images = {};
          changed = true;
        }

        if (changed) {
          existing.updatedAt = new Date().toISOString();

          await savePersonRecord(existing);

          updated++;
        }

        imported.push(existing);

      } else {
        const now = new Date().toISOString();

        const person = {
          id: uid(),
          name,

          age: safeText(raw.age, 30),
          gender: safeText(raw.gender, 30),
          height: safeText(raw.height, 30),
          identity: safeText(raw.identity, 300),
          mood: safeText(raw.mood, 300),
          look: safeText(raw.look, 500),
          hair: safeText(raw.hair, 300),
          clothes: safeText(raw.clothes, 500),
          props: safeText(raw.props, 300),
          extra: safeText(raw.extra, 500),

          masterPrompt: "",
          masterBoard: "",
          images: {},

          reviewStatus: "pending",
          locked: false,

          source: "ai-script",

          createdAt: now,
          updatedAt: now
        };

        await savePersonRecord(person);

        people.push(person);
        imported.push(person);
        created++;
      }
    }

    importedCharacters = imported;

    createAutoImportPanel();

    const message =
      `自动入库完成：新增 ${created} 人，` +
      `补充 ${updated} 人，` +
      `保护已锁定人物 ${protectedCount} 人，` +
      `发现同名歧义 ${duplicateCount} 组。`;

    const status = $("autoCharacterStatus");

    if (status) {
      status.textContent = message;
      status.className = "status ok";
    }

    await renderAll();
  }

  // ==========================================
  // 保护原人物编辑功能
  // ==========================================

  function protectOriginalEditor() {
    // 原 index.html 中 fillPerson(p) 用于加载人物
    if (typeof window.fillPerson === "function") {
      const originalFill = window.fillPerson;

      window.fillPerson = function(person) {
        window.__v2EditingPersonId = person?.id || null;

        return originalFill.apply(this, arguments);
      };
    }

    // 新建人物时清除编辑ID
    const clearButton = $("clearPerson");

    if (clearButton) {
      clearButton.addEventListener("click", () => {
        window.__v2EditingPersonId = null;
      }, true);
    }

    // 拦截原 savePerson 函数
    if (typeof window.savePerson === "function") {
      const originalSave = window.savePerson;

      window.savePerson = async function(...args) {
        const id = window.__v2EditingPersonId;

        if (id) {
          const person = await getPerson(id);

          if (person && isLocked(person)) {
            alert(
              "该演员已经锁定。\n\n" +
              "为了保护正式演员资料，请先到人物演员管理 V2 解除锁定，再进行修改。"
            );

            return null;
          }
        }

        return originalSave.apply(this, args);
      };
    }

    // 拦截原人物库的删除操作
    const peopleList = $("peopleList");

    if (peopleList) {
      peopleList.addEventListener("click", async event => {
        const button = event.target.closest("button");

        if (!button || button.textContent !== "删除") return;

        const card = button.closest(".item");
        const name = card?.querySelector("h3")?.textContent;

        if (!name) return;

        const people = await getAllPeople();

        const locked = people.find(p =>
          p.name === name && isLocked(p)
        );

        if (locked) {
          event.preventDefault();
          event.stopImmediatePropagation();

          alert(
            "该演员已经锁定，不能直接删除。\n\n" +
            "请先在人物演员管理 V2 中解除锁定。"
          );
        }
      }, true);
    }
  }

  // ==========================================
  // 拦截剧本生成接口
  // 等待入库完成后再返回响应
  // ==========================================

  function installFetchInterceptor() {
    if (window.__v2FetchInstalled) return;

    window.__v2FetchInstalled = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async function(...args) {
      const response = await originalFetch(...args);

      const request = args[0];

      const url = typeof request === "string"
        ? request
        : request?.url || "";

      const method = (
        args[1]?.method ||
        request?.method ||
        "GET"
      ).toUpperCase();

      if (
        url.includes("/api/generate") &&
        method === "POST" &&
        response.ok
      ) {
        try {
          const data = await response.clone().json();

          if (Array.isArray(data.characters)) {
            await importCharacters(data.characters);
          }
        } catch (error) {
          const status = $("autoCharacterStatus");

          if (status) {
            status.textContent =
              "人物自动入库失败：" + error.message;

            status.className = "status err";
          }

          console.error("人物自动入库错误：", error);
        }
      }

      return response;
    };
  }

  // ==========================================
  // 初始化
  // ==========================================

  async function init() {
    try {
      installStyles();

      await openDB();

      createPanel();

      protectOriginalEditor();

      installFetchInterceptor();

      await renderAll();

      setStatus("人物演员管理 V2 已启动。", "ok");

    } catch (error) {
      console.error("人物管理 V2 初始化失败：", error);
      setStatus("初始化失败：" + error.message, "err");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
