import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Needle — Deep Playlist Research",
  description: "Source-bounded music research assembled into public Apple Music playlists.",
  openGraph: {
    title: "Needle — Deep Playlist Research",
    description: "Source-bounded music research assembled into public Apple Music playlists.",
    type: "website",
    images: [{ url: "/og.png", width: 1659, height: 948, alt: "Needle — Deep Playlist Research" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Needle — Deep Playlist Research",
    description: "Source-bounded music research assembled into public Apple Music playlists.",
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
  themeColor: "#050605",
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
