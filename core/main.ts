import {
  decode64,
  encode64,
  verifyObjectMatchesProto,
  VerifyProtoErrorBehaviour
} from "sa/common/protos";
import { Assertion } from "sa/core/actions/assertion";
import { DataPreparation } from "sa/core/actions/data_preparation";
import { Declaration } from "sa/core/actions/declaration";
import { IncrementalTable } from "sa/core/actions/incremental_table";
import { Notebook } from "sa/core/actions/notebook";
import { Operation } from "sa/core/actions/operation";
import { Table } from "sa/core/actions/table";
import { View } from "sa/core/actions/view";
import { ISqlanvilExtension } from "sa/core/extension";
import * as Path from "sa/core/path";
import { Session } from "sa/core/session";
import { nativeRequire } from "sa/core/utils";
import { readWorkflowSettings } from "sa/core/workflow_settings";
import { sqlanvil } from "sa/protos/ts";

/**
 * This is the main entry point into the user space code that should be invoked by the compilation wrapper sandbox.
 *
 * @param coreExecutionRequest an encoded @see {@link sqlanvil.CoreExecutionRequest} proto.
 * @returns an encoded @see {@link sqlanvil.CoreExecutionResponse} proto.
 */
export function main(coreExecutionRequest: Uint8Array | string): Uint8Array | string {
  const globalAny = global as any;

  let request: sqlanvil.CoreExecutionRequest;
  if (typeof coreExecutionRequest === "string") {
    // Older versions of the sqlanvil CLI send a base64 encoded string.
    // See https://github.com/dataform-co/dataform/pull/1570.
    request = decode64(sqlanvil.CoreExecutionRequest, coreExecutionRequest);
  } else {
    request = sqlanvil.CoreExecutionRequest.decode(coreExecutionRequest);
  }
  const compileRequest = request.compile;

  // Allow extensions to populate settings by themselves.
  const failIfMissing = !compileRequest?.compileConfig?.extension?.compilationMode;
  // Read the workflow settings from the root of the project.
  let projectConfig = readWorkflowSettings(failIfMissing);

  // Merge in project config overrides.
  const projectConfigOverride = compileRequest.compileConfig.projectConfigOverride ?? {};
  projectConfig = sqlanvil.ProjectConfig.create({
    ...projectConfig,
    ...projectConfigOverride,
    vars: { ...projectConfig.vars, ...projectConfigOverride.vars }
  });

  // Initialize the compilation session.
  const session = nativeRequire("@sqlanvil/core").session as Session;
  session.init(compileRequest.compileConfig.projectDir, projectConfig, projectConfig);

  // Allow "includes" files to use the current session object.
  globalAny.sqlanvil = session;

  prologueCompile(compileRequest, session);

  mainCompile(compileRequest, session);

  const coreExecutionResponse = sqlanvil.CoreExecutionResponse.create({
    compile: { compiledGraph: session.compile() }
  });

  if (typeof coreExecutionRequest === "string") {
    // Older versions of the sqlanvil CLI expect a base64 encoded string to be returned.
    // See https://github.com/dataform-co/dataform/pull/1570.
    return encode64(sqlanvil.CoreExecutionResponse, coreExecutionResponse);
  }

  return sqlanvil.CoreExecutionResponse.encode(coreExecutionResponse).finish();
}

function loadActionConfigs(session: Session, filePaths: string[]) {
  filePaths
    .filter(
      path =>
        path.startsWith(`definitions${Path.separator}`) &&
        Path.basename(path) === "actions" &&
        Path.fileExtension(path) === "yaml"
    )
    .sort()
    .forEach(actionConfigsPath => {
      const actionConfigs = loadActionConfigsFile(session, actionConfigsPath);
      actionConfigs.actions.forEach(nonProtoActionConfig => {
        const actionConfig = sqlanvil.ActionConfig.create(nonProtoActionConfig);

        if (actionConfig.table) {
          session.actions.push(
            new Table(
              session,
              sqlanvil.ActionConfig.TableConfig.create(actionConfig.table),
              actionConfigsPath
            )
          );
        } else if (actionConfig.view) {
          session.actions.push(
            new View(
              session,
              sqlanvil.ActionConfig.ViewConfig.create(actionConfig.view),
              actionConfigsPath
            )
          );
        } else if (actionConfig.incrementalTable) {
          session.actions.push(
            new IncrementalTable(
              session,
              sqlanvil.ActionConfig.IncrementalTableConfig.create(actionConfig.incrementalTable),
              actionConfigsPath
            )
          );
        } else if (actionConfig.assertion) {
          session.actions.push(
            new Assertion(
              session,
              sqlanvil.ActionConfig.AssertionConfig.create(actionConfig.assertion),
              actionConfigsPath
            )
          );
        } else if (actionConfig.operation) {
          session.actions.push(
            new Operation(
              session,
              sqlanvil.ActionConfig.OperationConfig.create(actionConfig.operation),
              actionConfigsPath
            )
          );
        } else if (actionConfig.declaration) {
          session.actions.push(
            new Declaration(
              session,
              sqlanvil.ActionConfig.DeclarationConfig.create(actionConfig.declaration)
            )
          );
        } else if (actionConfig.notebook) {
          session.actions.push(
            new Notebook(
              session,
              sqlanvil.ActionConfig.NotebookConfig.create(actionConfig.notebook),
              actionConfigsPath
            )
          );
        } else if (actionConfig.dataPreparation) {
          session.actions.push(
            new DataPreparation(
              session,
              sqlanvil.ActionConfig.DataPreparationConfig.create(actionConfig.dataPreparation),
              actionConfigsPath
            )
          );
        } else {
          throw Error("Empty action configs are not permitted.");
        }
      });
    });
}

