import Link from "next/link";
import { FeedbackForm } from "./feedback-form";
import { PublicSiteHeader } from "../public-site-header";

export default function FeedbackPage() {
  return (
    <main className="app-shell feedback-page">
      <PublicSiteHeader />
      <FeedbackForm />
      <footer className="site-footer">
        <span>PRIVATE OWNER INBOX.</span>
        <Link href="/privacy">PRIVACY</Link>
      </footer>
    </main>
  );
}
