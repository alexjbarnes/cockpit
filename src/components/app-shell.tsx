"use client";

import { Menu, Terminal, X } from "lucide-react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AgentTranscriptProvider } from "@/components/agent-transcript-modal";
import { AuthGuard } from "@/components/auth-guard";
import { SearchButton } from "@/components/search-modal";
import { Sidebar, type SidebarHandle } from "@/components/sidebar";
import { BackgroundTasksButton } from "@/components/task-indicator";
import { Button } from "@/components/ui/button";
import { UsageButton } from "@/components/usage-modal";
import { useEmbedded } from "@/hooks/use-embedded";
import { WebSocketProvider } from "@/hooks/use-websocket";
import { headerActionsVisibility } from "@/lib/header-actions";
import { isModalPath, type PageModalMessage, pageModalMessage } from "@/lib/page-modal";
import type { BackgroundTask, InitData } from "@/types";

export interface SidebarSectionConfig {
  id: string;
  title: string;
  content: ReactNode;
  order?: number;
  badge?: string;
  actions?: ReactNode;
}

interface HeaderConfig {
  title: string;
  onRename?: (name: string) => void;
  hideActions?: boolean;
  usageOnly?: boolean;
}

export interface TabActions {
  openFile: (filePath: string) => void;
  openDiff: (filePath: string) => void;
  openChanges: () => void;
  openTerminal?: (terminalId: string, label?: string) => void;
}

interface ShellContextValue {
  setHeader: (config: HeaderConfig) => void;
  cwd: string | undefined;
  setCwd: (cwd: string | undefined) => void;
  sessionId: string | undefined;
  setSessionId: (id: string | undefined) => void;
  sessionModel: string | undefined;
  setSessionModel: (model: string | undefined) => void;
  runtime: "pty" | "stream";
  setRuntime: (runtime: "pty" | "stream") => void;
  backgroundTasks: BackgroundTask[];
  setBackgroundTasks: (tasks: BackgroundTask[]) => void;
  initData: InitData | null;
  setInitData: (data: InitData | null) => void;
  sidebarSections: Map<string, SidebarSectionConfig>;
  setSidebarSection: (section: SidebarSectionConfig) => void;
  removeSidebarSection: (id: string) => void;
  closeSidebar: () => void;
  tabActions: TabActions | null;
  setTabActions: (actions: TabActions | null) => void;
}

const ShellContext = createContext<ShellContextValue>({
  setHeader: () => {},
  cwd: undefined,
  setCwd: () => {},
  sessionId: undefined,
  setSessionId: () => {},
  sessionModel: undefined,
  setSessionModel: () => {},
  runtime: "stream",
  setRuntime: () => {},
  backgroundTasks: [],
  setBackgroundTasks: () => {},
  initData: null,
  setInitData: () => {},
  sidebarSections: new Map(),
  setSidebarSection: () => {},
  removeSidebarSection: () => {},
  closeSidebar: () => {},
  tabActions: null,
  setTabActions: () => {},
});

export function useShell() {
  return useContext(ShellContext);
}

export function usePageHeader(title: string, options?: { hideActions?: boolean; usageOnly?: boolean }) {
  const { setHeader } = useShell();
  const hideActions = options?.hideActions;
  const usageOnly = options?.usageOnly;
  useEffect(() => {
    setHeader({ title, hideActions, usageOnly });
  }, [title, hideActions, usageOnly, setHeader]);
}

export function useShellCwd(cwd: string | undefined) {
  const { setCwd } = useShell();
  useEffect(() => {
    if (cwd) setCwd(cwd);
  }, [cwd, setCwd]);
}

export function useShellSessionId(id: string | undefined) {
  const { setSessionId } = useShell();
  useEffect(() => {
    if (id) setSessionId(id);
  }, [id, setSessionId]);
}

/** Published by the active session view so header widgets (the usage
 *  indicator) can follow the session's provider without refetching. */
export function useShellSessionModel(model: string | undefined) {
  const { setSessionModel } = useShell();
  useEffect(() => {
    setSessionModel(model);
    return () => setSessionModel(undefined);
  }, [model, setSessionModel]);
}

function EditableTitle({ title, onRename }: { title: string; onRename?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(title);
  }, [title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!onRename) {
    return <span className="text-sm font-bold truncate">{title}</span>;
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-sm font-bold truncate hover:text-muted-foreground transition-colors text-left"
        title="Click to rename"
      >
        {title}
      </button>
    );
  }

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== title) onRename(trimmed);
    setEditing(false);
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          setValue(title);
          setEditing(false);
        }
      }}
      className="text-sm font-bold bg-transparent border-b border-primary outline-none w-40"
    />
  );
}

function NewTerminalButton({ cwd }: { cwd: string }) {
  const { tabActions } = useShell();
  const [creating, setCreating] = useState(false);

  const handleClick = useCallback(async () => {
    if (!tabActions?.openTerminal) return;
    setCreating(true);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) return;
      const { terminalId } = await res.json();
      tabActions.openTerminal(terminalId);
    } finally {
      setCreating(false);
    }
  }, [cwd, tabActions]);

  return (
    <Button variant="ghost" size="icon" onClick={handleClick} disabled={creating} title="New terminal (Ctrl+`)">
      <Terminal className="h-4 w-4" />
    </Button>
  );
}

function postToParent(msg: PageModalMessage): void {
  window.parent.postMessage(pageModalMessage(msg), window.location.origin);
}

