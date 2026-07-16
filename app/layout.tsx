import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://9enio.com"),
  title: "9ênio — Playlist Research",
  description: "Research cited tracks and build an Apple Music playlist.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "9ênio — Playlist Research",
    description: "Research cited tracks and build an Apple Music playlist.",
    url: "/",
    siteName: "9ênio",
    type: "website",
    images: [{ url: "/og.png", width: 1659, height: 948, alt: "9ênio — Playlist Research" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "9ênio — Playlist Research",
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
