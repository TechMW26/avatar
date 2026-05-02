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
  description: "Interactive AI Guru - Rishi Sandipani from the Gurukul of Ujjain. Seek wisdom from the legendary sage of Ujjain in an immersive AI-powered experience.",
  manifest: "/manifest.json",
  keywords: ["Rishi Sandipani", "Gurukul", "AI Guru", "Ujjain", "Indian mythology", "interactive AI", "Sanskrit", "vedic knowledge"],
  authors: [{ name: "MWFutureTech" }],
  creator: "MWFutureTech",
  metadataBase: new URL("https://rishi-sandipani.vercel.app"),
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
  openGraph: {
    type: "website",
    url: "https://rishisandipani.com",
    title: "Rishi Sandipani - Gurukul AI",
    description: "Seek wisdom from the legendary sage of Ujjain in an immersive AI-powered Gurukul experience.",
    siteName: "Rishi Sandipani Gurukul",
    images: [
      {
        url: "https://rishi-sandipani.vercel.app/og-image.png",
        width: 1200,
        height: 630,
        alt: "Rishi Sandipani - AI Guru of Ujjain",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Rishi Sandipani - Gurukul AI",
    description: "Seek wisdom from the legendary sage of Ujjain in an immersive AI-powered Gurukul experience.",
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
        className={`${inter.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
