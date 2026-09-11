import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** A user turn can span several requests, tools, retries and compactions. */
export function limitSessionDuration(session: Pick<AgentSession, "subscribe" | "abortRetry" | "abortCompaction" | "abort" | "dispose">, timeoutMs: number): void {
  if (timeoutMs === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => { clearTimeout(timer); timer = undefined; };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start" && timer === undefined) {
      timer = setTimeout(() => {
        session.abortRetry();
        session.abortCompaction();
        void session.abort().catch(() => undefined);
      }, timeoutMs);
      timer.unref();
    }
    if (event.type === "agent_settled") clear();
  });
  const dispose = session.dispose.bind(session);
  session.dispose = () => { clear(); unsubscribe(); dispose(); };
}
