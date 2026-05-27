import type { ISqlanvilExtension } from "sa/core";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

class SampleExtension implements ISqlanvilExtension {
    public compile(request: sqlanvil.ICompileExecutionRequest, session: Session): void {
        if (request.compileConfig?.projectConfigOverride?.vars["throw-error"] === "true") {
            throw new Error("throwing exception as requested!");
        }

        if (request.compileConfig?.projectConfigOverride?.vars["store-compile-error"] === "true") {
            session.compileError(new Error("storing compilation error as requested!"));
        }

        session.publish('sample-action').query("SELECT 1 as sample_id");
    }
}

export function extension(): ISqlanvilExtension {
    return new SampleExtension();
}
