export type Stage = "seed" | "sprout" | "young" | "adult" | "elder" | "memory";
export type AgentId = "trae" | "codex" | "claude" | "doubao";
export type CareAction = "water" | "touch" | "sun" | "sleep";
export interface Pet {
  id: string;
  name: string;
  generation: number;
  bornAt: number;
  lastSeenAt: number;
  companionMs: number;
  hydration: number;
  energy: number;
  bond: number;
  sleeping: boolean;
  careDay: string;
  careCounts: Record<string, number>;
  moments: number;
}
export interface Moment {
  id: string;
  at: number;
  kind: string;
  title: string;
  text: string;
  generation: number;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: number;
}
export interface Quota {
  remainingPercent: number | null;
  resetAt: string | null;
  note: string;
  source: "manual" | "codex-app-server" | "claude-oauth-usage" | "unavailable";
  status?: "fresh" | "stale" | "manual" | "unavailable";
  checkedAt?: number;
  queryError?: string;
  windows?: {
    limitId: string;
    label: string;
    kind: string;
    usedPercent: number;
    remainingPercent: number;
    windowDurationMins: number | null;
    resetAt: string | null;
  }[];
  updatedAt: number;
}
export interface Agent {
  id: AgentId;
  name: string;
  subtitle: string;
  installed: boolean;
  capability: "cli" | "handoff";
  description: string;
  running: number;
  quota: Quota | null;
}
export interface Task {
  conversationId?: string;
  id: string;
  agent: AgentId;
  title: string;
  prompt: string;
  status:
    | "running"
    | "queued"
    | "handoff"
    | "completed"
    | "attention"
    | "failed"
    | "cancelled"
    | "interrupted";
  createdAt: number;
  finishedAt?: number;
  workspace: string;
  allowEdits: boolean;
  progress: string;
  quiet?: boolean;
  resumeMode?: "native" | "handoff" | "new";
  result: string;
  error?: string;
  resultSource?: "manual";
  usage: { input: number; output: number; cost?: number | null } | null;
}
export interface TaskContract {
  checks: {
    kind: "exists" | "contains" | "json";
    path: string;
    expected: string;
    dependencies?: string[];
  }[];
  maxAttempts: number;
  tokenLimit: number | null;
  contextTokenBudget?: number;
}
export interface ProjectMemoryEntry {
  id: string;
  revision: number;
  kind: "feedback" | "preference" | "reference";
  text: string;
  status: "active" | "revoked";
  source: { kind: string; messageId?: string };
  updatedAt: number;
}
export interface WorkflowReport {
  memory: {
    revision: number;
    originalRequest: { source: string; content: string };
    archivedReports: number;
    truncatedArchives: number;
    warning: string | null;
    ledger?: {
      revision: number;
      processedThrough: number;
      requirements: number;
      records: {
        id: string;
        type: string;
        status: string;
        revision: number;
        source: { kind: string };
      }[];
    };
    assembly: {
      targetChars?: number;
      totalChars?: number;
      transmittedChars?: number;
      anchorChars?: number;
      selectedReportChars: number;
      omittedReportChars: number;
      nativeReportReplaySkipped?: boolean;
      overTarget?: boolean;
      targetTokens?: number;
      mandatoryTokens?: number;
      estimatedTokens?: number;
      overTokenTarget?: boolean;
      omittedOptional?: number;
    } | null;
  };
  supervision: {
    enabled: boolean;
    allowedAgents: AgentId[];
    state: string;
    reason: string;
    pending: { at: number; target: AgentId } | null;
    events: { at: number; kind: string; text: string }[];
  } | null;
  corrections: { id: string; text: string; at: number; active: boolean }[];
  rootId: string;
  parentId: string | null;
  childId: string | null;
  contract: TaskContract;
  attempts: { id: string; agent: AgentId; status: Task["status"] }[];
  usage: {
    input: number;
    output: number;
    brainInput: number;
    brainOutput: number;
    total: number;
    unknownAttempts: number;
    unknownBrainCalls: number;
    sharedBrainCalls: number;
    knownWorkerCost: number;
    unknownPrices: number;
  };
  checkpoint: {
    changes: { path: string; before: string | null; after: string | null }[];
    inventory: { complete: boolean; scope: string };
  } | null;
  verification: {
    at: number;
    status: "passed" | "failed" | "not_configured" | "stale" | "needs_recheck";
    scope: string;
    checks: {
      path: string;
      passed: boolean;
      detail: string;
      sha256?: string;
      dependencies?: {
        path: string;
        sha256: string | null;
        freshness?: string;
      }[];
    }[];
  } | null;
}
export interface State {
  pet: Pet;
  archives: (Pet & { endedAt: number })[];
  diary: Moment[];
  tasks: Task[];
  messages: Message[];
  activeConversationId?: string;
  conversations?: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: Message[];
  }[];
  quotas: Partial<Record<AgentId, Quota>>;
  usage: { brainInput: number; brainOutput: number; brainCalls: number };
  settings: {
    workspace: string;
    allowEdits: boolean;
    superviseTasks: boolean;
    fallbackAgents: AgentId[];
    quiet: boolean;
    alwaysOnTop: boolean;
    petVisible: boolean;
  };
  agents: Agent[];
  brain: {
    configured: boolean;
    provider?: string;
    configurationIssue?: string;
    model: string;
    mode: string;
    envPath: string;
    busy?: boolean;
  };
  petUI?: {
    expanded: boolean;
    request?: number;
    taskId: string | null;
    notice: PetNotice | null;
  };
  desktop: boolean;
  workspace: string;
}
export interface PetNotice {
  message: string;
  taskId: string;
  at: number;
}
export interface BoboAPI {
  getState(): Promise<State>;
  care(action: CareAction): Promise<string>;
  chat(message: string): Promise<string>;
  refreshQuotas(agent?: AgentId): Promise<Agent[]>;
  newConversation(): Promise<string>;
  selectConversation(id: string): Promise<void>;
  dispatch(
    agent: AgentId,
    title: string,
    prompt: string,
    contract?: TaskContract,
  ): Promise<{ id: string; status: string }>;
  cancelTask(id: string): Promise<void>;
  getWorkflow(id: string): Promise<WorkflowReport>;
  getProjectMemory(): Promise<ProjectMemoryEntry[]>;
  saveProjectMemory(
    text: string,
    kind: ProjectMemoryEntry["kind"],
    taskId?: string,
  ): Promise<ProjectMemoryEntry>;
  revokeProjectMemory(id: string): Promise<ProjectMemoryEntry>;
  setContract(id: string, contract: TaskContract): Promise<WorkflowReport>;
  resumeTask(
    id: string,
    agent: AgentId,
    note: string,
  ): Promise<{ id: string; status: string }>;
  setSupervision(
    id: string,
    enabled: boolean,
    allowedAgents: AgentId[],
  ): Promise<WorkflowReport>;
  recordCorrection(
    id: string,
    text: string,
    correctionId?: string,
  ): Promise<unknown>;
  verifyTask(id: string): Promise<WorkflowReport["verification"]>;
  handoff(id: string): Promise<void>;
  completeHandoff(id: string, result: string): Promise<void>;
  setSettings(settings: Partial<State["settings"]>): Promise<void>;
  pickEnvFile(): Promise<State["brain"]>;
  pickWorkspace(): Promise<string>;
  setQuota(agent: AgentId, quota: Partial<Quota>): Promise<void>;
  nextGeneration(): Promise<void>;
  togglePet(visible: boolean): Promise<void>;
  openHome(page?: string): Promise<void>;
  openPetChat(taskId?: string): Promise<void>;
  setPetExpanded(expanded: boolean): Promise<void>;
  dismissPetNotice(): Promise<void>;
  onNavigate(callback: (page: string) => void): () => void;
  closeWindow(): Promise<void>;
  movePet(dx: number, dy: number): Promise<void>;
  setPetInteractive(interactive: boolean): Promise<void>;
  onChange(callback: () => void): () => void;
  onPetMessage(callback: (notice: PetNotice) => void): () => void;
}
declare global {
  interface Window {
    bobo?: BoboAPI;
  }
}
