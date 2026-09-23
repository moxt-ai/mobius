if (process.env.PROTOCOL_EXISTS !== "true") {
    throw new Error(
        "The SDK requires the current @moxt-ai/mobius-protocol version, but it is not published. Bump the Protocol version in this release or publish it first.",
    );
}
