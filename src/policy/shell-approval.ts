export interface ShellApprovalRequest {
  command: string;
  reason: string;
}

export type ShellApprovalHandler = (request: ShellApprovalRequest) => Promise<boolean>;

export class ShellApprovalGate {
  private handler: ShellApprovalHandler | undefined;
  private queue: Promise<void> = Promise.resolve();

  setHandler(handler: ShellApprovalHandler | undefined): void {
    this.handler = handler;
  }

  request(request: ShellApprovalRequest): Promise<boolean> {
    const decision = this.queue.then(async () => {
      const handler = this.handler;
      return handler ? handler(request) : false;
    });
    this.queue = decision.then(() => undefined, () => undefined);
    return decision;
  }
}
