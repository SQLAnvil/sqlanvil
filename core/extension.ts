import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

/**
 * Extension interface.
 */
export interface ISqlanvilExtension {
    /**
     * Run additional compilation steps.
     * Passed session should be used for both new nodes creation and persisting errors.
     */
    compile(request: sqlanvil.ICompileExecutionRequest, session: Session): void;
}
