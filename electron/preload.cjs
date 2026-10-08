const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bobo", {
  getState: () => ipcRenderer.invoke("bobo:state"),
  care: (action) => ipcRenderer.invoke("bobo:care", action),
  refreshQuotas: (agent) => ipcRenderer.invoke("bobo:refresh-quotas", agent),
  newConversation: () => ipcRenderer.invoke("bobo:new-conversation"),
  selectConversation: (id) =>
    ipcRenderer.invoke("bobo:select-conversation", id),
  chat: (message) => ipcRenderer.invoke("bobo:chat", message),
  dispatch: (agent, title, prompt, contract) =>
    ipcRenderer.invoke("bobo:dispatch", { agent, title, prompt, contract }),
  cancelTask: (id) => ipcRenderer.invoke("bobo:cancel", id),
  getWorkflow: (id) => ipcRenderer.invoke("bobo:workflow", id),
  getProjectMemory: () => ipcRenderer.invoke("bobo:project-memory"),
  saveProjectMemory: (text, kind, taskId) =>
    ipcRenderer.invoke("bobo:save-project-memory", { text, kind, taskId }),
  revokeProjectMemory: (id) =>
    ipcRenderer.invoke("bobo:revoke-project-memory", id),
  setContract: (id, contract) =>
    ipcRenderer.invoke("bobo:contract", { id, contract }),
  resumeTask: (id, agent, note) =>
    ipcRenderer.invoke("bobo:resume", { id, agent, note }),
  setSupervision: (id, enabled, allowedAgents) =>
    ipcRenderer.invoke("bobo:supervision", { id, enabled, allowedAgents }),
  recordCorrection: (id, text, correctionId) =>
    ipcRenderer.invoke("bobo:correction", { id, text, correctionId }),
  verifyTask: (id) => ipcRenderer.invoke("bobo:verify", id),
  handoff: (id) => ipcRenderer.invoke("bobo:handoff", id),
  completeHandoff: (id, result) =>
    ipcRenderer.invoke("bobo:complete-handoff", { id, result }),
  setSettings: (settings) => ipcRenderer.invoke("bobo:settings", settings),
  pickEnvFile: () => ipcRenderer.invoke("bobo:pick-env-file"),
  pickWorkspace: () => ipcRenderer.invoke("bobo:pick-workspace"),
  setQuota: (agent, quota) =>
    ipcRenderer.invoke("bobo:quota", { agent, quota }),
  nextGeneration: () => ipcRenderer.invoke("bobo:next-generation"),
  togglePet: (visible) => ipcRenderer.invoke("bobo:toggle-pet", visible),
  openHome: (page) => ipcRenderer.invoke("bobo:open-home", page),
  openPetChat: (taskId) => ipcRenderer.invoke("bobo:open-pet-chat", taskId),
  setPetExpanded: (expanded) =>
    ipcRenderer.invoke("bobo:pet-expanded", expanded),
  dismissPetNotice: () => ipcRenderer.invoke("bobo:dismiss-pet-notice"),
  onNavigate: (callback) => {
    const listener = (_event, page) => callback(page);
    ipcRenderer.on("bobo:navigate", listener);
    return () => ipcRenderer.removeListener("bobo:navigate", listener);
  },
  closeWindow: () => ipcRenderer.invoke("bobo:close-window"),
  movePet: (dx, dy) => ipcRenderer.invoke("bobo:move-pet", { dx, dy }),
  setPetInteractive: (interactive) =>
    ipcRenderer.invoke("bobo:pet-interactive", interactive),
  onChange: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("bobo:changed", listener);
    return () => ipcRenderer.removeListener("bobo:changed", listener);
  },
  onPetMessage: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("bobo:pet-message", listener);
    return () => ipcRenderer.removeListener("bobo:pet-message", listener);
  },
});
