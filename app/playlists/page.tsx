import type { Metadata } from "next";
import { PlaylistDirectory } from "./playlist-directory";

export const metadata: Metadata = {
  title: "Playlists · gênio",
  description: "Explore public Apple Music playlists researched and assembled by gênio.",
};

export default function PlaylistsPage() {
  return <PlaylistDirectory />;
}
