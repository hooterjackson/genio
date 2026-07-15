import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gênio — Playlist Research",
  description: "Research cited tracks and build an Apple Music playlist.",
  openGraph: {
    title: "gênio — Playlist Research",
    description: "Research cited tracks and build an Apple Music playlist.",
    type: "website",
    images: [{ url: "/og.png", width: 1660, height: 948, alt: "gênio — Playlist Research" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "gênio — Playlist Research",
    description: "Research cited tracks and build an Apple Music playlist.",
    images: ["/og.png"],
  },
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
      noarchive: true,
      noimageindex: true,
    },
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#30302E",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
      </body>
    </html>
  );
}
