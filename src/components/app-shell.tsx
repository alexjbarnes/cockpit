"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { AuthGuard } from "@/components/auth-guard";
import { WebSocketProvider } from "@/hooks/use-websocket";
import { UsageButton } from "@/components/usage-modal";
import { Sidebar, type SidebarHandle } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { FolderOpen, Menu } from "lucide-react";
import { GitStatusButton } from "@/components/git-status-modal";
import { BackgroundTasksButton } from "@/components/task-indicator";
import { TodoIndicator } from "@/components/todo-indicator";
import { McpStatusButton } from "@/components/mcp-status-modal";
import type { BackgroundTask, TodoItem, InitData } from "@/types";

interface HeaderConfig {
  title: string;
  onRename?: (name: string) => void;
}

interface ShellContextValue {
  setHeader: (config: HeaderConfig) => void;
  cwd: string | undefined;
  setCwd: (cwd: string | undefined) => void;
  backgroundTasks: BackgroundTask[];
  setBackgroundTasks: (tasks: BackgroundTask[]) => void;
  todos: TodoItem[];
  setTodos: (todos: TodoItem[]) => void;
  initData: InitData | null;
  setInitData: (data: InitData | null) => void;
  sidebarContent: ReactNode | null;
  setSidebarContent: (content: ReactNode | null) => void;
  closeSidebar: () => void;
}

const ShellContext = createContext<ShellContextValue>({
  setHeader: () => {},
  cwd: undefined,
  setCwd: () => {},
  backgroundTasks: [],
  setBackgroundTasks: () => {},
  todos: [],
  setTodos: () => {},
  initData: null,
  setInitData: () => {},
  sidebarContent: null,
  setSidebarContent: () => {},
  closeSidebar: () => {},
});

export function useShell() {
  return useContext(ShellContext);
}

export function usePageHeader(title: string) {
  const { setHeader } = useShell();
  useEffect(() => {
    setHeader({ title });
  }, [title, setHeader]);
}

export function useShellCwd(cwd: string | undefined) {
  const { setCwd } = useShell();
  useEffect(() => {
    setCwd(cwd);
    return () => setCwd(undefined);
  }, [cwd, setCwd]);
}

function FileBrowserButton({ cwd }: { cwd: string }) {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => router.push(`/files?cwd=${encodeURIComponent(cwd)}`)}
      title="Browse files"
    >
      <FolderOpen className="h-4 w-4" />
    </Button>
  );
}

function EditableTitle({ title, onRename }: { title: string; onRename?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(title); }, [title]);

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
        if (e.key === "Escape") { setValue(title); setEditing(false); }
      }}
      className="text-sm font-bold bg-transparent border-b border-primary outline-none w-40"
    />
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const sidebarRef = useRef<SidebarHandle>(null);
  const [header, setHeaderState] = useState<HeaderConfig>({ title: "Cockpit" });
  const [cwd, setCwdState] = useState<string | undefined>(undefined);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [initData, setInitData] = useState<InitData | null>(null);
  const [sidebarContent, setSidebarContentState] = useState<ReactNode | null>(null);

  const setSidebarContent = useCallback((content: ReactNode | null) => {
    setSidebarContentState(content);
  }, []);

  const setHeader = useCallback((config: HeaderConfig) => {
    setHeaderState(config);
  }, []);

  const setCwd = useCallback((val: string | undefined) => {
    setCwdState(val);
  }, []);

  const toggleSidebar = useCallback(() => {
    sidebarRef.current?.toggle();
  }, []);

  const closeSidebar = useCallback(() => {
    sidebarRef.current?.close();
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

  return (
    <AuthGuard>
      <WebSocketProvider>
        <ShellContext.Provider value={{ setHeader, cwd, setCwd, backgroundTasks, setBackgroundTasks, todos, setTodos, initData, setInitData, sidebarContent, setSidebarContent, closeSidebar }}>
          <div className="fixed inset-0 flex">
            <Sidebar ref={sidebarRef} />
            <div className="flex-1 min-h-0 min-w-0 flex flex-col">
              <header className="shrink-0 flex items-center gap-2 border-b px-4 py-2 bg-background">
                <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Toggle sidebar (Ctrl+B)" className="md:hidden">
                  <Menu className="h-4 w-4" />
                </Button>
                <div className="hidden md:block min-w-0 flex-1 overflow-hidden">
                  <EditableTitle title={header.title} onRename={header.onRename} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {cwd && <TodoIndicator todos={todos} />}
                  {cwd && <BackgroundTasksButton tasks={backgroundTasks} />}
                  {cwd && <UsageButton />}
                  {cwd && <McpStatusButton cwd={cwd} initData={initData} />}
                  {cwd && <GitStatusButton cwd={cwd} />}
                  {cwd && <FileBrowserButton cwd={cwd} />}
                </div>
              </header>
              <main className="flex-1 min-h-0 min-w-0 flex flex-col">
                {children}
              </main>
            </div>
          </div>
        </ShellContext.Provider>
      </WebSocketProvider>
    </AuthGuard>
  );
}
