"use client";

import { FolderTree, Terminal, X } from "lucide-react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AgentTranscriptProvider } from "@/components/agent-transcript-modal";
import { AssistantProvider } from "@/components/assistant-provider";
import { AuthGuard } from "@/components/auth-guard";
import { SessionIssuesButton } from "@/components/issues/session-issues-button";
import { NavBar } from "@/components/nav/nav-bar";
import { NavProvider } from "@/components/nav/nav-provider";
import { NavRail } from "@/components/nav/nav-rail";
import { SearchButton } from "@/components/search-modal";
import { SessionAlerts } from "@/components/session-alerts";
import { SessionWatchProvider } from "@/components/session-watch-provider";
import { Sidebar, type SidebarHandle } from "@/components/sidebar";
import { BackgroundTasksButton } from "@/components/task-indicator";
import { Button } from "@/components/ui/button";
import { UsageButton } from "@/components/usage-modal";
import { useEmbedded } from "@/hooks/use-embedded";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { usePlaceMemory } from "@/hooks/use-place-memory";
import { useSettings } from "@/hooks/use-settings";
import { WebSocketProvider } from "@/hooks/use-websocket";
import { headerActionsVisibility } from "@/lib/header-actions";
import { isModalPath, type PageModalMessage, pageModalMessage } from "@/lib/page-modal";
import type { BackgroundTask, InitData } from "@/types";
import { PageModal, usePageModal } from "./page-modal";

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
  /** A page's own control, shown at the right of the bar whatever the other actions do. */
  actions?: ReactNode;
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
  /** Opens a page in the page modal when the setting allows it. Returns false
   *  when it did not, so the caller can navigate instead. */
  openPageModal: (path: string) => boolean;
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
  openPageModal: () => false,
});

export function useShell() {
  return useContext(ShellContext);
}

export function usePageHeader(title: string, options?: { hideActions?: boolean; usageOnly?: boolean; actions?: ReactNode }) {
  const { setHeader } = useShell();
  const hideActions = options?.hideActions;
  const usageOnly = options?.usageOnly;
  const actions = options?.actions;
  useEffect(() => {
    setHeader({ title, hideActions, usageOnly, actions });
  }, [title, hideActions, usageOnly, actions, setHeader]);
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

/** Goes where a tapped notification points, when the service worker asks
 *  (see notificationclick in sw.js). Moving within the app keeps its connection
 *  and what it has loaded; the worker reloads the page only if nobody answers. */
function ServiceWorkerNavigation() {
  const router = useRouter();

  useEffect(() => {
    const sw = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "cockpit:navigate" || typeof event.data.url !== "string") return;
      const url = new URL(event.data.url, window.location.origin);
      if (url.origin !== window.location.origin) return;
      router.push(url.pathname + url.search + url.hash);
      event.ports[0]?.postMessage(true);
    };
    sw.addEventListener("message", onMessage);
    sw.startMessages();
    return () => sw.removeEventListener("message", onMessage);
  }, [router]);

  return null;
}

/** One place memory recorder, inside Suspense because it reads the query. */
function PlaceMemory() {
  usePlaceMemory();
  return null;
}

/** The shell's client state that only the real page needs: the assistant, the
 *  one session-watch sender, the navigation, and the place memory. The page
 *  modal's frame renders its own shell without them. */
