/**
 * @category saltcorn-cli
 * @module commands/delete-user
 */

// todo support for  users without emails (using user.id)
const { Command, Flags, Args } = require("@oclif/core");
const { maybe_as_tenant } = require("../common");
const inquirer = require("inquirer").default;

/**
 * DeleteUserCommand Class
 * @extends oclif.Command
 * @category saltcorn-cli
 */
class DeleteUserCommand extends Command {
  /**
   * @returns {Promise<void>}
   */
  async run() {
    const User = require("@saltcorn/data/models/user");

    const { args } = await this.parse(DeleteUserCommand);
    const { flags } = await this.parse(DeleteUserCommand);

    // run function as specified tenant
    await maybe_as_tenant(flags.tenant, async () => {
      // try to find user
      const u = await User.findOne({ email: args.user_email });
      if (u === null) {
        console.error(`Error: User ${args.user_email} is not found`);
        this.exit(1);
      }
      if (!(u instanceof User)) {
        console.error(`Error: ${u.error}`);
        this.exit(1);
      }

      // make changes
      // todo handle errors
      if (!flags.force) {
        const confirmation = await inquirer.prompt([
          {
            type: "confirm",
            name: "continue",
            message: `This will delete user ${args.user_email} ${
              typeof flags.tenant !== "undefined" ? "from " + flags.tenant : ""
            }.\nContinue?`,
            default: false,
          },
        ]);

        if (!confirmation.continue) {
          console.log(`Success: Command execution canceled`);
          this.exit(1);
        }
      }

      // delete user
      await u.delete();
      console.log(
        `Success: User ${args.user_email} deleted  ${
          typeof flags.tenant !== "undefined" ? "from " + flags.tenant : ""
        }`
      );
    });
    this.exit(0);
  }
}

/**
 * @type {object}
 */
DeleteUserCommand.args = {
  user_email: Args.string({
    required: true,
    description: "User to delete",
  }),
};

/**
 * @type {string}
 */
DeleteUserCommand.description = `Delete user.

Command deletes the user specified by USER_EMAIL.

`;

/**
 * @type {string}
 */
DeleteUserCommand.help = `Delete user.

Command deletes the user specified by USER_EMAIL.

`;

/**
 * @type {object}
 */
DeleteUserCommand.flags = {
  force: Flags.boolean({ char: "f", description: "force command execution" }),
  tenant: Flags.string({
    char: "t",
    description: "tenant",
  }),
};

module.exports = DeleteUserCommand;
