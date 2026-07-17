import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./option-one.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://9enio.com"),
  title: "gênio — Playlist Research",
  description: "Research cited tracks and build an Apple Music playlist.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "gênio — Playlist Research",
    description: "Research cited tracks and build an Apple Music playlist.",
    url: "/",
    siteName: "gênio",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "gênio — Playlist Research" }],
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
  themeColor: "#080807",
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
