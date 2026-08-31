import type { Clock, DeterministicIdGenerator } from "./determinism.js";
import type { TraceEvent, TraceEventType, TracePayloadMap } from "./types.js";

export class TraceRecorder {
  private readonly recordedEvents: TraceEvent[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly ids: DeterministicIdGenerator,
  ) {}

  append<Type extends TraceEventType>(
    type: Type,
    payload: TracePayloadMap[Type],
    correlationId?: string,
  ): TraceEvent {
    const base = {
      id: this.ids.next("event"),
      sequence: this.recordedEvents.length + 1,
      timestamp: this.clock.now(),
      type,
      payload,
    };
    const event = (
      correlationId ? { ...base, correlation_id: correlationId } : base
    ) as TraceEvent;
    this.recordedEvents.push(event);
    return event;
  }

  events(): TraceEvent[] {
    return structuredClone(this.recordedEvents);
  }
}
