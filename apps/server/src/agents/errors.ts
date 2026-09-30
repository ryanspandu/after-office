/** An error meant for the dashboard user (or the manager's tool result), with the HTTP status to answer with. */
export class AgentError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 = 400,
  ) {
    super(message)
  }
}
