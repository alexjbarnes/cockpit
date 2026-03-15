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
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/auth-guard";
import { WebSocketProvider } from "@/hooks/use-websocket";
import { UsageButton } from "@/components/usage-modal";
import { Sidebar, type SidebarHandle } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Menu } from "lucide-react";
import { GitStatusButton } from "@/components/git-status-modal";
import { BackgroundTasksButton } from "@/components/task-indicator";
import { TodoIndicator } from "@/components/todo-indicator";
import type { BackgroundTask, TodoItem } from "@/types";

interface HeaderConfig {
  title: string;
  showBack: boolean;
}

interface ShellContextValue {
  setHeader: (config: HeaderConfig) => void;
  cwd: string | undefined;
  setCwd: (cwd: string | undefined) => void;
  backgroundTasks: BackgroundTask[];
  setBackgroundTasks: (tasks: BackgroundTask[]) => void;
  todos: TodoItem[];
  setTodos: (todos: TodoItem[]) => void;
}

const ShellContext = createContext<ShellContextValue>({
  setHeader: () => {},
  cwd: undefined,
  setCwd: () => {},
  backgroundTasks: [],
  setBackgroundTasks: () => {},
  todos: [],
  setTodos: () => {},
});

export function useShell() {
  return useContext(ShellContext);
}

export function usePageHeader(title: string, showBack = false) {
  const { setHeader } = useShell();
  useEffect(() => {
    setHeader({ title, showBack });
  }, [title, showBack, setHeader]);
}

export function useShellCwd(cwd: string | undefined) {
  const { setCwd } = useShell();
  useEffect(() => {
    setCwd(cwd);
    return () => setCwd(undefined);
  }, [cwd, setCwd]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const sidebarRef = useRef<SidebarHandle>(null);
  const [header, setHeaderState] = useState<HeaderConfig>({ title: "Aperture", showBack: false });
  const [cwd, setCwdState] = useState<string | undefined>(undefined);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  const setHeader = useCallback((config: HeaderConfig) => {
    setHeaderState(config);
  }, []);

  const setCwd = useCallback((val: string | undefined) => {
    setCwdState(val);
  }, []);

  const toggleSidebar = useCallback(() => {
    sidebarRef.current?.toggle();
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
        <ShellContext.Provider value={{ setHeader, cwd, setCwd, backgroundTasks, setBackgroundTasks, todos, setTodos }}>
          <div className="fixed inset-0 flex flex-col">
            <header className="shrink-0 flex items-center gap-2 border-b px-4 py-2 bg-background">
              <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Toggle sidebar (Ctrl+B)">
                <Menu className="h-4 w-4" />
              </Button>
              {header.showBack && (
                <Button variant="ghost" size="icon" onClick={() => router.back()}>
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              )}
              <span className="text-sm font-bold">{header.title}</span>
              <div className="ml-auto flex items-center gap-2">
                {cwd && <TodoIndicator todos={todos} />}
                {cwd && <BackgroundTasksButton tasks={backgroundTasks} />}
                {cwd && <UsageButton />}
                {cwd && <GitStatusButton cwd={cwd} />}
              </div>
            </header>
            {children}
          </div>
          <Sidebar ref={sidebarRef} />
        </ShellContext.Provider>
      </WebSocketProvider>
    </AuthGuard>
  );
}
