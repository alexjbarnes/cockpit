import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cockpit",
  description: "Claude Code Web UI",
  manifest: "/manifest.json",
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full overflow-hidden" suppressHydrationWarning>
      <body className="h-full overflow-hidden bg-background font-sans antialiased">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("cockpit-theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})();if("serviceWorker"in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js")})}`,
          }}
        />
      </body>
    </html>
  );
}
