import Link from "next/link";
import { FeedbackForm } from "./feedback-form";
import { SiteMenu } from "../site-menu";
import { BrandWordmark } from "../brand-wordmark";
import { PrimaryNav } from "../primary-nav";

export default function FeedbackPage() {
  return (
    <main className="app-shell feedback-page">
      <header className="site-header">
        <Link className="wordmark ascii-wordmark" href="/" aria-label="gênio home"><BrandWordmark /></Link>
        <div className="header-meta">
          <PrimaryNav />
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
