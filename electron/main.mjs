import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  Notification,
  dialog,
  shell,
  clipboard,
  nativeTheme,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { AgentManager } from "./agents.mjs";
import { Brain } from "./brain.mjs";
import {
  listProjectMemories,
  saveProjectMemory,
  revokeProjectMemory,
} from "./work-memory.mjs";
import { ROOT, loadConfig, publicConfig, redact } from "./config.mjs";
app.setName("Bobo");
const directory = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.BOBO_DEV_URL;
const isTest = process.env.BOBO_TEST === "1";
let home, pet, tray, store, agents, brain, timer;
let petOpenRequest = 0;
let petExpanded = false,
  petTaskId = null,
  petNotice = null;
function notifyChanged() {
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send("bobo:changed");
}
if (process.env.BOBO_DATA_DIR)
  app.setPath("userData", process.env.BOBO_DATA_DIR);
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock && !isTest) app.quit();
else {
  app.on("second-instance", () => openPetChat());
  app
    .whenReady()
    .then(() => {
      try {
        store = new Store(app.getPath("userData"), notifyChanged);
      } catch (error) {
        dialog.showErrorBox("Bobo 的存档需要检查", redact(error.message));
        app.exit(1);
      }
      agents = new AgentManager(store, (task, reason) => {
        const message =
          reason ||
          (task.status === "completed"
            ? `「${task.title}」执行结束，结果带回来啦。`
            : task.status === "cancelled"
              ? "任务已经停下来啦。"
              : `「${task.title}」需要你看一下。`);
        petNotice = { message, taskId: task.id, at: Date.now() };
        pet?.webContents.send("bobo:pet-message", petNotice);
        notifyChanged();
        if (
          !store.state.settings.quiet &&
          !isTest &&
          Notification.isSupported()
        )
          new Notification({ title: "Bobo 带来一个消息", body: message })
            .on("click", () => openPetChat(task.id))
            .show();
      });
      if (!process.env.BOBO_ENV_PATH && store.state.settings.envPath)
        process.env.BOBO_ENV_PATH = store.state.settings.envPath;
      if (app.isPackaged && !process.env.BOBO_ENV_PATH) {
        process.env.BOBO_ENV_PATH = path.join(app.getPath("userData"), ".env");
        if (!fs.existsSync(process.env.BOBO_ENV_PATH))
          fs.writeFileSync(
            process.env.BOBO_ENV_PATH,
            "OPENAI_API_KEY=\nOPENAI_MODEL=gpt-5.6-sol\nOPENAI_API_MODE=responses\n",
            { mode: 0o600 },
          );
      }
      if (
        process.env.BOBO_ENV_PATH &&
        store.state.settings.envPath !== process.env.BOBO_ENV_PATH
      ) {
        store.state.settings.envPath = process.env.BOBO_ENV_PATH;
        store.save();
      }
      nativeTheme.themeSource = "dark";
      const iconFile = path.join(directory, "assets/icon.png");
      if (process.platform === "darwin" && fs.existsSync(iconFile))
        app.dock?.setIcon(iconFile);
      brain = new Brain(store, agents);
      if (store.state.settings.petVisible) createPet();
      if (!isTest) createTray();
      registerHandlers();
      agents.supervisor.start();
      if (!isTest) void agents.refreshQuotas();
      timer = setInterval(() => {
        store.tick();
        if (!isTest) void agents.refreshQuotas();
      }, 60_000);
      app.on("activate", () => openPetChat());
      app.on("before-quit", () => {
        app.boboQuitting = true;
        clearInterval(timer);
        agents.stopAll();
        store.tick();
      });
      app.on("window-all-closed", () => {
        if (isTest) app.quit();
      });
    })
    .catch((error) => {
      console.error(redact(error.message));
      app.exit(1);
    });
}
function options(extra = {}) {
  return {
    backgroundColor: "#101010",
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...extra,
  };
}
function protect(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
function load(win, view, extra = {}) {
  protect(win);
  if (DEV_URL) {
    const url = new URL(DEV_URL);
    url.searchParams.set("view", view);
    for (const [key, value] of Object.entries(extra))
      url.searchParams.set(key, value);
    win.loadURL(url.href);
  } else
    win.loadFile(path.join(ROOT, "dist/index.html"), {
      query: { view, ...extra },
    });
}
function createHome(page = "home") {
  home = new BrowserWindow(
    options({
      width: 1080,
      height: 800,
      minWidth: 860,
      minHeight: 650,
      show: false,
      title: "Bobo · 记录与设置",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 22, y: 22 },
    }),
  );
  home.on("close", (event) => {
    if (!app.boboQuitting) {
      event.preventDefault();
      home.hide();
    }
  });
  load(home, "home", { page });
}
function showHome(requestedPage = "home") {
  const page = ["home", "agents", "diary", "growth", "settings"].includes(
    requestedPage,
  )
    ? requestedPage
    : "home";
  if (!home || home.isDestroyed()) createHome(page);
  else home.webContents.send("bobo:navigate", page);
  home.show();
  home.focus();
}
function petDimensions(expanded) {
  return expanded ? { width: 400, height: 650 } : { width: 300, height: 340 };
}
function resizePet(expanded) {
  petExpanded = expanded;
  if (!pet || pet.isDestroyed()) return;
  const bounds = pet.getBounds(),
    size = petDimensions(expanded),
    { workArea } = screen.getDisplayMatching(bounds);
  pet.setBounds({
    ...size,
    x: Math.round(
      Math.max(
        workArea.x,
        Math.min(
          workArea.x + workArea.width - size.width,
          bounds.x + bounds.width - size.width,
        ),
      ),
    ),
    y: Math.round(
      Math.max(
        workArea.y,
        Math.min(
          workArea.y + workArea.height - size.height,
          bounds.y + bounds.height - size.height,
        ),
      ),
    ),
  });
}
function createPet() {
  if (pet && !pet.isDestroyed()) {
    pet.show();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay(),
    size = petDimensions(petExpanded);
  pet = new BrowserWindow(
    options({
      ...size,
      x: workArea.x + workArea.width - size.width - 30,
      y: workArea.y + workArea.height - size.height - 30,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: store.state.settings.alwaysOnTop,
      focusable: true,
    }),
  );
  pet.setIgnoreMouseEvents(true, { forward: true });
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  load(pet, "pet");
}
function openPetChat(taskId = null) {
  petOpenRequest++;
  petTaskId =
    typeof taskId === "string" && store.state.tasks.some((t) => t.id === taskId)
      ? taskId
      : null;
  petExpanded = true;
  store.state.settings.petVisible = true;
  createPet();
  resizePet(true);
  pet.show();
  pet.focus();
  store.save();
}
function createTray() {
  const image = nativeImage
    .createFromPath(path.join(directory, "assets/tray.png"))
    .resize({ width: 18, height: 18 });
  image.setTemplateImage(true);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Bobo · 桌面小伙伴");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "和 Bobo 说话", click: () => openPetChat() },
      { label: "历史记录", click: () => showHome("home") },
      { label: "偏好设置", click: () => showHome("settings") },
      {
        label: "显示 / 收起桌宠",
        click: () => {
          store.state.settings.petVisible = !store.state.settings.petVisible;
          store.state.settings.petVisible ? createPet() : pet?.hide();
          store.save();
        },
      },
      { type: "separator" },
      { label: "退出 Bobo", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => openPetChat());
}
function snapshot() {
  const cfg = loadConfig();
  return {
    ...store.state,
    tasks: store.state.tasks.map(
      ({ baseline, checkpoint, handoff, ...task }) => task,
    ),
    coordinationUsage: undefined,
    agents: agents.list(),
    brain: { ...publicConfig(cfg), busy: brain.busy },
    petUI: {
      expanded: petExpanded,
      taskId: petTaskId,
      notice: petNotice,
      request: petOpenRequest,
    },
    desktop: true,
    workspace: store.state.settings.workspace || cfg.workspace,
  };
}
function assertSender(event) {
  const url = event.senderFrame?.url || "";
  if (DEV_URL) {
    if (new URL(url).origin !== new URL(DEV_URL).origin)
      throw new Error("这个窗口没有操作权限。");
  } else if (
    !url.startsWith(
      new URL(`file://${path.join(ROOT, "dist/index.html")}`).href,
    )
  )
    throw new Error("这个窗口没有操作权限。");
  if (![home?.webContents.id, pet?.webContents.id].includes(event.sender.id))
    throw new Error("这个窗口没有操作权限。");
}
function handle(name, fn) {
  ipcMain.handle(`bobo:${name}`, async (event, data) => {
    assertSender(event);
    try {
      return await fn(data, event);
    } catch (error) {
      throw new Error(redact(error.message));
    }
  });
}
function registerHandlers() {
  handle("state", snapshot);
  handle("care", (action) => store.care(action));
  handle("chat", (message) => brain.chat(message));
  handle("refresh-quotas", (agent) => agents.refreshQuotas(agent, true));
  handle("new-conversation", () => {
    if (brain.busy) throw new Error("等这次回复完成后再新建对话。");
    return store.newConversation();
  });
  handle("select-conversation", (id) => {
    if (brain.busy) throw new Error("等这次回复完成后再切换对话。");
    store.selectConversation(id);
  });
  handle("dispatch", (data) =>
    agents.dispatch(data.agent, data.title, data.prompt, {
      contract: data.contract,
    }),
  );
  handle("cancel", (id) => agents.cancel(id));
  handle("workflow", (id) => agents.report(id));
  handle("project-memory", () =>
    listProjectMemories(
      store,
      store.state.settings.workspace || loadConfig().workspace,
    ),
  );
  handle("save-project-memory", (data) => {
    if (data.taskId) {
      const task = agents.task(data.taskId);
      const current = store.state.settings.workspace || loadConfig().workspace;
      if (
        !current ||
        fs.realpathSync(current) !== fs.realpathSync(task.workspace)
      )
        throw new Error("先选回这项任务的项目目录，再保存项目经验。");
    }
    return saveProjectMemory(
      store,
      store.state.settings.workspace || loadConfig().workspace,
      {
        text: data.text,
        kind: data.kind,
        taskId: data.taskId || null,
        source: { kind: "user_ui" },
      },
    );
  });
  handle("revoke-project-memory", (id) =>
    revokeProjectMemory(
      store,
      store.state.settings.workspace || loadConfig().workspace,
      id,
    ),
  );
  handle("contract", (data) => agents.setContract(data.id, data.contract));
  handle("resume", (data) => agents.resume(data.id, data.agent, data.note));
  handle("verify", (id) => agents.verify(id));
  handle("supervision", (data) =>
    agents.supervisor.configure(data.id, data.enabled, data.allowedAgents),
  );
  handle("correction", (data) =>
    agents.recordCorrection(data.id, data.text, data.correctionId),
  );
  handle("next-generation", () => store.nextGeneration());
  handle("settings", (data) => {
    if (data?.fallbackAgents !== undefined) {
      if (
        !Array.isArray(data.fallbackAgents) ||
        data.fallbackAgents.some(
          (id) => !["trae", "codex", "claude"].includes(id),
        )
      )
        throw new Error("接手名单无效。");
      store.state.settings.fallbackAgents = [...new Set(data.fallbackAgents)];
    }
    for (const key of ["allowEdits", "quiet", "alwaysOnTop", "superviseTasks"])
      if (typeof data?.[key] === "boolean")
        store.state.settings[key] = data[key];
    if (data?.superviseTasks === false) {
      for (const task of store.state.tasks)
        if (task.supervision) {
          task.supervision.enabled = false;
          task.supervision.pending = null;
          task.supervision.state = "paused";
          task.supervision.reason = "自动照看已关闭。";
        }
    }
    pet?.setAlwaysOnTop(store.state.settings.alwaysOnTop);
    store.save();
  });
  handle("pick-workspace", async () => {
    const result = await dialog.showOpenDialog(home, {
      title: "选择 Agent 的工作目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (!result.canceled && result.filePaths[0]) {
      store.state.settings.workspace = result.filePaths[0];
      store.state.settings.allowEdits = false;
      store.save();
    }
    return store.state.settings.workspace;
  });
  handle("pick-env-file", async () => {
    const result = await dialog.showOpenDialog(home, {
      title: "选择 Bobo 的 .env 配置文件",
      properties: ["openFile", "showHiddenFiles"],
    });
    if (!result.canceled && result.filePaths[0]) {
      process.env.BOBO_ENV_PATH = result.filePaths[0];
      store.state.settings.envPath = result.filePaths[0];
      store.save();
    }
    return publicConfig();
  });
  handle("quota", (data) => {
    if (!["trae", "codex", "claude", "doubao"].includes(data?.agent))
      throw new Error("工具不存在。");
    const raw = data.quota?.remainingPercent;
    const remainingPercent = raw == null || raw === "" ? null : Number(raw);
    if (
      remainingPercent !== null &&
      (!Number.isFinite(remainingPercent) ||
        remainingPercent < 0 ||
        remainingPercent > 100)
    )
      throw new Error("剩余额度需要在 0～100% 之间。");
    const resetAt = data.quota?.resetAt || null;
    if (resetAt && !Number.isFinite(Date.parse(resetAt)))
      throw new Error("重置时间格式不正确。");
    store.state.quotas[data.agent] = {
      remainingPercent,
      resetAt,
      note: String(data.quota?.note || "").slice(0, 200),
      source: "manual",
      updatedAt: Date.now(),
    };
    store.save();
  });
  handle("handoff", async (id) => {
    const task = store.state.tasks.find(
      (t) => t.id === id && t.agent === "doubao",
    );
    if (!task) throw new Error("没有找到转交卡片。");
    clipboard.writeText(task.prompt);
    await shell.openExternal("https://www.doubao.com/");
    task.progress = "需求已复制，豆包已打开。请粘贴发送，结果由你记录。";
    store.save();
  });
  handle("complete-handoff", (data) => {
    const task = store.state.tasks.find(
      (t) =>
        t.id === data?.id && t.agent === "doubao" && t.status === "handoff",
    );
    if (!task || typeof data.result !== "string" || !data.result.trim())
      throw new Error("请填写你从豆包得到的结果。");
    task.status = "completed";
    task.result = data.result.slice(0, 16000);
    task.finishedAt = Date.now();
    task.resultSource = "manual";
    store.moment(
      "你带回了一份灵感",
      `为「${task.title}」记下了豆包的结果。`,
      "work",
    );
    store.save();
  });
  handle("toggle-pet", (visible) => {
    store.state.settings.petVisible = Boolean(visible);
    visible ? createPet() : pet?.hide();
    store.save();
  });
  handle("pet-interactive", (interactive, event) => {
    if (event.sender.id === pet?.webContents.id)
      pet.setIgnoreMouseEvents(!Boolean(interactive), { forward: true });
  });
  handle("open-home", (page) => showHome(page));
  handle("open-pet-chat", (taskId) => openPetChat(taskId));
  handle("pet-expanded", (expanded) => {
    resizePet(Boolean(expanded));
    if (!expanded) petTaskId = null;
    notifyChanged();
  });
  handle("dismiss-pet-notice", () => {
    petNotice = null;
    notifyChanged();
  });
  handle("close-window", (_data, event) =>
    BrowserWindow.fromWebContents(event.sender)?.hide(),
  );
  handle("move-pet", (data, event) => {
    if (event.sender.id !== pet?.webContents.id) return;
    const dx = Number(data?.dx),
      dy = Number(data?.dy);
    if (
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      Math.abs(dx) > 1500 ||
      Math.abs(dy) > 1500
    )
      return;
    const [x, y] = pet.getPosition();
    const { workArea } = screen.getDisplayNearestPoint({
      x: x + pet.getBounds().width - 150,
      y: y + pet.getBounds().height - 170,
    });
    pet.setPosition(
      Math.round(
        Math.max(
          workArea.x,
          Math.min(workArea.x + workArea.width - pet.getBounds().width, x + dx),
        ),
      ),
      Math.round(
        Math.max(
          workArea.y,
          Math.min(
            workArea.y + workArea.height - pet.getBounds().height,
            y + dy,
          ),
        ),
      ),
    );
  });
}
