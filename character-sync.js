
(() => {
  "use strict";

  const DB_NAME = "AIShortDramaStage2DB";
  const STORE = "people";

  const $ = id => document.getElementById(id);

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains("people")) {
          db.createObjectStore("people", {
            keyPath: "id"
          });
        }

        if (!db.objectStoreNames.contains("scenes")) {
          db.createObjectStore("scenes", {
            keyPath: "id"
          });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getPeople(db) {
    return new Promise((resolve, reject) => {
      const request = db
        .transaction(STORE)
        .objectStore(STORE)
        .getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function savePerson(db, person) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");

      tx.objectStore(STORE).put(person);

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  function uid() {
    return "ai_" + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8);
  }

  function normalizeName(name) {
    return String(name || "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  const FIELDS = [
    "age",
    "gender",
    "height",
    "identity",
    "mood",
    "look",
    "hair",
    "clothes",
    "props",
    "extra"
  ];

  function createPanel() {
    if ($("autoCharacterPanel")) return;

    const panel = document.createElement("div");
    panel.id = "autoCharacterPanel";
    panel.className = "card";

    const title = document.createElement("h2");
    title.textContent = "AI人物自动入库";

    const desc = document.createElement("p");
    desc.className = "muted";
    desc.textContent =
      "剧本生成后，AI识别的人物会自动保存到人物档案库。新人物默认待确认。";

    const status = document.createElement("div");
    status.id = "autoCharacterStatus";
    status.className = "status";
    status.textContent = "等待生成剧本。";

    const list = document.createElement("div");
    list.id = "autoCharacterList";
    list.className = "items";

    panel.append(title, desc, status, list);

    const output = $("scriptOutput");

    if (output) {
      output.insertAdjacentElement("afterend", panel);
    } else if ($("script")) {
      $("script").append(panel);
    }
  }

  function showStatus(message, type = "") {
    createPanel();

    const el = $("autoCharacterStatus");

    if (el) {
      el.textContent = message;
      el.className = "status " + type;
    }
  }

  function renderCharacters(characters) {
    createPanel();

    const list = $("autoCharacterList");
    list.replaceChildren();

    characters.forEach(person => {
      const card = document.createElement("div");
      card.className = "item";

      const title = document.createElement("h3");
      title.textContent = person.name;

      const info = document.createElement("p");
      info.textContent =
        `${person.identity || "身份待补充"} · ` +
        `${person.age || "年龄待定"} · ` +
        `${person.gender || "性别待定"}`;

      const state = document.createElement("p");
      state.textContent = person.locked
        ? "🔒 演员已锁定"
        : person.reviewStatus === "confirmed"
          ? "✓ 资料已确认"
          : "⏳ 待确认";

      const actions = document.createElement("div");
      actions.className = "actions";

      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "确认资料";
      confirmBtn.className = "secondary";
      confirmBtn.disabled =
        person.locked ||
        person.reviewStatus === "confirmed";

      confirmBtn.onclick = () =>
        updateStatus(person.id, {
          reviewStatus: "confirmed"
        });

      const lockBtn = document.createElement("button");
      lockBtn.textContent = person.locked
        ? "已锁定"
        : "锁定演员";

      lockBtn.disabled = !!person.locked;

      lockBtn.onclick = async () => {
        if (person.reviewStatus !== "confirmed") {
          alert("请先确认人物资料！");
          return;
        }

        if (!confirm(
          `确定锁定演员 ${person.name} 吗？`
        )) return;

        await updateStatus(person.id, {
          locked: true,
          reviewStatus: "locked"
        });
      };

      actions.append(confirmBtn, lockBtn);
      card.append(title, info, state, actions);
      list.append(card);
    });
  }

  async function updateStatus(id, changes) {
    const db = await openDB();

    try {
      const people = await getPeople(db);
      const person = people.find(p => p.id === id);

      if (!person) {
        throw new Error("找不到人物档案");
      }

      Object.assign(person, changes, {
        updatedAt: new Date().toISOString()
      });

      await savePerson(db, person);

      renderCharacters(people.map(p =>
        p.id === id ? person : p
      ));

      showStatus("人物状态更新成功。", "ok");

      if (typeof window.renderLibrary === "function") {
        await window.renderLibrary();
      }
    } catch (error) {
      showStatus("更新失败：" + error.message, "err");
    } finally {
      db.close();
    }
  }

  async function importCharacters(characters) {
    if (!Array.isArray(characters)) return;

    const db = await openDB();

    try {
      const people = await getPeople(db);

      let created = 0;
      let updated = 0;
      let protectedCount = 0;

      const imported = [];

      for (const raw of characters) {
        const name = String(raw.name || "").trim();

        if (!name) continue;

        const existing = people.find(p =>
          normalizeName(p.name) === normalizeName(name)
        );

        if (existing) {
          if (
            existing.locked ||
            existing.reviewStatus === "locked"
          ) {
            protectedCount++;
            imported.push(existing);
            continue;
          }

          // 只补充空字段，不覆盖已有资料和图片
          let changed = false;

          for (const field of FIELDS) {
            const value = String(raw[field] || "").trim();

            if (value && !String(existing[field] || "").trim()) {
              existing[field] = value;
              changed = true;
            }
          }

          if (changed) {
            existing.updatedAt = new Date().toISOString();
            await savePerson(db, existing);
            updated++;
          }

          imported.push(existing);

        } else {
          const person = {
            id: uid(),
            name,

            age: raw.age || "",
            gender: raw.gender || "",
            height: raw.height || "",
            identity: raw.identity || "",
            mood: raw.mood || "",
            look: raw.look || "",
            hair: raw.hair || "",
            clothes: raw.clothes || "",
            props: raw.props || "",
            extra: raw.extra || "",

            masterPrompt: "",
            masterBoard: "",
            images: {},

            reviewStatus: "pending",
            locked: false,
            source: "ai-script",

            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          await savePerson(db, person);

          people.push(person);
          imported.push(person);
          created++;
        }
      }

      renderCharacters(imported);

      showStatus(
        `自动入库完成：新增${created}人，补充${updated}人，保护已锁定人物${protectedCount}人。`,
        "ok"
      );

      if (typeof window.renderLibrary === "function") {
        await window.renderLibrary();
      }

    } finally {
      db.close();
    }
  }

  // 监听原有Gemini接口，不需要修改原来的生成按钮事件
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);

    const url = typeof args[0] === "string"
      ? args[0]
      : args[0]?.url || "";

    const method = args[1]?.method || "GET";

    if (
      url.includes("/api/generate") &&
      method.toUpperCase() === "POST" &&
      response.ok
    ) {
      try {
        const data = await response.clone().json();

        if (Array.isArray(data.characters)) {
          importCharacters(data.characters).catch(error => {
            showStatus(
              "人物入库失败：" + error.message,
              "err"
            );
          });
        }
      } catch (error) {
        showStatus(
          "读取人物资料失败：" + error.message,
          "err"
        );
      }
    }

    return response;
  };

  createPanel();

})();
