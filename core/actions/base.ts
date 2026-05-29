import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export abstract class ActionBuilder<T> {
  public session: Session;
  public includeAssertionsForDependency: Map<string, boolean> = new Map();

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
    }
  ): sqlanvil.Target {
    const defaultSchema = options?.useDefaultAssertionDataset
      ? projectConfig.assertionSchema || projectConfig.defaultSchema
      : projectConfig.defaultSchema;
    const target = sqlanvil.Target.create({
      name: targetFromConfig.name,
      schema: targetFromConfig.schema || defaultSchema || undefined,
      database: targetFromConfig.database || projectConfig.defaultDatabase || undefined
    });
    if (options?.validateTarget) {
      this.validateTarget(targetFromConfig, fileName);
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
        : undefined
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
    proto: sqlanvil.Table
  ): { uniqueKeyAssertions: any[]; rowConditionsAssertion?: any } {
    const inlineAssertions: {
      uniqueKeyAssertions: any[];
      rowConditionsAssertion?: any;
    } = { uniqueKeyAssertions: [] };
    if (!!tableAssertionsConfig.uniqueKey?.length && !!tableAssertionsConfig.uniqueKeys?.length) {
      this.session.compileError(
        new Error("Specify at most one of 'assertions.uniqueKey' and 'assertions.uniqueKeys'.")
      );
    }
    const assertionPrefix = !!this.session.projectConfig.builtinAssertionNamePrefix ? `${this.session.projectConfig.builtinAssertionNamePrefix}_` : "";
    let uniqueKeys = tableAssertionsConfig.uniqueKeys.map(uniqueKey =>
      sqlanvil.ActionConfig.TableAssertionsConfig.UniqueKey.create(uniqueKey)
    );
    if (!!tableAssertionsConfig.uniqueKey?.length) {
      uniqueKeys = [
        sqlanvil.ActionConfig.TableAssertionsConfig.UniqueKey.create({
          uniqueKey: tableAssertionsConfig.uniqueKey
        })
      ];
    }
    if (uniqueKeys) {
      uniqueKeys.forEach(({ uniqueKey }, index) => {
        const uniqueKeyAssertion = this.session
          .assert(
            `${assertionPrefix}${proto.target.schema}_${proto.target.name}_assertions_uniqueKey_${index}`,
            sqlanvil.ActionConfig.AssertionConfig.create({ filename: proto.fileName })
          )
          .query(ctx =>
            this.session.compilationSql().indexAssertion(ctx.ref(proto.target), uniqueKey)
          );
        if (proto.tags) {
          uniqueKeyAssertion.tags(proto.tags);
        }
        uniqueKeyAssertion.setParentAction(sqlanvil.Target.create(proto.target));
        if (proto.disabled) {
          uniqueKeyAssertion.disabled();
        }
        inlineAssertions.uniqueKeyAssertions.push(uniqueKeyAssertion);
      });
    }
    const mergedRowConditions = tableAssertionsConfig.rowConditions || [];
    if (!!tableAssertionsConfig.nonNull) {
      const nonNullCols =
        typeof tableAssertionsConfig.nonNull === "string"
          ? [tableAssertionsConfig.nonNull]
          : tableAssertionsConfig.nonNull;
      nonNullCols.forEach(nonNullCol => mergedRowConditions.push(`${nonNullCol} IS NOT NULL`));
    }
    if (!!mergedRowConditions && mergedRowConditions.length > 0) {
      inlineAssertions.rowConditionsAssertion = this.session
        .assert(`${assertionPrefix}${proto.target.schema}_${proto.target.name}_assertions_rowConditions`, {
          filename: proto.fileName
        } as sqlanvil.ActionConfig.AssertionConfig)
        .query(ctx =>
          this.session
            .compilationSql()
            .rowConditionsAssertion(ctx.ref(proto.target), mergedRowConditions)
        );
      inlineAssertions.rowConditionsAssertion.setParentAction(sqlanvil.Target.create(proto.target));
      if (proto.disabled) {
        inlineAssertions.rowConditionsAssertion.disabled();
      }
      if (proto.tags) {
        inlineAssertions.rowConditionsAssertion.tags(proto.tags);
      }
    }
    return inlineAssertions;
  }

  private validateTarget(target: sqlanvil.Target, fileName: string) {
    if (target.name.includes(".")) {
      this.session.compileError(
        new Error("Action target names cannot include '.'"),
        fileName,
        target
      );
    }
    if (target.schema.includes(".")) {
      this.session.compileError(
        new Error("Action target datasets cannot include '.'"),
        fileName,
        target
      );
    }
    if (target.database.includes(".")) {
      this.session.compileError(
        new Error("Action target projects cannot include '.'"),
        fileName,
        target
      );
    }
  }
}
