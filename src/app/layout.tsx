import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0D0A07",
};

export const metadata: Metadata = {
  title: "Rishi Sandipani - Gurukul AI",
  description: "Interactive AI Guru - Rishi Sandipani from the Gurukul of Ujjain",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Rishi Sandipani",
  },
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon.png",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://storage.googleapis.com" crossOrigin="anonymous" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(typeof window==='undefined')return;try{window.localStorage.clear()}catch{}try{window.sessionStorage.clear()}catch{}if('serviceWorker'in navigator){navigator.serviceWorker.getRegistrations().then((regs)=>Promise.all(regs.map((r)=>r.unregister()))).catch(()=>{})}if('caches'in window){caches.keys().then((keys)=>Promise.all(keys.map((k)=>caches.delete(k)))).catch(()=>{})}if(window.indexedDB&&indexedDB.databases){indexedDB.databases().then((dbs)=>dbs.forEach((db)=>{if(db&&db.name)indexedDB.deleteDatabase(db.name)})).catch(()=>{})}}catch{}})();`,
          }}
        />
      </head>
      <body
        className={`${inter.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
