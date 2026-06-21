export class BeingNotFoundError extends Error {
  public readonly code = "BEING_NOT_FOUND";
  constructor(public readonly beingId: string) {
    super(`Digital being not found: ${beingId}`);
    this.name = "BeingNotFoundError";
  }
}

export class InvalidBeingStatusError extends Error {
  public readonly code = "INVALID_BEING_STATUS";
  constructor(
    public readonly beingId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid status transition for being ${beingId}: ${from} -> ${to}`);
    this.name = "InvalidBeingStatusError";
  }
}
