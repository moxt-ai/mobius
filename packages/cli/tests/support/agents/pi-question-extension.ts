export const piQuestionExtension = `export default function (pi) {
    pi.registerTool({
        name: "collect_answer", label: "Collect answer", description: "Ask for an answer",
        parameters: { type: "object", properties: { method: { type: "string" } }, required: ["method"] },
        async execute(_id, input, _signal, _update, context) {
            const value = input.method === "select"
                ? await context.ui.select("Choose a color", ["Blue", "Green"])
                : input.method === "confirm"
                ? await context.ui.confirm("Continue?", "Confirm the next step")
                : input.method === "editor"
                ? await context.ui.editor("Review the message", "First draft\\nSecond line")
                : await context.ui.input("Enter an answer", "Your answer");
            return { content: [{ type: "text", text: "PI_ANSWER:" + JSON.stringify({ value }) }], details: {} };
        }
    });
}`;
