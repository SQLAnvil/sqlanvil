import { install } from "sa/cli/api";
import { projectDirMustExistOption } from "sa/cli/common_options";
import { print, printSuccess } from "sa/cli/console";
import { ICommand } from "sa/cli/yargswrapper";

interface InstallArgv {
  "project-dir": string;
}

export const installCommand: ICommand = {
  format: `install [${projectDirMustExistOption.name}]`,
  description: "Install a project's NPM dependencies.",
  positionalOptions: [projectDirMustExistOption],
  options: [],
  processFn: async (argv: InstallArgv) => {
    print("Installing NPM dependencies...\n");
    await install(argv[projectDirMustExistOption.name]);
    printSuccess("Project dependencies successfully installed.");
    return 0;
  }
};
