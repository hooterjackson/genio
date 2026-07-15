import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="app-shell">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="gênio home"><span>[g]</span> gênio_</Link>
        <Link className="privacy-back" href="/">BACK</Link>
      </header>

      <section className="privacy-shell" aria-labelledby="privacy-title">
        <div className="screen-index">/ PRIVACY · EFFECTIVE 2026-07-14</div>
        <h1 id="privacy-title">PRIVACY_</h1>
        <p className="privacy-intro">gênio uses the minimum data needed to research and publish a requested playlist.</p>

        <div className="privacy-grid">
          <article>
            <h2>RUN DATA</h2>
            <p>We process your prompt, scope, research evidence, review decisions, and playlist result. A private browser cookie keeps your jobs available on this device; visitors do not provide emails or create accounts.</p>
          </article>
          <article>
            <h2>ABUSE CONTROL</h2>
            <p>We store daily HMAC-derived network buckets for rate limits, never raw IP addresses. Rate-limit events are deleted after 48 hours.</p>
          </article>
          <article>
            <h2>AI + PROVIDERS</h2>
            <p>OpenAI processes prompts and web research with AI. OpenAI Sites serves the interface, Railway runs and stores the service, Resend alerts only the owner, and Apple Music receives the final playlist publication request.</p>
          </article>
          <article>
            <h2>RETENTION + DELETE</h2>
            <p>Detailed run data is kept for 90 days; after that, only Apple links, playlist title, manifest hash, outcome counts, aggregate cost, and minimal operational records remain. Deleting a run removes its detailed gênio data, but cannot remove a playlist already published through the owner&apos;s Apple Music account.</p>
          </article>
          <article>
            <h2>CONTACT + AGE</h2>
            <p>gênio is not directed to children and does not knowingly solicit their data. Privacy questions: <a href="mailto:mrcloblima@gmail.com">mrcloblima@gmail.com</a>.</p>
          </article>
        </div>
      </section>

      <footer className="site-footer">
        <Link href="/">← REQUEST A PLAYLIST</Link>
        <span>90-DAY DETAIL RETENTION.</span>
      </footer>
    </main>
  );
}
