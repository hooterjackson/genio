import { chatGPTSignOutPath, requireChatGPTUser } from "../chatgpt-auth";
import { OwnerConsole } from "./owner-console";
import { headers } from "next/headers";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function OwnerPage() {
  const user = await requireChatGPTUser("/owner");
  const requestHeaders = await headers();
  const allowed = requestHeaders.get("x-needle-owner-verified") === "1";

  if (!allowed) {
    return (
      <main className="app-shell">
        <header className="site-header">
          <Link className="wordmark" href="/"><span>[g]</span> gênio_</Link>
          <a href={chatGPTSignOutPath("/")}>SIGN OUT</a>
        </header>
        <section className="owner-shell">
          <div className="screen-index">/ ACCESS DENIED</div>
          <h1>OWNER ONLY.</h1>
          <p>This ChatGPT identity is not included in gênio’s server-side owner allowlist.</p>
        </section>
      </main>
    );
  }

  return <OwnerConsole email={user.email} signOutPath={chatGPTSignOutPath("/")} />;
}
