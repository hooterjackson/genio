import Link from "next/link";
import { PublicSiteHeader } from "../public-site-header";

export default function PrivacyPage() {
  return (
    <main className="app-shell">
      <PublicSiteHeader />

      <section className="privacy-shell" aria-labelledby="privacy-title">
        <h1 id="privacy-title">Privacy</h1>
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
            <h2>FEEDBACK</h2>
            <p>If you submit feedback, we store your message, its type, the page where you opened the form, and any optional screenshot. Submissions are private to the owner and are not automatically sent to OpenAI. Unresolved reports remain in the owner inbox; resolved reports and attached images are deleted after 90 days.</p>
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
