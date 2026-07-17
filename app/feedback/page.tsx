import Link from "next/link";
import { FeedbackForm } from "./feedback-form";
import { SiteMenu } from "../site-menu";

export default function FeedbackPage() {
  return (
    <main className="app-shell feedback-page">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="9ênio home"><span>[9]</span> 9ênio_</Link>
        <div className="header-meta">
          <Link className="header-action" href="/">BACK</Link>
          <SiteMenu />
        </div>
      </header>
      <FeedbackForm />
      <footer className="site-footer">
        <span>PRIVATE OWNER INBOX.</span>
        <Link href="/privacy">PRIVACY</Link>
      </footer>
    </main>
  );
}
