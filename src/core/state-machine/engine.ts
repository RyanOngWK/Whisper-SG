/**
 * State machine engine — runs the dental flow deterministically
 * and falls back to LLM when  the handler requests it.
 */

import {
  type StateHandler,
  type StateContext,
  type StateTransition,
  type StateMachineListener,
  type StateMachineEvent,
} from "./types.js";

export class StateMachineEngine {
  private listeners: StateMachineListener[] = [];

  constructor(
    private registry: Record<string, StateHandler>,
    private llmFallback: (ctx: StateContext) => Promise<StateTransition>,
  ) {}

  on(listener: StateMachineListener): void {
    this.listeners.push(listener);
  }

  private emit(event: StateMachineEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async advance(
    currentState: string,
    ctx: StateContext,
  ): Promise<StateTransition> {
    const handler = this.registry[currentState];
    if (!handler) {
      throw new Error(
        `No handler registered for state "${currentState}"`,
      );
    }

    this.emit({
      type: "state_entered",
      state: currentState as never,
      sessionId: ctx.session.sessionId,
    });

    let transition: StateTransition;

    if (currentState === "fallback_llm") {
      transition = await this.llmFallback(ctx);
    } else {
      transition = await handler(ctx);
    }

    this.emit({
      type: "transition",
      from: currentState as never,
      to: transition.nextState as never,
      sessionId: ctx.session.sessionId,
    });

    this.emit({
      type: "state_exited",
      state: currentState as never,
      sessionId: ctx.session.sessionId,
    });

    if (transition.nextState === "fallback_llm") {
      this.emit({
        type: "llm_fallback_invoked",
        sessionId: ctx.session.sessionId,
        reason: (transition.payload?.reason as string | undefined) ?? "unknown",
      });
    }

    return transition;
  }
}
