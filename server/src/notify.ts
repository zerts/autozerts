/** macOS notifications via osascript — fired on blocked and terminal states. */
import { log } from "./log";

export function notify(title: string, message: string): void {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const proc = Bun.spawn(
    ["osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
    { stdout: "ignore", stderr: "pipe" },
  );
  proc.exited.then(async (code) => {
    if (code !== 0) log.warn("notification failed:", await new Response(proc.stderr).text());
  });
}
