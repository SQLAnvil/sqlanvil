import { concatenateQueries } from "sa/cli/api/utils/query_transforms";
import { sqlanvil } from "sa/protos/ts";

// concatenateQueries and terminateStatements live in cli/api/utils/query_transforms.ts (where
// upstream #2408 moved concatenateQueries); re-exported for existing callers.
export { concatenateQueries, terminateStatements } from "sa/cli/api/utils/query_transforms";

export class Tasks {
  private tasks: Task[] = [];

  public add(task: Task) {
    this.tasks.push(task);
    return this;
  }

  public addAll(tasks: Tasks) {
    this.tasks = this.tasks.concat(tasks.tasks);
    return this;
  }

  public build() {
    return this.tasks.map((task) => task.build());
  }

  public concatenate() {
    return new Tasks().add(
      Task.statement(concatenateQueries(this.tasks.map((task) => task.getStatement()))),
    );
  }
}

export class Task {
  public static statement(statement: string) {
    return new Task().type("statement").statement(statement);
  }

  public static assertion(statement: string) {
    return new Task().type("assertion").statement(statement);
  }
  private proto: sqlanvil.IExecutionTask = sqlanvil.ExecutionTask.create();

  public type(v: string) {
    this.proto.type = v;
    return this;
  }

  public statement(v: string) {
    this.proto.statement = v;
    return this;
  }

  public getStatement() {
    return this.proto.statement;
  }

  public build() {
    return sqlanvil.ExecutionTask.create(this.proto);
  }
}