function ShellProviders({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  if (embedded) return <>{children}</>;
  return (
    <SessionWatchProvider>
      <AssistantProvider>
        <NavProvider>
          <Suspense fallback={null}>
            <PlaceMemory />
          </Suspense>
          {children}
        </NavProvider>
      </AssistantProvider>
    </SessionWatchProvider>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const sidebarRef = useRef<SidebarHandle>(null);
  const embedded = useEmbedded();
  const pathname = usePathname();
  const isDesktop = useIsDesktop();
  // The pinned session list sits beside a session and beside the Sessions
  // home on a desktop. On a phone the home shows its own pinned strip, and a
  // session gets the drawer.
  const showSidebar = pathname.startsWith("/sessions/") || (pathname === "/" && isDesktop);
  const [header, setHeaderState] = useState<HeaderConfig>({ title: "Cockpit" });
  const [cwd, setCwdState] = useState<string | undefined>(undefined);
  const [sessionId, setSessionIdState] = useState<string | undefined>(undefined);
  const [sessionModel, setSessionModelState] = useState<string | undefined>(undefined);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [initData, setInitData] = useState<InitData | null>(null);
  const [sidebarSectionsMap, setSidebarSectionsMap] = useState<Map<string, SidebarSectionConfig>>(new Map());
  const [runtime, setRuntimeState] = useState<"pty" | "stream">("stream");
  const [tabActions, setTabActionsState] = useState<TabActions | null>(null);
  // The page modal lives here rather than in the sidebar so anything in the
  // shell, including a session's context panel, can open a page in it.
  const { settings: appSettings, reload: reloadSettings } = useSettings();
  // Whatever the modal showed may have changed the page behind it (an issue's
  // status, for one), and that page did not unmount, so tell it the modal has
  // closed and it can read its data again.
  const onPageModalClosed = useCallback(() => {
    reloadSettings();
    window.dispatchEvent(new CustomEvent("cockpit:page-modal-closed"));
  }, [reloadSettings]);
  const pageModal = usePageModal(onPageModalClosed);

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

  /** Opens a page over the current one when the setting allows it; false means
   *  the caller should navigate instead. Inside the modal's own frame there is
   *  nowhere to put a second one, so it is always false there. */
  const openPageModal = useCallback(
    (path: string) => {
      if (embedded || !appSettings.modalPagesEnabled || !isModalPath(path.split("?")[0])) return false;
      pageModal.open(path);
      return true;
    },
    [embedded, appSettings.modalPagesEnabled, pageModal.open],
  );

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

  // Memoised: a page's header control is a ReactNode in `header`, and a new
  // context value on every shell render would re-render every consumer, which
  // in turn would set the header again.
  const shellValue = useMemo<ShellContextValue>(
    () => ({
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
      openPageModal,
    }),
    [
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
      initData,
      sidebarSectionsMap,
      setSidebarSection,
      removeSidebarSection,
      closeSidebar,
      tabActions,
      setTabActions,
      openPageModal,
    ],
  );

  return (
    <AuthGuard>
      <WebSocketProvider>
        <ShellContext.Provider value={shellValue}>
          <AgentTranscriptProvider sessionId={sessionId} cwd={cwd}>
            <ShellProviders embedded={embedded}>
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
                {!embedded && <NavRail />}
                {!embedded && showSidebar && <Sidebar ref={sidebarRef} />}
                {!embedded && <PageModal path={pageModal.path} onClose={pageModal.close} onOpenInApp={pageModal.openInApp} />}
                <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                  <header className="shrink-0 flex items-center gap-2 border-b px-4 py-2 bg-background">
                    {!embedded && pathname.startsWith("/sessions/") && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleSidebar}
                        title="Files & changes"
                        className="md:hidden"
                        data-testid="session-files-drawer"
                      >
                        <FolderTree className="h-4 w-4" />
                      </Button>
                    )}
                    <div
                      className={`${embedded || (!pathname.startsWith("/sessions/") && pathname !== "/") ? "flex" : "hidden md:flex"} items-center gap-2 min-w-0 flex-1 overflow-hidden`}
                    >
                      {!embedded && (
                        <Image src="/icon-192.png" alt="" width={22} height={22} className="hidden md:block shrink-0 dark:invert" />
                      )}
                      <EditableTitle title={header.title} onRename={header.onRename} />
                    </div>
                    {(header.actions || actions.showSessionActions || actions.showUsage) && (
                      <div className="flex items-center gap-2 shrink-0 ml-auto">
                        {header.actions}
                        {actions.showSessionActions && (
                          <>
                            <SessionIssuesButton />
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
                  {!embedded && <NavBar />}
                </div>
              </div>
              {/* Only the real shell: the page-modal iframe renders its own, and
                two shells would each raise a banner for the same event. */}
              {!embedded && <SessionAlerts />}
              {!embedded && <ServiceWorkerNavigation />}
              {embedded && <EmbeddedPageBridge pathname={pathname} />}
            </ShellProviders>
          </AgentTranscriptProvider>
        </ShellContext.Provider>
      </WebSocketProvider>
    </AuthGuard>
  );
}
