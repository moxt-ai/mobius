import type { SessionElicitationField } from "@moxt-ai/mobius-web-sdk";
import { describe, expect, it } from "vitest";

import {
  encodeElicitationForm,
  readMultiselectDefaults,
} from "@/services/elicitation-form";

function field(
  name: string,
  type: SessionElicitationField["type"],
  required = false,
): SessionElicitationField {
  return {
    defaultBooleanValue: false,
    defaultNumberValue: 0,
    defaultStringValue: "",
    description: "",
    format: "",
    hasDefaultValue: false,
    maximum: "",
    maximumLength: "",
    minimum: "",
    minimumLength: "",
    name,
    options: [],
    pattern: "",
    required,
    title: name,
    type,
  };
}

describe("elicitation form encoding", () => {
  it("Given optional empty fields, When the browser accepts an elicitation form, Then omitted values are not converted into invalid empty strings, zeroes, or arrays", () => {
    const form = new FormData();
    form.append("count", "");
    form.append("note", "");

    expect(
      encodeElicitationForm(form, [
        field("count", "number"),
        field("note", "string"),
        field("labels", "multiselect"),
      ]),
    ).toBe("{}");
  });

  it("Given a multiselect default, When the field is rendered, Then every valid default is selected", () => {
    const labels = {
      ...field("labels", "multiselect"),
      defaultStringValue: '["bug","frontend"]',
      hasDefaultValue: true,
      options: [
        { description: "", label: "Bug", value: "bug" },
        { description: "", label: "Frontend", value: "frontend" },
      ],
    } satisfies SessionElicitationField;

    expect(readMultiselectDefaults(labels)).toEqual(["bug", "frontend"]);
  });
});
