export const GENIO_ASCII_WORDMARK = [
  "   ____ /\\          _",
  "  / __ \\___  ____  (_)___",
  " / /_/ / _ \\/ __ \\/ / __ \\",
  " \\__, /  __/ / / / / /_/ /",
  "/____/\\___/_/ /_/_/\\____/",
].join("\n");

export function BrandWordmark({ className = "brand-wordmark-art" }: { className?: string }) {
  return (
    <>
      <pre className={className} aria-hidden="true">{GENIO_ASCII_WORDMARK}</pre>
      <span className="sr-only">gênio</span>
    </>
  );
}
