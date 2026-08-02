import type { Metadata } from "next";
import Link from "next/link";
import { PublicSiteHeader } from "../public-site-header";
import { currentRelease, formatReleaseDate, releaseHistory } from "../../shared/release-metadata";
import { RuntimeBuild } from "./runtime-build";

export const metadata: Metadata = {
  title: `About · gênio v${currentRelease.version}`,
  description: "See the gênio version running in production and read its release notes.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <main className="app-shell about-page">
      <PublicSiteHeader />

      <section className="about-shell" aria-labelledby="about-title">
        <header className="about-hero">
          <p>ABOUT GÊNIO</p>
          <h1 id="about-title">gênio <span>v{currentRelease.version}</span></h1>
          <div className="about-release-line">
            <span>{currentRelease.status === "candidate"
              ? "RELEASE CANDIDATE"
              : "CURRENT RELEASE"}</span>
            {currentRelease.releasedAt
              ? <time dateTime={currentRelease.releasedAt}>
                  {formatReleaseDate(currentRelease.releasedAt)}
                </time>
              : <span>PROOF PENDING</span>}
          </div>
          <p className="about-intro">Deep music research, assembled into public Apple Music playlists. Release history and the deployed API build are shown below.</p>
        </header>

        <RuntimeBuild />

        <section className="about-releases" aria-labelledby="release-notes-title">
          <div className="about-section-heading">
            <h2 id="release-notes-title">Release notes</h2>
            <span>{releaseHistory.length} {releaseHistory.length === 1 ? "RELEASE" : "RELEASES"}</span>
          </div>
          <ol className="release-list">
            {releaseHistory.map((release, index) => (
              <li key={release.version}>
                <article>
                  <div className="release-heading">
                    <div>
                      <span>{index === 0 ? "CURRENT" : "ARCHIVE"}</span>
                      <h3>v{release.version} · {release.title}</h3>
                    </div>
                    {release.releasedAt
                      ? <time dateTime={release.releasedAt}>
                          {formatReleaseDate(release.releasedAt)}
                        </time>
                      : <span>RELEASE CANDIDATE · PROOF PENDING</span>}
                  </div>
                  <ul>
                    {release.notes.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                </article>
              </li>
            ))}
          </ol>
        </section>
      </section>

      <footer className="site-footer">
        <Link href="/">← CREATE A PLAYLIST</Link>
        <span>SEMANTICALLY VERSIONED.</span>
      </footer>
    </main>
  );
}
