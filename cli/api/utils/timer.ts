import Long from "long";

import { sqlanvil } from "sa/protos/ts";

export class Timer {
  public static start(existingTiming?: sqlanvil.ITiming) {
    return new Timer(existingTiming?.startTimeMillis?.toNumber() || new Date().valueOf());
  }
  private constructor(readonly startTimeMillis: number) {}

  public current(): sqlanvil.ITiming {
    return {
      startTimeMillis: Long.fromNumber(this.startTimeMillis),
    };
  }

  public end(): sqlanvil.ITiming {
    return {
      startTimeMillis: Long.fromNumber(this.startTimeMillis),
      endTimeMillis: Long.fromNumber(new Date().valueOf()),
    };
  }
}
