"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AuthGuard } from "@/components/auth-guard";
import { WebSocketProvider } from "@/hooks/use-websocket";
import { ConnectionStatus } from "@/components/connection-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sidebar } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Menu, Settings } from "lucide-react";
import Link from "next/link";

interface AppShellProps {
  title: string;
  showBack?: boolean;
  children: ReactNode;
}

export function AppShell({ title, showBack, children }: AppShellProps) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
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
        <div className="fixed inset-0 flex flex-col">
          <header className="shrink-0 flex items-center gap-2 border-b px-4 py-2 bg-background">
            <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Toggle sidebar (Ctrl+B)">
              <Menu className="h-4 w-4" />
            </Button>
            {showBack && (
              <Button variant="ghost" size="icon" onClick={() => router.push("/")}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <span className="text-sm font-bold">{title}</span>
            <div className="ml-auto flex items-center gap-1">
              <ConnectionStatus />
              <ThemeToggle />
              <Button variant="ghost" size="icon" asChild>
                <Link href="/settings">
                  <Settings className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </header>
          {children}
        </div>
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      </WebSocketProvider>
    </AuthGuard>
  );
}