/** The embedded document's side of the page modal. */
function EmbeddedPageBridge({ pathname }: { pathname: string }) {
  useEffect(() => {
    // A navigation inside the modal replaces its history entry rather than
    // adding one, so the device's Back closes the modal instead of stepping
    // through pages the window outside never shows.
    const push = window.history.pushState;
    window.history.pushState = function pushState(data, unused, url) {
      return window.history.replaceState(data, unused, url);
    };
    postToParent({ type: "ready" });
    return () => {
      window.history.pushState = push;
    };
  }, []);

  useEffect(() => {
    if (!isModalPath(pathname)) postToParent({ type: "open-in-app", url: pathname + window.location.search });
  }, [pathname]);

  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const sidebarRef = useRef<SidebarHandle>(null);
  const embedded = useEmbedded();
  const pathname = usePathname();
  const [header, setHeaderState] = useState<HeaderConfig>({ title: "Cockpit" });
  const [cwd, setCwdState] = useState<string | undefined>(undefined);
  const [sessionId, setSessionIdState] = useState<string | undefined>(undefined);
  const [sessionModel, setSessionModelState] = useState<string | undefined>(undefined);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [initData, setInitData] = useState<InitData | null>(null);
  const [sidebarSectionsMap, setSidebarSectionsMap] = useState<Map<string, SidebarSectionConfig>>(new Map());
  const [runtime, setRuntimeState] = useState<"pty" | "stream">("stream");
  const [tabActions, setTabActionsState] = useState<TabActions | null>(null);

  const setSidebarSection = useCallback((section: SidebarSectionConfig) => {
    setSidebarSectionsMap((prev) => {
      const next = new Map(prev);
      next.set(section.id, section);
      return next;
    });
  }, []);

  const removeSidebarSection = useCallback((id: string) => {
    setSidebarSectionsMap((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const setHeader = useCallback((config: HeaderConfig) => {
    setHeaderState(config);
  }, []);

  const setCwd = useCallback((val: string | undefined) => {
    setCwdState(val);
  }, []);

  const setSessionId = useCallback((val: string | undefined) => {
    setSessionIdState(val);
  }, []);

  const setSessionModel = useCallback((val: string | undefined) => {
    setSessionModelState(val);
  }, []);

  const toggleSidebar = useCallback(() => {
    sidebarRef.current?.toggle();
  }, []);

  const closeSidebar = useCallback(() => {
    sidebarRef.current?.close();
  }, []);

  const setRuntime = useCallback((val: "pty" | "stream") => {
    setRuntimeState(val);
  }, []);

  const setTabActions = useCallback((actions: TabActions | null) => {
    setTabActionsState(actions);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar]);

  const actions = headerActionsVisibility(header);

  return (
    <AuthGuard>
      <WebSocketProvider>
        <ShellContext.Provider
          value={{
            setHeader,
            cwd,
            setCwd,
            sessionId,
            setSessionId,
            sessionModel,
            setSessionModel,
            runtime,
            setRuntime,
            backgroundTasks,
            setBackgroundTasks,
            initData,
            setInitData,
            sidebarSections: sidebarSectionsMap,
            setSidebarSection,
            removeSidebarSection,
            closeSidebar,
            tabActions,
            setTabActions,
          }}
        >
          <AgentTranscriptProvider sessionId={sessionId} cwd={cwd}>
            {/* The app draws under the system bars (viewport-fit=cover), so it
                pads its own content back out of the notch and the gesture bar. */}
            <div
              className="fixed inset-0 flex"
              style={{
                paddingTop: "env(safe-area-inset-top)",
                paddingBottom: "env(safe-area-inset-bottom)",
                paddingLeft: "env(safe-area-inset-left)",
                paddingRight: "env(safe-area-inset-right)",
              }}
            >
              {!embedded && <Sidebar ref={sidebarRef} />}
              <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                <header className="shrink-0 flex items-center gap-2 border-b px-4 py-2 bg-background">
                  {!embedded && (
                    <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Toggle sidebar (Ctrl+B)" className="md:hidden">
                      <Menu className="h-4 w-4" />
                    </Button>
                  )}
                  <div className={`${embedded ? "flex" : "hidden md:flex"} items-center gap-2 min-w-0 flex-1 overflow-hidden`}>
                    {!embedded && <Image src="/icon-192.png" alt="" width={22} height={22} className="shrink-0 dark:invert" />}
                    <EditableTitle title={header.title} onRename={header.onRename} />
                  </div>
                  {(actions.showSessionActions || actions.showUsage) && (
                    <div className="flex items-center gap-2 shrink-0 ml-auto">
                      {actions.showSessionActions && (
                        <>
                          {cwd && <NewTerminalButton cwd={cwd} />}
                          <SearchButton />
                          {cwd && <BackgroundTasksButton tasks={backgroundTasks} />}
                        </>
                      )}
                      {actions.showUsage && <UsageButton sessionModel={sessionModel} />}
                    </div>
                  )}
                  {embedded && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => postToParent({ type: "close" })}
                      title="Close"
                      className="shrink-0"
                      data-testid="page-modal-close"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </header>
                {/* A page the modal does not show is opened outside instead, so it is never rendered in here. */}
                <main className="flex-1 min-h-0 min-w-0 flex flex-col">{embedded && !isModalPath(pathname) ? null : children}</main>
              </div>
            </div>
            {embedded && <EmbeddedPageBridge pathname={pathname} />}
          </AgentTranscriptProvider>
        </ShellContext.Provider>
      </WebSocketProvider>
    </AuthGuard>
  );
}
