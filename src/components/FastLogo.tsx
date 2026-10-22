import { FAST_LOGO } from "../lib/logo";

/** Logo FAST en ASCII, dans la couleur primaire du thème. */
export function FastLogo({ className }: { className?: string }) {
  return (
    <pre className={className ? `fast-logo ${className}` : "fast-logo"} aria-label="FAST">
      {FAST_LOGO.join("\n")}
    </pre>
  );
}
