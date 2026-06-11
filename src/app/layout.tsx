import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cockpit",
  description: "Claude Code Web UI",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icon-192.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Cockpit",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

const THEME_INIT = `(function(){try{var t=localStorage.getItem("cockpit-theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})();`;

// The shell-cache service worker (sw.js) is cache-first for /_next/static, which is
// correct in production (content-hashed URLs) but poisons development: dev chunk URLs
// are stable while their contents change across edits and server restarts, so a stale
// chunk gets served against a fresh shell and the page fails to hydrate (blank screen).
// Register it only in production; in dev, actively unregister any leftover SW and clear
// its caches so a previously-poisoned origin self-heals on the next load.
const SW_SCRIPT =
  process.env.NODE_ENV === "production"
    ? `if("serviceWorker"in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js")})}`
    : `if("serviceWorker"in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister()})});if(window.caches){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k)})})}}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full overflow-hidden" suppressHydrationWarning>
      <body className="h-full overflow-hidden bg-background font-sans antialiased">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_INIT + SW_SCRIPT,
          }}
        />
      </body>
    </html>
  );
}
