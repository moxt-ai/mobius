import { InvalidArgumentError, Option } from "commander";

function readOnce(optionName: string): (value: string, previous: string | undefined) => string {
    return (value, previous) => {
        if (previous !== undefined) {
            throw new InvalidArgumentError(`${optionName} may only be specified once`);
        }
        return value;
    };
}

export function valueOption(flags: string, description: string, mandatory = false): Option {
    const option = new Option(flags, description).argParser(readOnce(flags.split(" ")[0] ?? flags));
    return mandatory ? option.makeOptionMandatory() : option;
}
