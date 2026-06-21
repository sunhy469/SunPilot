import type { DatabaseContext } from "@sunpilot/storage";
import type { PlatformRequestContext } from "../context.js";
import type { CreateBeingInput, UpdateBeingInput } from "./digital-world.types.js";
import { BeingNotFoundError, InvalidBeingStatusError } from "./digital-being.errors.js";

const VALID_SLEEP_TRANSITIONS = new Set(["idle", "working", "moving", "waiting"]);

export class DigitalBeingService {
  constructor(private readonly deps: { database: DatabaseContext }) {}

  async createBeing(_context: PlatformRequestContext, input: CreateBeingInput) {
    let conversationId = input.conversationId;
    if (!conversationId) {
      const conversation = await this.deps.database.conversations.create({
        title: input.name,
      });
      conversationId = conversation.id;
    }

    return this.deps.database.digitalBeings.create({
      name: input.name,
      description: input.description,
      homeNodeId: input.homeNodeId,
      currentNodeId: input.homeNodeId,
      conversationId,
    });
  }

  async getBeing(_context: PlatformRequestContext, id: string) {
    const being = await this.deps.database.digitalBeings.findById(id);
    if (!being) {
      throw new BeingNotFoundError(id);
    }
    return being;
  }

  async listBeings(_context: PlatformRequestContext) {
    return this.deps.database.digitalBeings.list();
  }

  async updateBeing(_context: PlatformRequestContext, id: string, patch: UpdateBeingInput) {
    const updated = await this.deps.database.digitalBeings.update(id, patch);
    if (!updated) {
      throw new BeingNotFoundError(id);
    }
    return updated;
  }

  async sleepBeing(_context: PlatformRequestContext, id: string, reason?: string) {
    const being = await this.deps.database.digitalBeings.findById(id);
    if (!being) {
      throw new BeingNotFoundError(id);
    }
    if (!VALID_SLEEP_TRANSITIONS.has(being.status)) {
      throw new InvalidBeingStatusError(id, being.status, "sleeping");
    }
    const updated = await this.deps.database.digitalBeings.update(id, {
      status: "sleeping",
      sleepReason: reason,
    });
    if (!updated) {
      throw new BeingNotFoundError(id);
    }
    return updated;
  }

  async wakeBeing(_context: PlatformRequestContext, id: string) {
    const being = await this.deps.database.digitalBeings.findById(id);
    if (!being) {
      throw new BeingNotFoundError(id);
    }
    if (being.status !== "sleeping") {
      throw new InvalidBeingStatusError(id, being.status, "idle");
    }
    const updated = await this.deps.database.digitalBeings.update(id, {
      status: "idle",
      sleepReason: undefined,
    });
    if (!updated) {
      throw new BeingNotFoundError(id);
    }
    return updated;
  }
}