function loadActionConfigsFile(
  session: Session,
  actionConfigsPath: string
): sqlanvil.ActionConfigs {
  let actionConfigsAsJson = {};
  try {
    // tslint:disable-next-line: tsr-detect-non-literal-require
    actionConfigsAsJson = nativeRequire(actionConfigsPath).asJson;
  } catch (e) {
    session.compileError(e, actionConfigsPath);
  }
  verifyObjectMatchesProto(
    sqlanvil.ActionConfigs,
    actionConfigsAsJson,
    VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
  );
  return sqlanvil.ActionConfigs.fromObject(actionConfigsAsJson);
}

function prologueCompile(compileRequest: sqlanvil.ICompileExecutionRequest, session: Session) {
  if (compileRequest?.compileConfig?.extension?.compilationMode === sqlanvil.ExtensionCompilationMode.PROLOGUE) {
    extensionCompile(compileRequest, session);
  }
}

function mainCompile(compileRequest: sqlanvil.ICompileExecutionRequest, session: Session) {
  if (compileRequest?.compileConfig?.extension?.compilationMode === sqlanvil.ExtensionCompilationMode.APPLICATION_CODE) {
    extensionCompile(compileRequest, session);
    return;
  }

  sqlanvilCompile(compileRequest, session);
}

function extensionCompile(compileRequest: sqlanvil.ICompileExecutionRequest, session: Session) {
  try {
    const module = nativeRequire(compileRequest?.compileConfig?.extension.name);
    const extension: () => ISqlanvilExtension = module.extension;
    extension().compile(compileRequest, session);
  } catch (e) {
    session.compileError(e, compileRequest?.compileConfig?.extension.name);
  }
}

function sqlanvilCompile(compileRequest: sqlanvil.ICompileExecutionRequest, session: Session) {
  const globalAny = global as any;

  // Require "includes/*.js" files, attaching them (by file basename) to the `global` object.
  // We delay attaching them to `global` until after all have been required, to prevent
  // "includes" files from implicitly depending on other "includes" files.
  const topLevelIncludes: { [key: string]: any } = {};
  compileRequest.compileConfig.filePaths
    .filter(path => path.startsWith(`includes${Path.separator}`))
    .filter(path => path.split(Path.separator).length === 2) // Only include top-level "includes" files.
    .filter(path => Path.fileExtension(path) === "js")
    .forEach(includePath => {
      try {
        // tslint:disable-next-line: tsr-detect-non-literal-require
        topLevelIncludes[Path.basename(includePath)] = nativeRequire(includePath);
      } catch (e) {
        session.compileError(e, includePath);
      }
    });
  Object.assign(globalAny, topLevelIncludes);

  // Bind various @sqlanvil/core APIs to the 'global' object.
  globalAny.publish = session.publish.bind(session);
  globalAny.operate = session.operate.bind(session);
  globalAny.assert = session.assert.bind(session);
  globalAny.declare = session.declare.bind(session);
  globalAny.notebook = session.notebook.bind(session);
  globalAny.test = session.test.bind(session);
  globalAny.jitData = session.jitData.bind(session);

  loadActionConfigs(session, compileRequest.compileConfig.filePaths);

  // Require all "definitions" files (attaching them to the session).
  compileRequest.compileConfig.filePaths
    .filter(path => path.startsWith(`definitions${Path.separator}`))
    .filter(path => Path.fileExtension(path) === "js" || Path.fileExtension(path) === "sqlx")
    .sort()
    .forEach(definitionPath => {
      try {
        // tslint:disable-next-line: tsr-detect-non-literal-require
        nativeRequire(definitionPath);
      } catch (e) {
        session.compileError(e, definitionPath);
      }
    });
}
