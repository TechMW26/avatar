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
  title: "Bharat Darshan AI - Living History",
  description: "Choose a historical guide and have an immersive AI-powered conversation with Rishi Sandipani, Rani Lakshmi Bai, or Chhatrapati Shivaji Maharaj.",
  manifest: "/manifest.json",
  keywords: ["Rishi Sandipani", "Rani Lakshmi Bai", "Chhatrapati Shivaji Maharaj", "Indian history", "interactive AI", "living history"],
  authors: [{ name: "MWFutureTech" }],
  creator: "MWFutureTech",
  metadataBase: new URL("https://rishi-sandipani.vercel.app"),
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Bharat Darshan AI",
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
  openGraph: {
    type: "website",
    url: "https://rishisandipani.com",
    title: "Bharat Darshan AI - Living History",
    description: "Meet three iconic historical guides in an immersive AI-powered experience.",
    siteName: "Bharat Darshan AI",
    images: [
      {
        url: "https://rishi-sandipani.vercel.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Bharat Darshan AI historical guides",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Bharat Darshan AI - Living History",
    description: "Meet three iconic historical guides in an immersive AI-powered experience.",
    images: ["https://rishi-sandipani.vercel.app/og-image.png"],
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
      </head>
      <body
        suppressHydrationWarning
        className={`${inter.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
