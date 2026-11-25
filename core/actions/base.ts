import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export abstract class ActionBuilder<T> {
  public session: Session;
  public includeAssertionsForDependency: Map<string, boolean> = new Map();
  private uniqueKeyAssertions: any[] = [];
  private rowConditionsAssertion?: any;
  /**
   * The dataset explicitly configured for this action's inline assertions (`assertions.dataset`),
   * if any. Takes precedence over the project-level default assertion dataset.
   */
  private inlineAssertionsDataset?: string;
  /**
   * The project explicitly configured for this action's inline assertions (`assertions.project`),
   * if any. Takes precedence over the project of the action itself.
   */
  private inlineAssertionsProject?: string;

  constructor(session?: Session) {
    this.session = session;
  }

  public applySessionToTarget(
    targetFromConfig: sqlanvil.Target,
    projectConfig: sqlanvil.ProjectConfig,
    fileName?: string,
    options?: {
      validateTarget?: boolean;
      useDefaultAssertionDataset?: boolean;
    },
  ): sqlanvil.Target {
    const defaultSchema = options?.useDefaultAssertionDataset
      ? projectConfig.assertionSchema || projectConfig.defaultSchema
      : projectConfig.defaultSchema;
    const target = sqlanvil.Target.create({
      name: targetFromConfig.name,
      schema: targetFromConfig.schema || defaultSchema || undefined,
      database: targetFromConfig.database || projectConfig.defaultDatabase || undefined,
    });
    if (options?.validateTarget) {
      // The resolved target, so a default from workflow_settings.yaml is checked too (upstream #2461).
      this.validateTarget(target, fileName);
    }
    return target;
  }

  public finalizeTarget(targetFromConfig: sqlanvil.Target): sqlanvil.Target {
    return sqlanvil.Target.create({
      name: this.session.finalizeName(targetFromConfig.name),
      schema: targetFromConfig.schema
        ? this.session.finalizeSchema(targetFromConfig.schema)
        : undefined,
      database: targetFromConfig.database
        ? this.session.finalizeDatabase(targetFromConfig.database)
        : undefined,
    });
  }

  /** Retrieves the filename from the config. */
  public abstract getFileName(): string;

  /** Retrieves the resolved target from the proto. */
  public abstract getTarget(): sqlanvil.Target;

  /** Creates the final protobuf representation. */
  public abstract compile(): T;

  protected generateInlineAssertions(
    tableAssertionsConfig: sqlanvil.ActionConfig.TableAssertionsConfig,
    proto: sqlanvil.Table,
  ) {
    this.uniqueKeyAssertions = [];
    this.rowConditionsAssertion = undefined;
    if (!!tableAssertionsConfig.uniqueKey?.length && !!tableAssertionsConfig.uniqueKeys?.length) {
      this.session.compileError(
        new Error("Specify at most one of 'assertions.uniqueKey' and 'assertions.uniqueKeys'."),
      );
    }
    let uniqueKeys = tableAssertionsConfig.uniqueKeys?.map((uniqueKey) =>
      sqlanvil.ActionConfig.TableAssertionsConfig.UniqueKey.create(uniqueKey),
    );
    if (!!tableAssertionsConfig.uniqueKey?.length) {
      uniqueKeys = [
        sqlanvil.ActionConfig.TableAssertionsConfig.UniqueKey.create({
          uniqueKey: tableAssertionsConfig.uniqueKey,
        }),
      ];
    }
    // `database` and `schema` are the legacy names for `project` and `dataset`; they are accepted
    // here for callers of the JS API's `.assertions()` method, which bypasses the legacy config
    // conversion. That method is deprecated, so once it's removed this code can be simplified.
    this.inlineAssertionsProject =
      (tableAssertionsConfig as any).database || tableAssertionsConfig.project || undefined;
    // Precedence: action-level assertion project, then the project of the parent action (which
    // itself falls back to the default project).
    const project = this.inlineAssertionsProject || proto.target.database || undefined;
    this.inlineAssertionsDataset =
      (tableAssertionsConfig as any).schema || tableAssertionsConfig.dataset || undefined;
    const dataset =
      this.inlineAssertionsDataset ||
      this.session.projectConfig.assertionSchema ||
      proto.target.schema ||
      undefined;
    if (uniqueKeys) {
      uniqueKeys.forEach(({ uniqueKey }, index) => {
        const uniqueKeyAssertion = this.session
          .assert(
            this.inlineAssertionName(proto.target, `assertions_uniqueKey_${index}`),
            sqlanvil.ActionConfig.AssertionConfig.create({
              filename: proto.fileName,
              project,
              dataset,
            }),
          )
          .query((ctx) =>
            this.session.compilationSql().indexAssertion(ctx.ref(proto.target), uniqueKey),
          );
        if (proto.tags) {
          uniqueKeyAssertion.tags(proto.tags);
        }
        uniqueKeyAssertion.setParentAction(sqlanvil.Target.create(proto.target));
        if (proto.disabled) {
          uniqueKeyAssertion.disabled();
        }
        this.uniqueKeyAssertions.push(uniqueKeyAssertion);
      });
    }
    // Copy, so nonNull conditions are not appended to an array the user may share across actions
    // (upstream #2424).
    const mergedRowConditions = [...(tableAssertionsConfig.rowConditions || [])];
    if (!!tableAssertionsConfig.nonNull) {
      const nonNullCols =
        typeof tableAssertionsConfig.nonNull === "string"
          ? [tableAssertionsConfig.nonNull]
          : tableAssertionsConfig.nonNull;
      nonNullCols.forEach((nonNullCol) => mergedRowConditions.push(`${nonNullCol} IS NOT NULL`));
    }
    if (!!mergedRowConditions && mergedRowConditions.length > 0) {
      this.rowConditionsAssertion = this.session
        .assert(
          this.inlineAssertionName(proto.target, "assertions_rowConditions"),
          sqlanvil.ActionConfig.AssertionConfig.create({
            filename: proto.fileName,
            project,
            dataset,
          }),
        )
        .query((ctx) =>
          this.session
            .compilationSql()
            .rowConditionsAssertion(ctx.ref(proto.target), mergedRowConditions),
        );
      this.rowConditionsAssertion.setParentAction(sqlanvil.Target.create(proto.target));
      if (proto.disabled) {
        this.rowConditionsAssertion.disabled();
      }
      if (proto.tags) {
        this.rowConditionsAssertion.tags(proto.tags);
      }
    }
  }

  protected setInlineAssertionsDisabled(disabled: boolean) {
    this.uniqueKeyAssertions.forEach((assertion) => assertion.disabled(disabled));
    this.rowConditionsAssertion?.disabled(disabled);
  }

  protected addInlineAssertionsTags(tags: string | string[]) {
    this.uniqueKeyAssertions.forEach((assertion) => assertion.tags(tags));
    this.rowConditionsAssertion?.tags(tags);
  }

  protected updateInlineAssertionsDatabase(database: string, parentTarget: sqlanvil.ITarget) {
    [...this.uniqueKeyAssertions, this.rowConditionsAssertion]
      .filter(Boolean)
      .forEach((assertion) => {
        if (this.inlineAssertionsFollowActionDatabase()) {
          assertion.database(database);
        }
        assertion.setParentAction(sqlanvil.Target.create(parentTarget));
      });
  }

  protected updateInlineAssertionsSchema(schema: string, parentTarget: sqlanvil.ITarget) {
    this.uniqueKeyAssertions.forEach((assertion, index) => {
      if (this.inlineAssertionsFollowActionSchema()) {
        assertion.schema(schema);
      }
      assertion.setName(this.inlineAssertionName(parentTarget, `assertions_uniqueKey_${index}`));
      assertion.setParentAction(sqlanvil.Target.create(parentTarget));
    });
    if (this.rowConditionsAssertion) {
      if (this.inlineAssertionsFollowActionSchema()) {
        this.rowConditionsAssertion.schema(schema);
      }
      this.rowConditionsAssertion.setName(
        this.inlineAssertionName(parentTarget, "assertions_rowConditions"),
      );
      this.rowConditionsAssertion.setParentAction(sqlanvil.Target.create(parentTarget));
    }
  }

  private inlineAssertionName(parentTarget: sqlanvil.ITarget, suffix: string): string {
    const assertionPrefix = !!this.session.projectConfig.builtinAssertionNamePrefix
      ? `${this.session.projectConfig.builtinAssertionNamePrefix}_`
      : "";
    return `${assertionPrefix}${parentTarget.schema}_${parentTarget.name}_${suffix}`;
  }

  /**
   * Whether inline assertions should be written to the same dataset as their parent action, i.e.
   * neither an action-level nor a project-level assertion dataset has been configured.
   */
  private inlineAssertionsFollowActionSchema(): boolean {
    return !this.inlineAssertionsDataset && !this.session.projectConfig.assertionSchema;
  }

  /**
   * Whether inline assertions should be written to the same project as their parent action, i.e.
   * no action-level assertion project has been configured.
   */
  private inlineAssertionsFollowActionDatabase(): boolean {
    return !this.inlineAssertionsProject;
  }

  private validateTarget(target: sqlanvil.Target, fileName: string) {
    if (target.name.includes(".")) {
      this.session.compileError(
        new Error("Action target names cannot include '.'"),
        fileName,
        target,
      );
    }
    if (target.schema.includes(".")) {
      this.session.compileError(
        new Error("Action target datasets cannot include '.'"),
        fileName,
        target,
      );
    }
    if (target.database.includes(".")) {
      this.session.compileError(
        new Error("Action target projects cannot include '.'"),
        fileName,
        target,
      );
    }
  }
}
